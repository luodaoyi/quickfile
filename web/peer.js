export class PeerLink {
  constructor(id, role, credential, expires, files = null) {
    this.id = id;
    this.role = role;
    this.credential = credential;
    this.files = files;
    this.connections = new Map();
    this.pending = new Map();
    this.serial = 0;
    this.closed = false;
    this.channel = null;
    if (!globalThis.RTCPeerConnection) {
      console.info("WebRTC unavailable. Using stored transfer.");
      return;
    }
    this.expiryTimer = setTimeout(
      () => this.close(),
      Math.max(0, Date.parse(expires) - Date.now()),
    );
    this.open();
  }
  open() {
    const url = new URL(`/api/spaces/${this.id}/ws`, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("role", this.role);
    url.searchParams.set("token", this.credential);
    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) =>
      this.signal(JSON.parse(event.data)).catch((err) =>
        console.warn("P2P signaling:", err),
      );
    this.ws.onclose = () => {
      if (!this.closed) this.reconnect = setTimeout(() => this.open(), 3000);
    };
    this.ws.onerror = () =>
      console.warn(
        "P2P signaling disconnected; stored transfer remains available.",
      );
  }
  send(type, peer, data) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type, peer, data }));
  }
  connection(peer, offer = false) {
    if (this.connections.has(peer)) return this.connections.get(peer);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pc.queuedICE = [];
    this.connections.set(peer, pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send("ice", peer, e.candidate);
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        this.connections.delete(peer);
        pc.close();
      }
    };
    if (offer) this.attach(pc.createDataChannel("file"));
    else pc.ondatachannel = (e) => this.attach(e.channel);
    return pc;
  }
  async signal(msg) {
    if (msg.type === "peer" && this.role === "sender") {
      const old = this.connections.get(msg.peer);
      if (old) {
        old.close();
        this.connections.delete(msg.peer);
      }
      const pc = this.connection(msg.peer, true);
      await pc.setLocalDescription(await pc.createOffer());
      this.send("offer", msg.peer, pc.localDescription);
      return;
    }
    const pc = this.connection(msg.peer);
    if (msg.type === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.data);
      else pc.queuedICE.push(msg.data);
      return;
    }
    if (msg.type === "offer" || msg.type === "answer") {
      await pc.setRemoteDescription(msg.data);
      for (const ice of pc.queuedICE.splice(0)) await pc.addIceCandidate(ice);
      if (msg.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        this.send("answer", msg.peer, pc.localDescription);
      }
    }
  }
  attach(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    if (this.role !== "sender") {
      channel.onopen = () => {
        this.channel = channel;
      };
      channel.onclose = () => {
        if (this.channel === channel) this.channel = null;
        for (const p of this.pending.values())
          p.reject(new Error("P2P connection closed"));
        this.pending.clear();
      };
    }
    channel.onmessage = async (event) => {
      try {
        if (this.role === "sender") {
          await this.provide(channel, JSON.parse(event.data));
          return;
        }
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.reject(new Error(msg.error));
          }
          return;
        }
        const frame = new DataView(event.data);
        const id = frame.getUint32(0),
          offset = frame.getUint32(4);
        const p = this.pending.get(id);
        if (!p) return;
        const data = new Uint8Array(event.data, 8);
        if (offset !== p.received || offset + data.byteLength > p.bytes.length)
          throw new Error("Invalid P2P block");
        p.bytes.set(data, offset);
        p.received += data.byteLength;
        if (p.received === p.bytes.length) {
          this.pending.delete(id);
          p.resolve(p.bytes);
        }
      } catch (err) {
        console.warn("P2P transfer:", err);
        channel.close();
      }
    };
  }
  async provide(channel, msg) {
    const file = this.files?.[msg.file];
    if (
      !file ||
      !Number.isInteger(msg.id) ||
      !Number.isSafeInteger(msg.offset) ||
      !Number.isSafeInteger(msg.length) ||
      msg.offset < 0 ||
      msg.length <= 0 ||
      msg.length > 1024 ** 2 ||
      msg.offset + msg.length > file.size
    ) {
      channel.close();
      return;
    }
    const data = new Uint8Array(
      await file.slice(msg.offset, msg.offset + msg.length).arrayBuffer(),
    );
    for (let offset = 0; offset < data.length; offset += 16384) {
      if (channel.readyState !== "open") return;
      if (channel.bufferedAmount > 1024 ** 2)
        await new Promise((resolve, reject) => {
          const ready = () => {
            cleanup();
            resolve();
          };
          const closed = () => {
            cleanup();
            reject(new Error("P2P closed"));
          };
          const cleanup = () => {
            channel.removeEventListener("bufferedamountlow", ready);
            channel.removeEventListener("close", closed);
          };
          channel.addEventListener("bufferedamountlow", ready, { once: true });
          channel.addEventListener("close", closed, { once: true });
        });
      const part = data.subarray(offset, offset + 16384),
        frame = new ArrayBuffer(part.length + 8);
      const view = new DataView(frame);
      view.setUint32(0, msg.id);
      view.setUint32(4, offset);
      new Uint8Array(frame, 8).set(part);
      channel.send(frame);
    }
  }
  block(file, offset, length, signal) {
    if (this.channel?.readyState !== "open") return null;
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        reject(new Error("P2P block timed out"));
        this.channel?.close();
      }, 90000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        bytes: new Uint8Array(length),
        received: 0,
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      this.channel.send(JSON.stringify({ id, file, offset, length }));
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.reconnect);
    this.ws?.close();
    for (const pc of this.connections.values()) pc.close();
  }
}

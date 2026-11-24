import { WebTorrent, SimplePeer, HTTPSeed } from "./webtorrent.js";

const pieceLength = 4 * 1024 ** 2;

// Advertise only committed pieces, so missing HTTP ranges cannot reserve pieces away from P2P.
class AvailableWebSeed extends HTTPSeed {
  constructor(url, torrent, file) {
    super(url, torrent);
    this.file = file;
    this.advertised = new Set();
    this.handshaken = false;
  }
  available(index) {
    const start = index * pieceLength,
      end = Math.min(this.file.size, start + pieceLength);
    return (
      end <= this.file.uploaded ||
      (this.file.ranges || []).some((r) => start >= r.start && end <= r.end)
    );
  }
  bitfield(bits) {
    for (let index = 0; index < this._torrent.pieces.length; index++) {
      const available = this.available(index);
      bits.set(index, available);
      if (available) this.advertised.add(index);
    }
    this.handshaken = true;
    return super.bitfield(bits);
  }
  have(index) {
    if (this.available(index)) return super.have(index);
  }
  update(file) {
    this.file = file;
    if (!this.handshaken) return;
    for (let index = 0; index < this._torrent.pieces.length; index++) {
      if (!this.advertised.has(index) && this.available(index)) {
        this.advertised.add(index);
        super.have(index);
      }
    }
  }
}

class SourceStore {
  constructor(file) {
    this.file = file;
  }
  get(index, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const start = index * pieceLength + (options?.offset || 0);
    const end = Math.min(
      this.file.size,
      start + (options?.length || pieceLength),
    );
    this.file
      .slice(start, end)
      .arrayBuffer()
      .then((bytes) => callback(null, new Uint8Array(bytes)), callback);
  }
  put(_index, _bytes, callback) {
    callback(new Error("The original file store is read-only"));
  }
  close(callback) {
    callback?.();
  }
  destroy(callback) {
    this.close(callback);
  }
}

class PieceStore {
  constructor(_size, options) {
    this.name = "quickfile-pieces-" + crypto.randomUUID();
    this.length = options.length;
    this.ready = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("pieces");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  get(index, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    this.ready.then((db) => {
      const request = db.transaction("pieces").objectStore("pieces").get(index);
      request.onerror = () => callback(request.error);
      request.onsuccess = async () => {
        try {
          const blob = request.result;
          if (!blob) throw new Error("Piece not downloaded");
          const start = options?.offset || 0;
          callback(
            null,
            new Uint8Array(
              await blob
                .slice(
                  start,
                  options?.length ? start + options.length : blob.size,
                )
                .arrayBuffer(),
            ),
          );
        } catch (err) {
          callback(err);
        }
      };
    }, callback);
  }
  put(index, bytes, callback) {
    this.ready.then((db) => {
      const transaction = db.transaction("pieces", "readwrite");
      transaction.objectStore("pieces").put(new Blob([bytes]), index);
      transaction.oncomplete = () => callback(null);
      transaction.onerror = () => callback(transaction.error);
      transaction.onabort = () =>
        callback(transaction.error || new Error("Piece store write aborted"));
    }, callback);
  }
  close(callback) {
    this.ready.then((db) => {
      db.close();
      callback?.();
    }, callback);
  }
  destroy(callback) {
    this.close((err) => {
      if (err) {
        callback?.(err);
        return;
      }
      const request = indexedDB.deleteDatabase(this.name);
      request.onsuccess = () => callback?.();
      request.onerror = () => callback?.(request.error);
    });
  }
}

async function manifest(id, index, credential, signal) {
  while (!signal.aborted) {
    const response = await fetch(`/api/spaces/${id}/files/${index}/torrent`, {
      headers: { Authorization: "Bearer " + credential },
      signal,
      cache: "no-store",
    });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (response.status !== 409)
      throw new Error(
        `Torrent metadata: HTTP ${response.status} ${await response.text()}`,
      );
    await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 1000);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  throw signal.reason;
}

export class TorrentTransfer {
  constructor(
    id,
    role,
    credential,
    expires,
    files = null,
    onStatus = () => {},
    onError = console.error,
  ) {
    this.id = id;
    this.role = role;
    this.credential = credential;
    this.files = files;
    this.onStatus = onStatus;
    this.onError = onError;
    this.torrents = new Map();
    this.webSeeds = new Map();
    this.connections = new Map();
    this.receivers = new Set();
    this.offers = new Map();
    this.abort = new AbortController();
    this.client = new WebTorrent({ tracker: false, dht: false, lsd: false });
    this.client.on("error", onError);
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
    this.ws.onmessage = (event) => {
      try {
        this.signal(JSON.parse(event.data));
      } catch (err) {
        this.onError(err);
      }
    };
    this.ws.onclose = () => {
      for (const connection of this.connections.values()) connection.destroy();
      this.connections.clear();
      this.receivers.clear();
      if (!this.abort.signal.aborted)
        this.reconnect = setTimeout(() => this.open(), 3000);
    };
    this.ws.onerror = () =>
      this.onError(
        new Error(
          "WebTorrent signaling disconnected; HTTP web seed remains active.",
        ),
      );
  }
  send(peer, index, signal) {
    if (this.ws.readyState !== WebSocket.OPEN)
      throw new Error("WebTorrent signaling is not connected");
    this.ws.send(
      JSON.stringify({
        type:
          signal.type === "offer"
            ? "offer"
            : signal.type === "answer"
              ? "answer"
              : "ice",
        peer,
        data: { fileIndex: index, signal },
      }),
    );
  }
  connect(index, peerID, initiator) {
    const key = index + ":" + peerID;
    if (this.connections.has(key)) return this.connections.get(key);
    const torrent = this.torrents.get(index);
    if (!torrent) return null;
    const connection = new SimplePeer({
      initiator,
      config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    });
    this.connections.set(key, connection);
    connection.on("signal", (signal) => {
      try {
        this.send(peerID, index, signal);
      } catch (err) {
        this.onError(err);
        connection.destroy();
      }
    });
    connection.on("error", (err) => this.onError(err));
    connection.on("close", () => {
      if (this.connections.get(key) === connection)
        this.connections.delete(key);
    });
    torrent.addPeer(connection);
    return connection;
  }
  signal(message) {
    if (message.type === "peer" && this.role === "sender") {
      this.receivers.add(message.peer);
      for (const index of this.torrents.keys())
        this.connect(index, message.peer, true);
      return;
    }
    const index = message.data?.fileIndex;
    if (!Number.isInteger(index) || index < 0 || !message.data?.signal)
      throw new Error("Invalid torrent signal");
    if (!this.torrents.get(index)?.ready) {
      if (this.role === "receiver") {
        const queued = this.offers.get(index) || [];
        queued.push(message);
        this.offers.set(index, queued);
      }
      return;
    }
    this.connect(index, message.peer, false).signal(message.data.signal);
  }
  add(index, descriptor, sourceFile) {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
    return new Promise((resolve, reject) => {
      const torrent = this.client.add(
        descriptor,
        {
          announce: [],
          private: true,
          store: PieceStore,
          storeCacheSlots: 0,
          destroyStoreOnDestroy: !sourceFile,
          ...(sourceFile
            ? { preloadedStore: new SourceStore(sourceFile), skipVerify: true }
            : {
                bitfield: new Uint8Array(
                  Math.ceil(Math.ceil(this.fileSize(index) / pieceLength) / 8),
                ),
                startAsDeselected: true,
              }),
        },
        (ready) => resolve(ready),
      );
      torrent.on("error", reject);
      torrent.on("warning", (err) => this.onError(err));
      torrent.on("wire", (wire) => {
        wire.on("download", () =>
          this.onStatus(wire.type === "webSeed" ? "server" : "peer"),
        );
      });
      this.torrents.set(index, torrent);
      torrent.once("ready", () => {
        if (sourceFile) {
          for (const peer of this.receivers) this.connect(index, peer, true);
        } else {
          for (const message of this.offers.get(index) || [])
            this.signal(message);
          this.offers.delete(index);
        }
      });
    });
  }
  updateMetadata(metadata) {
    this.metadata = metadata;
    for (const [index, seed] of this.webSeeds)
      seed.update(metadata.files[index]);
  }
  fileSize(index) {
    return this.metadata.files[index].size;
  }
  async prepare() {
    for (let index = 0; index < this.files.length; index++) {
      const file = this.files[index];
      if (!file.size) continue;
      const hashes = [];
      for (let offset = 0; offset < file.size; offset += pieceLength) {
        if (this.abort.signal.aborted) throw this.abort.signal.reason;
        const bytes = await file
          .slice(offset, offset + pieceLength)
          .arrayBuffer();
        hashes.push(
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)),
            (v) => v.toString(16).padStart(2, "0"),
          ).join(""),
        );
      }
      const response = await fetch(
        `/api/spaces/${this.id}/files/${index}/torrent`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.credential,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ hashes }),
          signal: this.abort.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          `Publish torrent: HTTP ${response.status} ${await response.text()}`,
        );
      const descriptor = await manifest(
        this.id,
        index,
        this.credential,
        this.abort.signal,
      );
      await this.add(index, descriptor, file);
    }
  }
  async file(index) {
    if (this.torrents.has(index)) return this.torrents.get(index).files[0];
    const descriptor = await manifest(
      this.id,
      index,
      this.credential,
      this.abort.signal,
    );
    const torrent = await this.add(index, descriptor);
    // The authenticated HTTP origin is a WebTorrent web seed, not a separate downloader.
    const seed = new AvailableWebSeed(
      new URL(
        `/api/spaces/${this.id}/files/${index}?claim=${encodeURIComponent(this.credential)}`,
        location.origin,
      ).href,
      torrent,
      this.metadata.files[index],
    );
    this.webSeeds.set(index, seed);
    torrent.addWebSeed(seed);
    return torrent.files[0];
  }
  close() {
    if (this.abort.signal.aborted) return;
    this.abort.abort(new DOMException("Transfer closed", "AbortError"));
    clearTimeout(this.expiryTimer);
    clearTimeout(this.reconnect);
    this.ws.close();
    for (const connection of this.connections.values()) connection.destroy();
    this.connections.clear();
    this.client.destroy((err) => {
      if (err) this.onError(err);
    });
  }
}

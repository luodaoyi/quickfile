const streams = new Map();

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type !== "quickfile-download") return;
  const port = event.ports[0],
    job = streams.get(event.data.path);
  if (!job) {
    port.postMessage({ type: "missing" });
    return;
  }
  streams.delete(event.data.path);
  const reader = job.stream.getReader();
  const abort = () => {
    reader.cancel(job.signal.reason).catch(job.reject);
    port.postMessage({ type: "error", error: String(job.signal.reason) });
    job.reject(job.signal.reason);
  };
  const cleanup = () => {
    job.signal.removeEventListener("abort", abort);
    port.close();
  };
  job.signal.addEventListener("abort", abort, { once: true });
  port.onmessage = async ({ data }) => {
    try {
      if (data.type === "cancel") {
        await reader.cancel();
        throw new DOMException("Download cancelled", "AbortError");
      }
      if (data.type !== "pull") return;
      const next = await reader.read();
      if (next.done) {
        port.postMessage({ type: "end" });
        job.resolve();
        cleanup();
      } else {
        port.postMessage({ type: "bytes", bytes: next.value });
      }
    } catch (err) {
      port.postMessage({ type: "error", error: err.message });
      job.reject(err);
      cleanup();
    }
  };
  port.postMessage({
    type: "headers",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        "attachment; filename*=UTF-8''" + encodeURIComponent(job.name),
      "Cache-Control": "no-store",
    },
  });
});

export async function saveStream(stream, name, writer, signal, token) {
  if (writer) {
    const reader = stream.getReader();
    const abort = () =>
      reader
        .cancel(signal.reason)
        .catch((err) => console.error("Cancel stream:", err));
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const next = await reader.read();
        if (next.done) break;
        await writer.write(next.value);
      }
      if (signal.aborted) throw signal.reason;
      await writer.close();
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    return;
  }
  if (!navigator.serviceWorker)
    throw new Error(
      "This browser cannot stream a file download; use a browser with service worker support.",
    );
  await navigator.serviceWorker.register("/download-worker.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const path = "/downloads/" + token;
  const completed = new Promise((resolve, reject) =>
    streams.set(path, { stream, name, signal, resolve, reject }),
  );
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = path;
  document.body.append(frame);
  try {
    await completed;
  } finally {
    streams.delete(path);
    frame.remove();
  }
}

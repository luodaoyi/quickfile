// This worker only carries streams produced by the page's WebTorrent scheduler.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !/^\/downloads\/[a-f0-9]{48}$/.test(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const { data, port } = await new Promise((resolve) => {
        for (const client of windows) {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => {
            if (data.type === "headers") resolve({ data, port: channel.port1 });
            else channel.port1.close();
          };
          client.postMessage(
            { type: "quickfile-download", path: url.pathname },
            [channel.port2],
          );
        }
      });
      return new Response(
        new ReadableStream({
          pull(controller) {
            return new Promise((resolve) => {
              port.onmessage = ({ data }) => {
                if (data.type === "bytes") controller.enqueue(data.bytes);
                else if (data.type === "end") {
                  controller.close();
                  port.close();
                } else {
                  controller.error(new Error(data.error));
                  port.close();
                }
                resolve();
              };
              port.postMessage({ type: "pull" });
            });
          },
          cancel() {
            port.postMessage({ type: "cancel" });
            port.close();
          },
        }),
        { headers: data.headers },
      );
    })(),
  );
});

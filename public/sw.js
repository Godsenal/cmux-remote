// Deliberately caches nothing: every screen is live data, and a stale shell would be
// worse than an offline error. It exists to receive push, which iOS only delivers to
// an installed PWA with a registered service worker.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "cmux", body: event.data ? event.data.text() : "" };
  }

  // iOS subscribes with userVisibleOnly, so every push must show something.
  event.waitUntil(
    self.registration.showNotification(d.title || "cmux", {
      body: d.body || "",
      tag: d.tag || "cmux",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { workspace: d.workspace || "" },
      renotify: !!d.tag,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const ws = event.notification.data?.workspace;
  const url = ws ? `/?ws=${encodeURIComponent(ws)}` : "/";

  // Reuse an open window when there is one; the phone usually has it backgrounded.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if (ws) c.postMessage({ type: "open-workspace", workspace: ws });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

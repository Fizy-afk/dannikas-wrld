/* ============================================================================
   • ๔คภภเкคร ฬгl๔ • — background worker for chat push notifications
   Shows a notification when a chat message arrives, even with the site closed.
   It doesn't cache anything or touch how the site loads.
   ============================================================================ */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    // if the chat is open on screen right now, the page already shows it
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const watching = wins.some((w) => w.visibilityState === "visible" && w.focused);
    if (watching) {
      wins.forEach((w) => w.postMessage({ type: "chat-push" }));
      return;
    }
    await self.registration.showNotification(data.title || "New message", {
      body: data.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "wrld-chat",
      renotify: true,
      data: { url: "./?chat=1" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: "open-chat" });
      return;
    }
    await self.clients.openWindow(new URL(event.notification.data && event.notification.data.url || "./?chat=1", self.registration.scope).href);
  })());
});

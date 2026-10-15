self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener("notificationclick", (event) => {
  const chatId = event.notification?.data?.chatId;
  event.notification.close();
  if (typeof chatId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (!client.url.startsWith(self.registration.scope)) continue;
      await client.focus();
      client.postMessage({ type: "open-chat", chatId });
      return;
    }
    const chatUrl = new URL(`/?chat=${encodeURIComponent(chatId)}`, self.registration.scope);
    await self.clients.openWindow(chatUrl.href);
  })());
});

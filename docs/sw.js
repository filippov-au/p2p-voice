// Service worker: Web Push notifications. Scope: /p2p-voice/
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

const roomOf = u => { try { return new URL(u).hash.slice(1); } catch { return ""; } };

self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const url = d.url || self.registration.scope, roomId = d.roomId || roomOf(url);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some(c => c.focused && c.visibilityState === "visible" && roomOf(c.url) === roomId)) return; // already looking at the room
    await self.registration.showNotification(d.title || "P2P Voice", {
      body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: "room-" + roomId, renotify: true, data: { url, roomId } });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { url, roomId } = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = wins.find(w => roomOf(w.url) === roomId) ;
    if (c) return c.focus();
    return self.clients.openWindow(url || self.registration.scope);
  })());
});

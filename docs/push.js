// Web Push subscription: "notify me when someone joins".
const API = "https://p2p-voice-signal.tmn-sun.workers.dev/api/push/";
export function clientId() {
  let id = localStorage.clientId;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || "")) { id = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, "0")).join(""); localStorage.clientId = id; }
  return id;
}
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export function registerSW() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(e => { console.warn("SW:", e.message); return null; });
}
const keyBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
// Must be called from a user gesture.
export async function subscribePush(roomId) {
  if (!pushSupported()) throw new Error("Push не поддерживается (на iOS: добавьте сайт на экран «Домой»)");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Уведомления запрещены");
  const reg = (await registerSW()) && await navigator.serviceWorker.ready;
  if (!reg) throw new Error("Service worker не зарегистрирован");
  const { publicKey } = await (await fetch(API + "vapid-public-key")).json();
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))) !== btoa(String.fromCharCode(...keyBytes(publicKey)))) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const r = await fetch(API + "subscribe", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), roomId, clientId: clientId() }) });
  if (!r.ok) throw new Error("subscribe: HTTP " + r.status);
  localStorage["push:" + roomId] = "1";
  return r.json();
}
export async function unsubscribePush(roomId) {
  delete localStorage["push:" + roomId];
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await fetch(API + "unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, endpoint: sub.endpoint }) });
}

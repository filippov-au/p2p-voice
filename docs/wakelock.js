// Screen Wake Lock: keeps the screen on while a call is active.
let sentinel = null, active = false;
const supported = () => "wakeLock" in navigator;
async function acquire() {
  if (!supported() || !active || sentinel || document.visibilityState !== "visible") return;
  try { sentinel = await navigator.wakeLock.request("screen"); sentinel.addEventListener("release", () => { sentinel = null; }); }
  catch (e) { console.warn("wakeLock:", e.name, e.message); }
}
export async function enableWakeLock() { active = true; await acquire(); }
export async function disableWakeLock() {
  active = false; const s = sentinel; sentinel = null;
  try { await s?.release(); } catch (e) { console.warn("wakeLock release:", e.message); }
}
export const wakeLockHeld = () => !!sentinel;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && active) acquire(); });

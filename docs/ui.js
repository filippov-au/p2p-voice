// UI-only helpers (no WebRTC logic). Loaded after app.js; replaces the plain copy handler.
const $ = id => document.getElementById(id);
function fallbackCopy(text) {
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
}
let t;
$("copy").onclick = async () => {
  const text = $("link").value || location.href, b = $("copy"); let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch {}
  if (!ok) ok = fallbackCopy(text);
  b.textContent = ok ? "Copied!" : "Copy failed"; b.classList.toggle("copied", ok);
  clearTimeout(t); t = setTimeout(() => { b.textContent = "Copy invite link"; b.classList.remove("copied"); }, 1500);
};
$("link").addEventListener("focus", e => e.target.select());
// Reflect mute state for styling (app.js toggles the label text).
const m = $("mute");
new MutationObserver(() => m.classList.toggle("muted", m.textContent.trim() === "Unmute")).observe(m, { childList: true, characterData: true, subtree: true });
// Show SIGNAL graph only while a peer is connected (status text set by app.js).
const st = $("status");
// Link LED: green when a peer is up, amber while connecting/waiting, red on lost/full.
const sync = () => {
  const t = st.textContent.trim(), on = t === "connected", bad = /lost|full|fail|error/i.test(t), b = document.body.classList;
  b.toggle("peer-on", on); b.toggle("link-on", on); b.toggle("link-bad", !on && bad);
  b.toggle("link-wait", !on && !bad && !$("room").hidden);
};
new MutationObserver(sync).observe(st, { childList: true, characterData: true, subtree: true });
new MutationObserver(sync).observe($("room"), { attributes: true, attributeFilter: ["hidden"] }); sync();

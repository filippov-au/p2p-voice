// Connect/disconnect tones synthesised with Web Audio (no audio files).
let ctx = null, sinkId = null;
function getCtx() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); if (sinkId != null) applySink(); }
  return ctx;
}
export function unlockAudio() { const c = getCtx(); if (c && c.state === "suspended") c.resume().catch(() => {}); }
function twoTone(f1, f2, dur = 0.35, vol = 0.18) {
  const c = getCtx(); if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t = c.currentTime + 0.01, half = dur / 2;
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(f1, t); osc.frequency.setValueAtTime(f2, t + half);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.setValueAtTime(vol, t + half); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination); osc.start(t); osc.stop(t + dur + 0.02);
}
export const playConnectSound = () => twoTone(440, 587.33);
export const playDisconnectSound = () => twoTone(440, 329.63);
function applySink() { if (ctx?.setSinkId) ctx.setSinkId(sinkId === "default" ? "" : sinkId).catch(e => console.warn("tones sink:", e.message)); }
export function setTonesSink(id) { sinkId = id; applySink(); }

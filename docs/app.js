import { enableWakeLock, disableWakeLock } from "./wakelock.js?v=7";
import { unlockAudio, playConnectSound, playDisconnectSound, setTonesSink } from "./tones.js?v=7";
import { clientId, registerSW, subscribePush, pushSupported } from "./push.js?v=7";
const SIGNAL = "wss://p2p-voice-signal.tmn-sun.workers.dev/room/";
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
const $ = id => document.getElementById(id);
let peerUp = false; // true between connect tone and disconnect tone (dedupe)
let ws, pc, dc, localStream, nick, muted = false, statsTimer, prevLoss = null;

function log(text, cls = "") { const d = document.createElement("div"); d.className = cls; d.textContent = text; $("log").append(d); $("log").scrollTop = 1e9; }
// Chat line with safe auto-linking: text nodes + <a>, never innerHTML.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
function linkify(text) {
  const frag = document.createDocumentFragment(); let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let raw = m[0].replace(/[.,;:!?)\]}]+$/, ""); // trailing punctuation stays text
    const href = /^www\./i.test(raw) ? "https://" + raw : raw;
    let u; try { u = new URL(href); } catch {}
    if (!u || !/^https?:$/.test(u.protocol)) continue;
    frag.append(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a"); a.href = u.href; a.textContent = raw; a.target = "_blank"; a.rel = "noopener noreferrer";
    frag.append(a); last = m.index + raw.length;
  }
  frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
function chatLine(who, text) {
  const d = document.createElement("div"); const b = document.createElement("b"); b.textContent = String(who) + ": ";
  d.append(b, linkify(String(text))); $("log").append(d); $("log").scrollTop = 1e9;
}
function status(s) { $("status").textContent = s; }
function randomId() { const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); }

function audioConstraints(deviceId) {
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    channelCount: 1, sampleRate: 48000, latency: 0 };
}
async function getMic(deviceId) {
  const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId), video: false });
  s.getAudioTracks().forEach(t => { t.enabled = !muted; t.contentHint = "speech"; });
  return s;
}

// Opus: mono, 48k, ~48kbps, 20ms frames (maxptime 40), in-band FEC on, DTX off — tuned for stability
function mungeOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i); if (!m) return sdp;
  const pt = m[1], params = "minptime=20;ptime=20;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate=48000;maxplaybackrate=48000";
  const re = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
  sdp = re.test(sdp) ? sdp.replace(re, `a=fmtp:${pt} ${params}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`);
  sdp = sdp.replace(/a=(max)?ptime:\d+\r\n/g, "");
  return sdp.replace(/(m=audio[^\r\n]*\r\n)/, "$1a=ptime:20\r\na=maxptime:40\r\n");
}

function setupDC(ch) {
  dc = ch;
  dc.onopen = () => { $("msg").disabled = $("send").disabled = false; log("chat connected", "sys"); dc.send(JSON.stringify({ t: "nick", nick })); };
  dc.onclose = () => { $("msg").disabled = $("send").disabled = true; };
  dc.onmessage = e => { const m = JSON.parse(e.data);
    if (m.t === "nick") { $("peer").textContent = m.nick; log(`${m.nick} joined`, "sys"); }
    if (m.t === "msg") chatLine(m.nick, m.text); };
}

// Receiver jitter buffer ~80 ms: trades a little latency for fewer dropouts.
const JITTER_MS = 80;
function setBuffer(r) {
  try { if ("jitterBufferTarget" in r) r.jitterBufferTarget = JITTER_MS; else if ("playoutDelayHint" in r) r.playoutDelayHint = JITTER_MS / 1000; }
  catch (e) { console.warn("jitter buffer:", e.message); }
}
async function setPriority() {
  for (const s of pc?.getSenders() || []) {
    if (s.track?.kind !== "audio") continue;
    try { const p = s.getParameters(); if (!p.encodings?.length) continue;
      p.encodings.forEach(e => { e.priority = "high"; e.networkPriority = "high"; e.maxBitrate = 64000; });
      await s.setParameters(p); } catch (e) { console.warn("priority:", e.message); }
  }
}
// Auto ICE restart: only the original caller (offerer) restarts, so there is no glare.
let isCaller = false, restartTimer = null, restarts = 0;
function scheduleRestart(st) {
  clearTimeout(restartTimer); restartTimer = null;
  if (st === "connected") { restarts = 0; return; }
  if (!isCaller || !pc || !(st === "disconnected" || st === "failed")) return;
  restartTimer = setTimeout(() => { if (pc && pc.connectionState !== "connected") iceRestart(); }, st === "failed" ? 0 : 4000);
}
async function iceRestart() {
  if (!pc || ws?.readyState !== 1 || restarts >= 5) return;
  restarts++; log(`reconnecting (ICE restart ${restarts})…`, "sys");
  try { const o = await pc.createOffer({ iceRestart: true }); o.sdp = mungeOpus(o.sdp);
    await pc.setLocalDescription(o); send({ type: "offer", sdp: o.sdp, restart: true }); }
  catch (e) { console.warn("ice restart:", e.message); }
  if (pc.connectionState !== "connected") restartTimer = setTimeout(() => pc && pc.connectionState !== "connected" && iceRestart(), 8000);
}
window.__iceRestart = () => { isCaller = true; return iceRestart(); };
function newPC() {
  closePC();
  pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => e.candidate && send({ type: "ice", candidate: e.candidate });
  pc.ontrack = e => { const a = $("remote"); a.srcObject = e.streams[0];
    setBuffer(e.receiver); a.play().catch(() => {}); };
  const me = pc;
  pc.onconnectionstatechange = () => { if (me !== pc) return; const st = pc.connectionState; status(st); window.__state = st; onConnState(st); scheduleRestart(st); if (st === "connected") setPriority(); };
  pc.ondatachannel = e => setupDC(e.channel);
  window.__pc = pc;
  return pc;
}
function onConnState(st) {
  if (st === "connected") { enableWakeLock(); if (!peerUp) { peerUp = true; playConnectSound(); } }
  else if (st === "disconnected" || st === "failed" || st === "closed") peerGone();
}
function peerGone() { disableWakeLock(); if (peerUp) { peerUp = false; playDisconnectSound(); } }
function closePC() { clearTimeout(restartTimer); restartTimer = null; if (pc) peerGone(); try { dc?.close(); pc?.close(); } catch {} pc = dc = null; $("peer").textContent = "—"; }
function send(o) { ws?.readyState === 1 && ws.send(JSON.stringify(o)); }

async function call() {
  isCaller = true; newPC(); setupDC(pc.createDataChannel("chat", { ordered: true }));
  const o = await pc.createOffer(); o.sdp = mungeOpus(o.sdp);
  await pc.setLocalDescription(o); send({ type: "offer", sdp: o.sdp });
}

async function onSignal(m) {
  if (m.type === "welcome") { status(m.peers.length ? "calling…" : "waiting for peer…"); if (m.peers.length) await call(); }
  else if (m.type === "peer-joined") { status("peer joining…"); }
  else if (m.type === "peer-left") { log("peer left", "sys"); peerGone(); closePC(); status("waiting for peer…"); }
  else if (m.type === "offer") { if (!(m.restart && pc)) { isCaller = false; newPC(); } await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    const a = await pc.createAnswer(); a.sdp = mungeOpus(a.sdp); await pc.setLocalDescription(a); send({ type: "answer", sdp: a.sdp }); }
  else if (m.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
  else if (m.type === "ice" && pc) try { await pc.addIceCandidate(m.candidate); } catch (e) { console.warn(e); }
}

let prevStats = null; const hist = [];
const SERIES = [["loss", "#ff6b6b", "%"], ["conc", "#ffd166", "%"], ["rtt", "#6cb6ff", "ms"], ["jitter", "#06d6a0", "ms"]];
function drawChart() {
  const cv = $("chart"); if (!cv) return; const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const pctMax = Math.max(5, ...hist.map(h => Math.max(h.loss, h.conc))) * 1.1;
  const msMax = Math.max(50, ...hist.map(h => Math.max(h.rtt ?? 0, h.jitter ?? 0))) * 1.1;
  g.strokeStyle = "#2a2e37"; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, H * i / 4); g.lineTo(W, H * i / 4); g.stroke(); }
  const x = i => W - (hist.length - 1 - i) * (W / 59);
  for (const [k, col, unit] of SERIES) {
    const max = unit === "%" ? pctMax : msMax; g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); let started = false;
    hist.forEach((h, i) => { if (h[k] == null) return; const y = H - 2 - (h[k] / max) * (H - 4); started ? g.lineTo(x(i), y) : g.moveTo(x(i), y); started = true; });
    g.stroke();
  }
  g.font = "11px monospace"; g.fillStyle = "#888";
  g.fillText(`% max ${pctMax.toFixed(1)} · ms max ${msMax.toFixed(0)} · 60 s`, 4, 12);
  let lx = 4; for (const [k, col, unit] of SERIES) { const v = hist.at(-1)?.[k]; const t = `${k} ${v == null ? "—" : v.toFixed(1)}${unit}`;
    g.fillStyle = col; g.fillText(t, lx, H - 4); lx += g.measureText(t).width + 12; }
}
window.__hist = hist;
async function stats() {
  if (!pc) return; const r = await pc.getStats(); const out = {};
  let codecs = {};
  r.forEach(s => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) out.rtt = s.currentRoundTripTime * 1000;
    if (s.type === "inbound-rtp" && s.kind === "audio") { out.lost = s.packetsLost; out.recv = s.packetsReceived; out.jitter = s.jitter * 1000; out.codecId = s.codecId;
      out.conc = s.concealedSamples; out.tot = s.totalSamplesReceived; }
    if (s.type === "codec") codecs[s.id] = s;
  });
  $("rtt").textContent = out.rtt != null ? out.rtt.toFixed(1) : "—";
  $("jitter").textContent = out.jitter != null ? out.jitter.toFixed(1) : "—";
  if (out.recv != null) { const tot = out.lost + out.recv; $("loss").textContent = `${out.lost} (${tot ? (100 * out.lost / tot).toFixed(2) : 0}%)`; }
  const c = codecs[out.codecId]; if (c) $("codec").textContent = `${c.mimeType.split("/")[1]} ${c.sdpFmtpLine || ""}`;
  // per-second deltas for the chart
  const pv = prevStats || {}; prevStats = out;
  const dl = out.lost - (pv.lost ?? out.lost), dr = out.recv - (pv.recv ?? out.recv);
  const dc_ = out.conc - (pv.conc ?? out.conc), dt = out.tot - (pv.tot ?? out.tot);
  const lossPct = dl + dr > 0 ? Math.max(0, 100 * dl / (dl + dr)) : 0, concPct = dt > 0 ? Math.max(0, 100 * dc_ / dt) : 0;
  if (out.tot) $("conc").textContent = `${concPct.toFixed(1)}% now · ${(100 * out.conc / out.tot).toFixed(2)}% total`;
  hist.push({ loss: lossPct, conc: concPct, rtt: out.rtt ?? null, jitter: out.jitter ?? null }); if (hist.length > 60) hist.shift();
  drawChart();
  window.__stats = out;
}

// Signaling keepalive: ping every 5 s; reconnect if no pong for > 10 s or the socket drops.
let lastPong = 0, roomId = null, reconnectTimer = null, wsFails = 0;
function connectWS() {
  clearTimeout(reconnectTimer);
  const sock = ws = new WebSocket(SIGNAL + roomId + "?cid=" + clientId());
  sock.onmessage = e => { if (sock !== ws) return; const m = JSON.parse(e.data); if (m.type === "pong") { lastPong = Date.now(); return; } wsFails = 0; onSignal(m); };
  sock.onopen = () => { lastPong = Date.now(); if (!pc) status("signaling connected"); };
  sock.onclose = e => { if (sock !== ws) return;
    if (e.code === 1006 && !pc && ++wsFails >= 3) { status("room full or signaling down"); return; }
    if (!pc || pc.connectionState !== "connected") status("signaling lost, reconnecting…");
    reconnectTimer = setTimeout(connectWS, 1500); };
}
function keepalive() {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastPong > 10000) { const old = ws; ws = null; try { old.close(); } catch {} connectWS(); return; }
  ws.send('{"type":"ping"}');
}
async function join(room) {
  window.__room = room;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (ios && !standalone) $("notifyinfo").hidden = false;
  if (typeof Notification !== "undefined" && pushSupported()) {
    if (Notification.permission === "granted") autoPush(room);
    else if (Notification.permission === "default") // joined via link: ask on the first gesture in the room
      document.addEventListener("pointerdown", () => askPush(room), { once: true, capture: true });
  }
  $("lobby").hidden = true; $("room").hidden = false; $("link").value = location.href;
  nick = localStorage.nick || prompt("Nickname?", "player") || "player"; localStorage.nick = nick;
  const saved = localStorage.micId || "";
  try { localStream = await getMic(saved); }
  catch (e) {
    if (saved) { delete localStorage.micId; try { localStream = await getMic(); } catch (e2) { log("Mic error: " + e2.message, "sys"); return; } }
    else { log("Mic error: " + e.message, "sys"); return; }
  }
  await fillMics();
  navigator.mediaDevices.addEventListener?.("devicechange", () => fillMics().catch(() => {}));
  roomId = room; connectWS(); setInterval(keepalive, 5000);
  statsTimer = setInterval(stats, 1000);
}

["pointerdown", "keydown", "touchend"].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true }));
window.addEventListener("pagehide", () => disableWakeLock());
registerSW();
$("create").onclick = () => {
  const id = randomId();
  try { unlockAudio(); } catch {}
  try { askPush(id); } catch (e) { console.warn("push:", e); } // background, never awaited
  history.pushState(null, "", "#" + id); route();               // navigate immediately, no reload
};
$("copy").onclick = () => navigator.clipboard.writeText(location.href);
// Microphone selector
const curMicId = () => localStream?.getAudioTracks()[0]?.getSettings?.().deviceId || "";
async function fillMics() {
  const sel = $("mic"); let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch {}
  const cur = curMicId();
  sel.replaceChildren(...devs.map((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || `Microphone ${i + 1}`; return o; }));
  if (devs.some(d => d.deviceId === cur)) sel.value = cur;
  sel.hidden = !devs.length;
  await fillOutputs(devs.length);
}
// Output selector (Chrome/Edge/Firefox 116+; hidden where setSinkId is unsupported, e.g. Safari/iOS)
const sinkSupported = () => typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
async function fillOutputs() {
  const sel = $("spk"); if (!sinkSupported()) { sel.hidden = true; return; }
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput"); } catch {}
  sel.replaceChildren(...devs.map((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || `Speaker ${i + 1}`; return o; }));
  const saved = localStorage.spkId;
  if (saved && devs.some(d => d.deviceId === saved)) { sel.value = saved; await setOutput(saved, false); }
  else if (devs.length) sel.value = devs.some(d => d.deviceId === "default") ? "default" : devs[0].deviceId;
  sel.hidden = devs.length < 1;
}
async function setOutput(id, remember = true) {
  try { await $("remote").setSinkId(id === "default" ? "" : id); }
  catch (e) { log("Output switch failed: " + e.message, "sys"); return; }
  try { setTonesSink(id); } catch {}
  if (remember) { localStorage.spkId = id; log("output: " + ($("spk").selectedOptions[0]?.textContent || id), "sys"); }
}
$("spk").onchange = e => setOutput(e.target.value);
async function switchMic(id) {
  let ns;
  try { ns = await getMic(id); }
  catch (e) { log("Mic switch failed: " + e.message, "sys"); $("mic").value = curMicId(); return; }
  const t = ns.getAudioTracks()[0];
  try { const sender = pc?.getSenders().find(s => s.track?.kind === "audio") || pc?.getSenders()[0];
    if (sender) await sender.replaceTrack(t); }
  catch (e) { log("Mic switch failed: " + e.message, "sys"); ns.getTracks().forEach(x => x.stop()); return; }
  localStream?.getTracks().forEach(x => x.stop()); localStream = ns;
  localStorage.micId = id; log("mic: " + (t.label || id), "sys");
}
$("mic").onchange = e => switchMic(e.target.value);
$("mute").onclick = () => { muted = !muted; localStream?.getAudioTracks().forEach(t => t.enabled = !muted); $("mute").textContent = muted ? "Unmute" : "Mute"; };
$("chat").onsubmit = e => { e.preventDefault(); const text = $("msg").value.trim();
  if (!text || dc?.readyState !== "open") return; dc.send(JSON.stringify({ t: "msg", nick, text })); chatLine(nick, text); $("msg").value = ""; };
window.__sendChat = t => { $("msg").value = t; $("chat").requestSubmit(); };

// Push: always on. Permission is requested inside a user gesture; subscribe silently if granted, else nothing.
function autoPush(room) { subscribePush(room).catch(e => console.warn("push:", e.message)); }
function askPush(room) {
  if (typeof Notification === "undefined" || !pushSupported() || Notification.permission === "denied") return Promise.resolve();
  const p = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
  return Promise.resolve(p).then(r => r === "granted" ? subscribePush(room) : null).catch(e => console.warn("push:", e?.message));
}
function route() { const r = location.hash.slice(1); if (r !== current && /^[A-Za-z0-9_-]{8,64}$/.test(r)) { current = r; join(r); } }
let current = null;
window.addEventListener("hashchange", () => { if (location.hash.slice(1) !== current) location.reload(); });
route();

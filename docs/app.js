import { enableWakeLock, disableWakeLock } from "./wakelock.js?v=p15";
import { unlockAudio, playConnectSound, playDisconnectSound, setTonesSink } from "./tones.js?v=p15";
import { clientId, registerSW, subscribePush, pushSupported } from "./push.js?v=p15";
// Signaling servers in priority order (self-hosted server/ first, then the Cloudflare Worker). Everyone uses the
// same order, so peers meet on the first reachable one; after 2 failures in a row the client moves to the next.
const SIGNALS = ["wss://138-201-154-35.sslip.io/room/", "wss://p2p-voice-signal.tmn-sun.workers.dev/room/"];
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
let iceExtra = []; // TURN/STUN handed out by the signaling server in "welcome"
const $ = id => document.getElementById(id);
let ws, localStream, nick, muted = false, statsTimer, myId = null, roomKind = "1:1", roomMax = 2, roomFull = false;

function log(text, cls = "") { const d = document.createElement("div"); d.className = cls; d.textContent = text; $("log").append(d); $("log").scrollTop = 1e9; }
// System line with a link to the connectivity check page (shown once per reason).
const hinted = new Set();
function hint(text) {
  if (hinted.has(text)) return; hinted.add(text);
  const d = document.createElement("div"); d.className = "sys warn"; d.append("⚠ " + text + " ");
  const a = document.createElement("a"); a.href = "check.html"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Проверить связь";
  d.append(a); $("log").append(d); $("log").scrollTop = 1e9;
}
// LCD "NET" row: signaling server + how audio flows (P2P direct or via TURN relay).
const sigLabel = u => u.includes("workers.dev") ? "CLOUDFLARE" : "VPS";
let netState = "—";
function setNet(state) {
  if (state != null) netState = state;
  const routes = [...new Set([...peers.values()].filter(p => p.up && p.route).map(p => p.route))];
  $("net").textContent = sigLabel(SIGNALS[sigIdx]) + " " + netState + (routes.length ? " · " + routes.join("/") : "");
}
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


// ---------- Mesh: one RTCPeerConnection + DataChannel per remote peer ----------
const peers = new Map(); // id -> { id, nick, pc, dc, audio, offerer, up, restarts, restartTimer, prev, st }
window.__peers = peers;
const JITTER_MS = 80;
function setBuffer(r) {
  try { if ("jitterBufferTarget" in r) r.jitterBufferTarget = JITTER_MS; else if ("playoutDelayHint" in r) r.playoutDelayHint = JITTER_MS / 1000; }
  catch (e) { console.warn("jitter buffer:", e.message); }
}
async function setPriority(pc) {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== "audio") continue;
    try { const p = s.getParameters(); if (!p.encodings?.length) continue;
      p.encodings.forEach(e => { e.priority = "high"; e.networkPriority = "high"; e.maxBitrate = 64000; });
      await s.setParameters(p); } catch (e) { console.warn("priority:", e.message); }
  }
}
function send(o) { ws?.readyState === 1 && ws.send(JSON.stringify(o)); }
const anyUp = () => [...peers.values()].some(p => p.up);
function refreshCall() {
  const up = [...peers.values()].filter(p => p.up);
  if (up.length) enableWakeLock(); else disableWakeLock();
  const st = roomFull ? `room full (max ${roomMax})` : up.length ? "connected" : peers.size ? "connecting…" : (ws?.readyState === 1 ? "waiting for peer…" : $("status").textContent);
  status(st); window.__state = st;
  $("peer").textContent = roomKind === "group" ? `${up.length}/${roomMax - 1} · ${[...peers.values()].map(p => p.nick || "…").join(", ") || "—"}`
                                               : ([...peers.values()][0]?.nick || "—");
  const open = [...peers.values()].some(p => p.dc?.readyState === "open");
  $("msg").disabled = $("send").disabled = !open;
  renderPeerList();
}
function peerOf(id, nickName) {
  let p = peers.get(id);
  if (p) { if (nickName) p.nick = nickName; return p; }
  p = { id, nick: nickName || "", up: false, restarts: 0, offerer: false, prev: null, st: {}, born: Date.now() };
  const pc = p.pc = new RTCPeerConnection({ iceServers: [...iceExtra, ...ICE], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  p.audio = document.createElement("audio"); p.audio.autoplay = true; p.audio.dataset.peer = id; $("audios").append(p.audio);
  p.audio.volume = +(localStorage["vol:" + (p.nick || id)] ?? 1);
  if (localStorage.spkId && p.audio.setSinkId) p.audio.setSinkId(localStorage.spkId === "default" ? "" : localStorage.spkId).catch(() => {});
  pc.onicecandidate = e => e.candidate && send({ type: "ice", to: id, candidate: e.candidate });
  pc.ontrack = e => {
    const st = e.streams[0];
    // First audio stream = voice. Any other stream (video and/or game audio) = screen share.
    if (e.track.kind === "audio" && (!p.voiceStreamId || p.voiceStreamId === st?.id)) {
      p.voiceStreamId = st?.id; p.voiceTrackId = e.track.id; p.audio.srcObject = st; setBuffer(e.receiver); p.audio.play().catch(() => {}); return;
    }
    if (st) showRemoteScreen(p, st, e.track);
  };
  pc.ondatachannel = e => setupDC(p, e.channel);
  pc.onconnectionstatechange = () => {
    if (peers.get(id) !== p) return;
    const st = pc.connectionState;
    if (st === "connected") { p.restarts = 0; clearTimeout(p.restartTimer); if (!p.up) { p.up = true; playConnectSound(); } setPriority(pc); }
    else if (st === "disconnected" || st === "failed" || st === "closed") {
      if (p.up) { p.up = false; playDisconnectSound(); }
      if (p.offerer && st !== "closed") { clearTimeout(p.restartTimer); p.restartTimer = setTimeout(() => iceRestart(p), st === "failed" ? 0 : 4000); }
    }
    refreshCall();
  };
  peers.set(id, p); refreshCall();
  return p;
}
function setupDC(p, ch) {
  p.dc = ch;
  ch.onopen = () => { ch.send(JSON.stringify({ t: "nick", nick })); refreshCall(); };
  ch.onclose = () => refreshCall();
  ch.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "nick") { const first = !p.nick; p.nick = String(m.nick).slice(0, 32); p.audio.volume = +(localStorage["vol:" + p.nick] ?? p.audio.volume); if (first || !p.announced) { p.announced = true; log(`${p.nick} joined`, "sys"); } refreshCall(); }
    if (m.t === "screen") { if (!m.on) hideRemoteScreen(p); else log(`${p.nick || "peer"} is sharing the screen`, "sys"); }
    if (m.t === "msg") chatLine(p.nick || m.nick, m.text); };
}
function removePeer(id, why) {
  const p = peers.get(id); if (!p) return;
  peers.delete(id); clearTimeout(p.restartTimer);
  if (p.up) playDisconnectSound();
  try { p.dc?.close(); p.pc.close(); } catch {}
  p.audio.srcObject = null; p.audio.remove(); hideRemoteScreen(p); if (screen.peer === p) stopShare();
  if (why) log(`${p.nick || "peer"} left`, "sys");
  refreshCall();
}
async function offerTo(p, restart = false) {
  p.offerer = true;
  if (!restart) setupDC(p, p.pc.createDataChannel("chat", { ordered: true }));
  p.makingOffer = true;
  try { const o = await p.pc.createOffer(restart ? { iceRestart: true } : {}); o.sdp = mungeOpus(o.sdp);
    await p.pc.setLocalDescription(o); send({ type: "offer", to: p.id, sdp: o.sdp, restart }); }
  finally { p.makingOffer = false; }
}
// Mid-call renegotiation (screen share add/remove). Perfect negotiation: on collision the "polite" side
// (higher peer id) rolls back, the impolite side ignores the incoming offer. Voice roles (offerer/ICE restart) unchanged.
async function renegotiate(p) {
  if (!p || p.pc.signalingState === "closed") return;
  if (p.makingOffer || p.pc.signalingState !== "stable") { p.pendingReneg = true; return; } // run again once stable
  p.makingOffer = true; p.pendingReneg = false;
  try { const o = await p.pc.createOffer(); o.sdp = mungeOpus(o.sdp);
    if (p.pc.signalingState !== "stable") { p.pendingReneg = true; return; }
    await p.pc.setLocalDescription(o); send({ type: "offer", to: p.id, sdp: o.sdp, reneg: true }); }
  catch (e) { console.warn("renegotiate:", e.message); }
  finally { p.makingOffer = false; }
}
function flushReneg(p) { if (p?.pendingReneg && p.pc.signalingState === "stable") renegotiate(p); }
async function iceRestart(p) {
  if (peers.get(p.id) !== p || p.pc.connectionState === "connected" || ws?.readyState !== 1 || p.restarts >= 5) return;
  p.restarts++; log(`reconnecting ${p.nick || "peer"} (ICE restart ${p.restarts})…`, "sys");
  try { await offerTo(p, true); } catch (e) { console.warn("ice restart:", e.message); }
  clearTimeout(p.restartTimer); p.restartTimer = setTimeout(() => iceRestart(p), 8000);
}
window.__iceRestart = id => { const p = id ? peers.get(id) : [...peers.values()][0]; if (p) { p.offerer = true; p.restarts = 0; return offerTo(p, true); } };

async function onSignal(m) {
  if (m.type === "pong") { lastPong = Date.now(); return; }
  if (m.type === "full") { roomFull = true; roomMax = m.max; for (const id of [...peers.keys()]) removePeer(id); status(`room full (max ${m.max})`); window.__state = "full"; return; }
  if (m.type === "welcome") {
    myId = m.id; iceExtra = Array.isArray(m.ice) ? m.ice : []; sigCycle = 0; setNet("OK"); roomKind = m.kind; roomMax = m.max; document.body.classList.toggle("group", roomKind === "group");
    $("roomkind").textContent = roomKind === "group" ? `GROUP · up to ${roomMax}` : "1:1";
    for (const id of [...peers.keys()]) removePeer(id); // fresh session after reconnect
    refreshCall();
    for (const x of m.peers) offerTo(peerOf(x.id, x.nick)).catch(e => console.warn(e)); // newcomer offers -> no glare
    return;
  }
  if (m.type === "peer-joined") { peerOf(m.id, m.nick); status("peer joining…"); return; }
  if (m.type === "peer-left") { removePeer(m.id, true); return; }
  if (!m.from || m.from === myId) return;
  if (m.type === "offer") {
    let p = peers.get(m.from);
    if (m.reneg && p) {
      const polite = myId > m.from, collision = p.makingOffer || p.pc.signalingState !== "stable";
      if (collision && !polite) return; // impolite: ignore, our offer wins
      if (collision) await p.pc.setLocalDescription({ type: "rollback" }).catch(() => {});
      await p.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      const a = await p.pc.createAnswer(); a.sdp = mungeOpus(a.sdp); await p.pc.setLocalDescription(a);
      send({ type: "answer", to: m.from, sdp: a.sdp });
      if (collision) p.pendingReneg = true; // our rolled-back change goes again
      flushReneg(p);
      return;
    }
    if (p && !m.restart && (p.offerer || p.pc.remoteDescription)) { removePeer(m.from); p = null; }
    p ||= peerOf(m.from); p.offerer = false;
    await p.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    const a = await p.pc.createAnswer(); a.sdp = mungeOpus(a.sdp); await p.pc.setLocalDescription(a);
    send({ type: "answer", to: m.from, sdp: a.sdp });
  } else if (m.type === "answer") { const p = peers.get(m.from); if (p && p.pc.signalingState === "have-local-offer") { await p.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }); if (screen.senders.length) tuneScreenSenders(); flushReneg(p); } }
  else if (m.type === "ice") { const p = peers.get(m.from); if (p) try { await p.pc.addIceCandidate(m.candidate); } catch (e) { console.warn(e); } }
}

// ---------- Screen share (1:1 rooms only) ----------
const screen = { stream: null, senders: [], prev: null, peer: null };
const isMobile = /Mobi|Android|iP(hone|ad|od)/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const canShare = () => !!navigator.mediaDevices?.getDisplayMedia && !isMobile && roomKind === "1:1";
function updateShareBtn() {
  const b = $("share"); if (!b) return;
  b.hidden = !canShare();
  b.disabled = !screen.stream && ![...peers.values()].some(p => p.up);
  b.textContent = screen.stream ? "Остановить показ" : "Показать экран";
  b.classList.toggle("sharing", !!screen.stream);
}
function sortCodecs(tr) {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.("video")?.codecs; if (!caps || !tr?.setCodecPreferences) return;
    const rank = c => { const t = c.mimeType.toLowerCase(); return t === "video/vp9" ? 0 : t === "video/h264" ? 1 : t === "video/vp8" ? 2 : 3; };
    tr.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch (e) { console.warn("codec prefs:", e.message); }
}
async function tuneScreenSenders() {
  for (const s of screen.senders) {
    if (s.track?.kind !== "video") continue;
    try { const prm = s.getParameters(); prm.degradationPreference = "maintain-framerate";
      if (!prm.encodings?.length) continue;
      prm.encodings.forEach(e => { e.maxBitrate = 6_000_000; e.maxFramerate = 60; });
      await s.setParameters(prm); } catch (e) { console.warn("screen params:", e.message); }
  }
}
async function startShare() {
  const p = [...peers.values()].find(x => x.up); if (!p || screen.stream || !canShare()) return;
  let st;
  try {
    st = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
      suppressLocalAudioPlayback: true, systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include" });
  } catch (e) { if (e.name !== "NotAllowedError") log("Screen share failed: " + e.message, "sys"); return; }
  screen.stream = st; screen.prev = null; screen.peer = p;
  const v = st.getVideoTracks()[0]; if (v) { try { v.contentHint = "motion"; } catch {} v.addEventListener("ended", stopShare, { once: true }); }
  st.getAudioTracks().forEach(t => { try { t.contentHint = "music"; } catch {} }); // game audio: own m-line, voice Opus munging only touches the first audio section
  screen.senders = st.getTracks().map(t => {
    const s = p.pc.addTrack(t, st);
    if (t.kind === "video") sortCodecs(p.pc.getTransceivers().find(x => x.sender === s));
    return s;
  });
  await tuneScreenSenders();
  try { p.dc?.readyState === "open" && p.dc.send(JSON.stringify({ t: "screen", on: true })); } catch {}
  log(`screen share started${st.getAudioTracks().length ? " (with audio)" : ""}`, "sys");
  updateShareBtn(); await renegotiate(p);
}
async function stopShare() {
  const st = screen.stream; if (!st) return;
  const p = screen.peer; screen.stream = null; screen.peer = null;
  updateShareBtn(); $("screenstat").hidden = true;
  st.getTracks().forEach(t => t.stop());
  if (p && peers.get(p.id) === p && p.pc.signalingState !== "closed") {
    for (const s of screen.senders) try { p.pc.removeTrack(s); } catch {}
    try { p.dc?.readyState === "open" && p.dc.send(JSON.stringify({ t: "screen", on: false })); } catch {}
    await renegotiate(p);
  }
  screen.senders = []; $("screenstat").hidden = true;
  log("screen share stopped", "sys"); updateShareBtn();
}
$("share").onclick = () => (screen.stream ? stopShare() : startShare());
window.__share = { start: startShare, stop: stopShare, state: () => !!screen.stream };
function showRemoteScreen(p, st, track) {
  const v = $("screenvideo"); p.viewPrev = null;
  if (v.srcObject !== st) v.srcObject = st;
  v.volume = +(localStorage.gameVol ?? 1); $("gamevol").value = v.volume;
  if (localStorage.spkId && v.setSinkId) v.setSinkId(localStorage.spkId === "default" ? "" : localStorage.spkId).catch(() => {});
  $("screenview").hidden = false; $("gamevolrow").hidden = !st.getAudioTracks().length;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  track.onended = () => { if (!st.getTracks().some(t => t.readyState === "live")) hideRemoteScreen(p); };
  st.onremovetrack = () => { if (!st.getVideoTracks().length) hideRemoteScreen(p); else $("gamevolrow").hidden = !st.getAudioTracks().length; };
  st.onaddtrack = () => { $("gamevolrow").hidden = !st.getAudioTracks().length; };
  p.viewing = true;
}
function hideRemoteScreen(p) {
  if (!p?.viewing) return; p.viewing = false;
  const v = $("screenvideo"); v.pause(); v.srcObject = null; $("screenview").hidden = true; $("screenstat").hidden = true;
}
$("screenvideo").onclick = () => { const v = $("screenvideo"); if (v.muted) { v.muted = false; }
  if (document.fullscreenElement) document.exitFullscreen?.(); else if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); else v.webkitEnterFullscreen?.(); };
$("gamevol").oninput = e => { const v = $("screenvideo"); v.muted = false; v.volume = +e.target.value; localStorage.gameVol = e.target.value; };
async function screenStats() {
  const p = screen.stream ? screen.peer : [...peers.values()].find(x => x.viewing);
  if (!p) { $("screenstat").hidden = true; return; }
  const sending = !!screen.stream; let cur = null;
  const vs = sending ? screen.senders.find(s => s.track?.kind === "video") : null;
  const vt = sending ? null : $("screenvideo").srcObject?.getVideoTracks()[0];
  const rcv = vt && p.pc.getReceivers().find(r => r.track === vt);
  const r = vs ? await vs.getStats() : rcv ? await rcv.getStats() : null; if (!r) return;
  r.forEach(s => {
    if (s.kind !== "video") return;
    if (sending && s.type === "outbound-rtp" && s.bytesSent) cur = { w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesSent, ts: s.timestamp, lim: s.qualityLimitationReason };
    if (!sending && s.type === "inbound-rtp" && s.bytesReceived) cur = { w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesReceived, ts: s.timestamp, dec: s.framesDecoded };
  });
  if (!cur) return;
  const holder = sending ? screen : p, key = sending ? "prev" : "viewPrev", pv = holder[key]; holder[key] = cur;
  const kbps = pv && cur.ts > pv.ts && cur.bytes >= pv.bytes ? 8 * (cur.bytes - pv.bytes) / (cur.ts - pv.ts) : null;
  $("screenstat").hidden = false;
  $("screeninfo").textContent = `${sending ? "TX" : "RX"} ${cur.w || "—"}×${cur.h || "—"} · ${cur.fps ?? "—"}fps · ${kbps != null ? (kbps / 1000).toFixed(2) + "Mbps" : "—"}${cur.lim && cur.lim !== "none" ? " · lim " + cur.lim : ""}`;
  window.__screenStats = { ...cur, kbps, sending };
}
setInterval(() => { screenStats().catch(() => {}); updateShareBtn(); }, 1000);

// ---------- Signaling WebSocket with keepalive + auto-reconnect ----------
let lastPong = 0, pingTimer = null, reconnectTimer = null, roomId = null;
let sigIdx = 0, sigFails = 0, sockOpenedAt = 0, sigCycle = 0;
function sigFailed(why) { // a socket died: count it unless it had been healthy for a minute
  const name = sigLabel(SIGNALS[sigIdx]);
  if (sockOpenedAt && Date.now() - sockOpenedAt > 60000) sigFails = 0;
  const loud = sigCycle < SIGNALS.length; // details only for the first round of tries
  setNet("✕"); if (loud) log(`сервер ${name}: ${why}`, "sys");
  if (++sigFails >= 2) {
    if (++sigCycle >= SIGNALS.length) hint(`Нет связи ни с одним сервером (${SIGNALS.map(sigLabel).join(", ")}). Похоже, их блокирует сеть.`);
    if (SIGNALS.length > 1) { sigIdx = (sigIdx + 1) % SIGNALS.length; sigFails = 0; if (sigCycle < SIGNALS.length) log("переключаюсь на сервер " + sigLabel(SIGNALS[sigIdx]), "sys"); }
  }
}
function connectWS() {
  clearTimeout(reconnectTimer); sockOpenedAt = 0; setNet("…");
  const sock = ws = new WebSocket(SIGNALS[sigIdx] + roomId + "?cid=" + clientId() + "&nick=" + encodeURIComponent(nick));
  setTimeout(() => { if (sock === ws && sock.readyState === 0) sock.close(); }, 8000); // blocked handshakes can hang
  sock.onmessage = e => { if (sock === ws) { let m; try { m = JSON.parse(e.data); } catch { return; } onSignal(m).catch(err => console.warn(err)); } };
  sock.onopen = () => { lastPong = sockOpenedAt = Date.now(); status("signaling connected"); };
  sock.onclose = e => { if (sock !== ws) return; if (roomFull) return;
    status("signaling lost, reconnecting…"); sigFailed(sockOpenedAt ? `соединение оборвалось (код ${e.code})` : "не отвечает"); reconnectTimer = setTimeout(connectWS, sigCycle >= SIGNALS.length ? 5000 : 1500); };
}
function keepalive() {
  if (!ws || roomFull) return;
  if (ws.readyState === 1) {
    if (Date.now() - lastPong > 10000) { const old = ws; ws = null; try { old.close(); } catch {} status("signaling lost, reconnecting…"); sigFailed("нет ответа 10 с"); connectWS(); return; }
    ws.send('{"type":"ping"}');
  }
}
window.__ws = () => ws;

// ---------- Peer list + per-peer stats/volume ----------
function renderPeerList() {
  const ul = $("peers"); if (!ul) return;
  const rows = [...peers.values()];
  for (const li of [...ul.children]) if (!peers.has(li.dataset.peer)) li.remove();
  for (const p of rows) {
    let li = ul.querySelector(`li[data-peer="${CSS.escape(p.id)}"]`);
    if (!li) {
      li = document.createElement("li"); li.dataset.peer = p.id;
      const name = document.createElement("span"); name.className = "pn";
      const st = document.createElement("span"); st.className = "ps";
      const vol = document.createElement("input"); vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.05; vol.className = "pv"; vol.title = "Volume";
      vol.oninput = () => { p.audio.volume = +vol.value; localStorage["vol:" + (p.nick || p.id)] = vol.value; };
      li.append(name, st, vol); ul.append(li);
    }
    li.querySelector(".pn").textContent = (p.up ? "● " : "○ ") + (p.nick || "…");
    const s = p.st; li.querySelector(".ps").textContent = p.up ? `RTT ${s.rtt?.toFixed(0) ?? "—"} · L ${s.lossPct?.toFixed(1) ?? "—"}% · J ${s.jitter?.toFixed(0) ?? "—"} · C ${s.concPct?.toFixed(1) ?? "—"}%` : "connecting…";
    const v = li.querySelector(".pv"); if (document.activeElement !== v) v.value = p.audio.volume;
  }
  $("peerlist").hidden = roomKind !== "group";
}
async function peerStats(p) {
  const r = await p.pc.getStats(); const out = {}; const codecs = {}; let localId, remoteId;
  r.forEach(s => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) { out.rtt = s.currentRoundTripTime * 1000; localId = s.localCandidateId; remoteId = s.remoteCandidateId; }
    if (s.type === "inbound-rtp" && s.kind === "audio" && (!p.voiceTrackId || !s.trackIdentifier || s.trackIdentifier === p.voiceTrackId)) { out.lost = s.packetsLost; out.recv = s.packetsReceived; out.jitter = s.jitter * 1000; out.codecId = s.codecId; out.conc = s.concealedSamples; out.tot = s.totalSamplesReceived; }
    if (s.type === "codec") codecs[s.id] = s;
  });
  const pv = p.prev || {}; p.prev = out;
  const dl = out.lost - (pv.lost ?? out.lost), dr = out.recv - (pv.recv ?? out.recv), dc = out.conc - (pv.conc ?? out.conc), dt = out.tot - (pv.tot ?? out.tot);
  out.lossPct = dl + dr > 0 ? Math.max(0, 100 * dl / (dl + dr)) : 0; out.concPct = dt > 0 ? Math.max(0, 100 * dc / dt) : 0;
  out.codec = codecs[out.codecId]; p.st = out;
  const lc = localId && r.get(localId), rc = remoteId && r.get(remoteId);
  if (lc) p.route = lc.candidateType === "relay" || rc?.candidateType === "relay" ? "TURN" : "P2P";
  return out;
}
async function stats() {
  for (const p of peers.values()) if (!p.up && Date.now() - p.born > 25000)
    hint(`Не получается соединиться с ${p.nick || "собеседником"} ${iceExtra.length ? "ни напрямую, ни через TURN" : "напрямую, а TURN на этом сервере нет"}.`);
  setNet();
  const up = [...peers.values()].filter(p => p.up); if (!up.length) { renderPeerList(); return; }
  const all = await Promise.all(up.map(p => peerStats(p).catch(() => ({}))));
  const worst = k => { const v = all.map(x => x[k]).filter(x => x != null); return v.length ? Math.max(...v) : null; };
  const rtt = worst("rtt"), jit = worst("jitter"), loss = worst("lossPct"), conc = worst("concPct");
  const lost = all.reduce((a, x) => a + (x.lost || 0), 0), recv = all.reduce((a, x) => a + (x.recv || 0), 0);
  const ct = all.reduce((a, x) => a + (x.conc || 0), 0), tt = all.reduce((a, x) => a + (x.tot || 0), 0);
  $("rtt").textContent = rtt != null ? rtt.toFixed(1) : "—";
  $("jitter").textContent = jit != null ? jit.toFixed(1) : "—";
  $("loss").textContent = `${lost} (${lost + recv ? (100 * lost / (lost + recv)).toFixed(2) : 0}%)`;
  const c = all.find(x => x.codec)?.codec; if (c) $("codec").textContent = `${c.mimeType.split("/")[1]} ${c.sdpFmtpLine || ""}`;
  if (tt) $("conc").textContent = `${(conc ?? 0).toFixed(1)}% now · ${(100 * ct / tt).toFixed(2)}% total`;
  hist.push({ loss: loss ?? 0, conc: conc ?? 0, rtt, jitter: jit }); if (hist.length > 60) hist.shift();
  drawChart(); renderPeerList();
  window.__stats = { rtt, jitter: jit, loss, conc };
}

async function join(room) {
  window.__room = roomId = room;
  roomKind = room.startsWith("g-") ? "group" : "1:1"; document.body.classList.toggle("group", roomKind === "group");
  $("roomkind").textContent = roomKind === "group" ? "GROUP · up to 5" : "1:1";
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (ios && !standalone) $("notifyinfo").hidden = false;
  if (typeof Notification !== "undefined" && pushSupported()) {
    if (Notification.permission === "granted") autoPush(room);
    else if (Notification.permission === "default") document.addEventListener("pointerdown", () => askPush(room), { once: true, capture: true });
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
  connectWS();
  pingTimer = setInterval(keepalive, 5000);
  statsTimer = setInterval(stats, 1000);
}

["pointerdown", "keydown", "touchend"].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true }));
window.addEventListener("pagehide", () => disableWakeLock());
registerSW();
function createRoom(group) {
  const id = (group ? "g-" : "") + randomId();
  try { unlockAudio(); } catch {}
  try { askPush(id); } catch (e) { console.warn("push:", e); }
  history.pushState(null, "", "#" + id); route();
}
$("create").onclick = () => createRoom(false);
$("creategroup").onclick = () => createRoom(true);
$("copy").onclick = () => navigator.clipboard.writeText(location.href);
const hist = [];
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
  try { const sid = id === "default" ? "" : id; await $("remote").setSinkId(sid);
    await Promise.all([...peers.values()].map(p => p.audio.setSinkId?.(sid))); await $("screenvideo").setSinkId?.(sid)?.catch(() => {}); }
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
  try { await Promise.all([...peers.values()].map(p => { const sender = p.pc.getSenders().find(s => s.track?.kind === "audio") || p.pc.getSenders()[0];
    return sender?.replaceTrack(t); })); }
  catch (e) { log("Mic switch failed: " + e.message, "sys"); ns.getTracks().forEach(x => x.stop()); return; }
  localStream?.getTracks().forEach(x => x.stop()); localStream = ns;
  localStorage.micId = id; log("mic: " + (t.label || id), "sys");
}
$("mic").onchange = e => switchMic(e.target.value);
$("mute").onclick = () => { muted = !muted; localStream?.getAudioTracks().forEach(t => t.enabled = !muted); $("mute").textContent = muted ? "Unmute" : "Mute"; };
$("chat").onsubmit = e => { e.preventDefault(); const text = $("msg").value.trim();
  const open = [...peers.values()].filter(p => p.dc?.readyState === "open");
  if (!text || !open.length) return;
  const msg = JSON.stringify({ t: "msg", nick, text }); open.forEach(p => { try { p.dc.send(msg); } catch {} });
  chatLine(nick, text); $("msg").value = ""; };
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

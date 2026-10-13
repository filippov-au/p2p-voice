const SIGNAL = "wss://p2p-voice-signal.tmn-sun.workers.dev/room/";
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
const $ = id => document.getElementById(id);
let ws, pc, dc, localStream, nick, muted = false, statsTimer, prevLoss = null;

function log(text, cls = "") { const d = document.createElement("div"); d.className = cls; d.textContent = text; $("log").append(d); $("log").scrollTop = 1e9; }
function status(s) { $("status").textContent = s; }
function randomId() { const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); }

function audioConstraints() {
  return { echoCancellation: $("aec").checked, noiseSuppression: $("ns").checked, autoGainControl: $("agc").checked,
    channelCount: 1, sampleRate: 48000, latency: 0 };
}
async function getMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
  s.getAudioTracks().forEach(t => { t.enabled = !muted; t.contentHint = "speech"; });
  return s;
}
async function reacquire() {
  const ns = await getMic(); const t = ns.getAudioTracks()[0];
  const sender = pc?.getSenders().find(s => s.track?.kind === "audio");
  if (sender) await sender.replaceTrack(t);
  localStream?.getTracks().forEach(x => x.stop()); localStream = ns;
  log(`mic: AEC=${$("aec").checked} NS=${$("ns").checked} AGC=${$("agc").checked}`, "sys");
}

// Opus: mono, 48k, ~40kbps, 10ms frames, FEC, DTX
function mungeOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i); if (!m) return sdp;
  const pt = m[1], params = "minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=40000;maxplaybackrate=48000";
  const re = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
  sdp = re.test(sdp) ? sdp.replace(re, `a=fmtp:${pt} ${params}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`);
  sdp = sdp.replace(/a=(max)?ptime:\d+\r\n/g, "");
  return sdp.replace(/(m=audio[^\r\n]*\r\n)/, "$1a=ptime:10\r\na=maxptime:10\r\n");
}

function setupDC(ch) {
  dc = ch;
  dc.onopen = () => { $("msg").disabled = $("send").disabled = false; log("chat connected", "sys"); dc.send(JSON.stringify({ t: "nick", nick })); };
  dc.onclose = () => { $("msg").disabled = $("send").disabled = true; };
  dc.onmessage = e => { const m = JSON.parse(e.data);
    if (m.t === "nick") { $("peer").textContent = m.nick; log(`${m.nick} joined`, "sys"); }
    if (m.t === "msg") log(`${m.nick}: ${m.text}`); };
}

function newPC() {
  closePC();
  pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  localStream.getAudioTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => e.candidate && send({ type: "ice", candidate: e.candidate });
  pc.ontrack = e => { const a = $("remote"); a.srcObject = e.streams[0];
    try { e.receiver.playoutDelayHint = 0; e.receiver.jitterBufferTarget = 0; } catch {} a.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { status(pc.connectionState); window.__state = pc.connectionState; };
  pc.ondatachannel = e => setupDC(e.channel);
  window.__pc = pc;
  return pc;
}
function closePC() { try { dc?.close(); pc?.close(); } catch {} pc = dc = null; $("peer").textContent = "—"; }
function send(o) { ws?.readyState === 1 && ws.send(JSON.stringify(o)); }

async function call() {
  newPC(); setupDC(pc.createDataChannel("chat", { ordered: true }));
  const o = await pc.createOffer(); o.sdp = mungeOpus(o.sdp);
  await pc.setLocalDescription(o); send({ type: "offer", sdp: o.sdp });
}

async function onSignal(m) {
  if (m.type === "welcome") { status(m.peers.length ? "calling…" : "waiting for peer…"); if (m.peers.length) await call(); }
  else if (m.type === "peer-joined") { status("peer joining…"); }
  else if (m.type === "peer-left") { log("peer left", "sys"); closePC(); status("waiting for peer…"); }
  else if (m.type === "offer") { newPC(); await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    const a = await pc.createAnswer(); a.sdp = mungeOpus(a.sdp); await pc.setLocalDescription(a); send({ type: "answer", sdp: a.sdp }); }
  else if (m.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
  else if (m.type === "ice" && pc) try { await pc.addIceCandidate(m.candidate); } catch (e) { console.warn(e); }
}

async function stats() {
  if (!pc) return; const r = await pc.getStats(); const out = {};
  let codecs = {};
  r.forEach(s => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) out.rtt = s.currentRoundTripTime * 1000;
    if (s.type === "inbound-rtp" && s.kind === "audio") { out.lost = s.packetsLost; out.recv = s.packetsReceived; out.jitter = s.jitter * 1000; out.codecId = s.codecId; }
    if (s.type === "codec") codecs[s.id] = s;
  });
  $("rtt").textContent = out.rtt != null ? out.rtt.toFixed(1) : "—";
  $("jitter").textContent = out.jitter != null ? out.jitter.toFixed(1) : "—";
  if (out.recv != null) { const tot = out.lost + out.recv; $("loss").textContent = `${out.lost} (${tot ? (100 * out.lost / tot).toFixed(2) : 0}%)`; }
  const c = codecs[out.codecId]; if (c) $("codec").textContent = `${c.mimeType.split("/")[1]} ${c.sdpFmtpLine || ""}`;
  window.__stats = out;
}

async function join(room) {
  $("lobby").hidden = true; $("room").hidden = false; $("link").value = location.href;
  nick = localStorage.nick || prompt("Nickname?", "player") || "player"; localStorage.nick = nick;
  try { localStream = await getMic(); } catch (e) { log("Mic error: " + e.message, "sys"); return; }
  ws = new WebSocket(SIGNAL + room);
  ws.onmessage = e => onSignal(JSON.parse(e.data));
  ws.onclose = e => { status(e.code === 1006 && !pc ? "room full or signaling down" : "signaling closed"); };
  ws.onopen = () => status("signaling connected");
  statsTimer = setInterval(stats, 1000);
}

$("create").onclick = () => { location.hash = randomId(); };
$("copy").onclick = () => navigator.clipboard.writeText(location.href);
$("mute").onclick = () => { muted = !muted; localStream?.getAudioTracks().forEach(t => t.enabled = !muted); $("mute").textContent = muted ? "Unmute" : "Mute"; };
["aec", "ns", "agc"].forEach(id => $(id).onchange = reacquire);
$("chat").onsubmit = e => { e.preventDefault(); const text = $("msg").value.trim();
  if (!text || dc?.readyState !== "open") return; dc.send(JSON.stringify({ t: "msg", nick, text })); log(`${nick}: ${text}`); $("msg").value = ""; };
window.__sendChat = t => { $("msg").value = t; $("chat").requestSubmit(); };

function route() { const r = location.hash.slice(1); if (/^[A-Za-z0-9_-]{8,64}$/.test(r)) join(r); }
window.addEventListener("hashchange", () => location.reload());
route();

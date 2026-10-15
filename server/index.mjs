// Self-hosted signaling (same protocol as worker/src/index.js Room DO) for networks where Cloudflare is throttled.
// Also hands out short-lived coturn credentials (TURN REST API, static-auth-secret) in "welcome".
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const env = process.env;
const PORT = +(env.PORT || 8787), HOST = env.HOST || "127.0.0.1";
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || "https://filippov-au.github.io").split(",").map(s => s.trim()).filter(Boolean);
const TURN_SECRET = env.TURN_SECRET || "", TURN_URLS = (env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TURN_TTL = +(env.TURN_TTL || 12 * 3600);
const PUSH_URL = env.PUSH_NOTIFY_URL || "", PUSH_SECRET = env.PUSH_NOTIFY_SECRET || "";

const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/, CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STALE_MS = 15000, PONG = '{"type":"pong"}', MAX_ROOMS = 5000;
const rooms = new Map(); // roomId -> Map<ws, {id, cid, nick, seen, gone}>

function iceFor(user) {
  if (!TURN_URLS.length) return undefined;
  const stun = TURN_URLS.filter(u => u.startsWith("stun:")), turn = TURN_URLS.filter(u => !u.startsWith("stun:"));
  const out = stun.length ? [{ urls: stun }] : [];
  if (turn.length && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${user}`;
    const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
    out.push({ urls: turn, username, credential });
  }
  return out;
}

function notifyPush(roomId, cid) {
  if (!PUSH_URL || !PUSH_SECRET) return;
  fetch(PUSH_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + PUSH_SECRET },
    body: JSON.stringify({ roomId, clientId: cid }), signal: AbortSignal.timeout(10000) })
    .then(r => { if (!r.ok) console.log("push notify", r.status); }).catch(e => console.log("push notify error", e.message));
}

const live = room => [...room].filter(([, a]) => !a.gone);
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const [ws] of live(room)) if (ws !== except) try { ws.send(s); } catch {}
}
function drop(roomId, ws, reason) {
  const room = rooms.get(roomId), a = room?.get(ws); if (!a || a.gone) return;
  a.gone = true; room.delete(ws);
  try { ws.close(4001, reason); } catch {}
  broadcast(room, { type: "peer-left", id: a.id, reason }, ws);
  if (!room.size) rooms.delete(roomId);
}
function evictStale(roomId) {
  const room = rooms.get(roomId); if (!room) return; const now = Date.now();
  for (const [ws, a] of live(room)) if (now - a.seen > STALE_MS) drop(roomId, ws, "stale");
}
setInterval(() => { for (const id of [...rooms.keys()]) evictStale(id); }, 2000).unref();

const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/" ? 200 : 404, { "Content-Type": "text/plain" });
  res.end("p2p-voice signaling. WS: /room/<id>?cid=<clientId>");
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x"), m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
  const reject = code => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!m || !ROOM_RE.test(m[1])) return reject("404 Not Found");
  if (!ALLOWED_ORIGINS.includes(req.headers.origin)) return reject("403 Forbidden");
  if (!rooms.has(m[1]) && rooms.size >= MAX_ROOMS) return reject("503 Service Unavailable");
  wss.handleUpgrade(req, socket, head, ws => join(ws, m[1], url.searchParams));
});

function join(ws, roomId, q) {
  const kind = roomId.startsWith("g-") ? "group" : "1:1", max = kind === "group" ? 5 : 2;
  const cid = CID_RE.test(q.get("cid") || "") ? q.get("cid") : null;
  const nick = String(q.get("nick") || "player").slice(0, 32);
  evictStale(roomId);
  let room = rooms.get(roomId);
  if (room && cid) for (const [w, a] of live(room)) if (a.cid === cid) drop(roomId, w, "replaced"); // same client rejoining
  room = rooms.get(roomId);
  if (room && live(room).length >= max) { ws.send(JSON.stringify({ type: "full", max })); ws.close(4000, "room full"); return; }
  if (!room) rooms.set(roomId, room = new Map());
  const peers = live(room), id = crypto.randomUUID().slice(0, 8), a = { id, cid, nick, seen: Date.now(), gone: false };
  room.set(ws, a);
  ws.send(JSON.stringify({ type: "welcome", id, kind, max, peers: peers.map(([, p]) => ({ id: p.id, nick: p.nick })), ice: iceFor(cid || id) }));
  broadcast(room, { type: "peer-joined", id, nick }, ws);
  notifyPush(roomId, cid);

  ws.on("message", (buf, isBinary) => {
    if (a.gone || isBinary) return; a.seen = Date.now();
    const msg = buf.toString(); if (msg.length > 65536) return;
    if (msg === '{"type":"ping"}') { ws.send(PONG); return; }
    let data; try { data = JSON.parse(msg); } catch { return; }
    if (data.type === "ping") { ws.send(PONG); return; }
    if (!["offer", "answer", "ice"].includes(data.type)) return;
    data.from = id;
    const out = JSON.stringify(data);
    for (const [p, pa] of live(rooms.get(roomId) || new Map())) if (p !== ws && (typeof data.to !== "string" || pa.id === data.to)) try { p.send(out); } catch {}
  });
  ws.on("close", () => drop(roomId, ws, "closed"));
  ws.on("error", () => drop(roomId, ws, "error"));
}

server.listen(PORT, HOST, () => console.log(`signaling on ${HOST}:${PORT}; origins ${ALLOWED_ORIGINS.join(" ")}; turn ${TURN_URLS.length ? "on" : "off"}`));

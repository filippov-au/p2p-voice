import { DurableObject } from "cloudflare:workers";
import { sendPush } from "./webpush.js";

const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE = "https://p2p-voice-beta.pages.dev/";
const ALLOWED_ORIGINS = ["https://p2p-voice-beta.pages.dev"];
const isAllowed = o => ALLOWED_ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.p2p-voice-beta\.pages\.dev$/.test(o || "");

function cors(req) {
  const o = req.headers.get("Origin");
  return { "Access-Control-Allow-Origin": isAllowed(o) ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
const json = (req, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET")
        return env.VAPID_PUBLIC_KEY ? json(req, { publicKey: env.VAPID_PUBLIC_KEY }) : json(req, { error: "push not configured" }, 503);
      if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        let b; try { b = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }
        const s = b?.subscription;
        if (!ROOM_RE.test(b?.roomId || "") || !CID_RE.test(b?.clientId || "") || typeof s?.endpoint !== "string" ||
            !s.endpoint.startsWith("https://") || s.endpoint.length > 2048 || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string")
          return json(req, { error: "invalid subscription" }, 400);
        const r = await env.ROOM.get(env.ROOM.idFromName(b.roomId)).subscribe(
          { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, b.clientId);
        return json(req, { ok: true, ...r });
      }
      if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        let b; try { b = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }
        if (!ROOM_RE.test(b?.roomId || "") || typeof b?.endpoint !== "string") return json(req, { error: "invalid" }, 400);
        return json(req, { ok: true, ...(await env.ROOM.get(env.ROOM.idFromName(b.roomId)).unsubscribe(b.endpoint)) });
      }
      return json(req, { error: "not found" }, 404);
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
    if (!m) return new Response("p2p-voice signaling. WS: /room/<id>?cid=<clientId>", { status: url.pathname === "/" ? 200 : 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const h = new Headers(req.headers); h.set("X-Room-Id", m[1]);
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request(req, { headers: h }));
  },
};

const STALE_MS = 15000, PING = '{"type":"ping"}', PONG = '{"type":"pong"}';
// Room kind from id: "g-..." = group (max 5), anything else = 1:1 (max 2). Stored on first join.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Client pings are answered without waking the DO; the timestamp gives us lastSeen per socket.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }
  async subscribe(subscription, clientId) {
    await this.ctx.storage.put("sub:" + subscription.endpoint, { subscription, clientId, ts: Date.now() });
    const all = await this.ctx.storage.list({ prefix: "sub:" });
    if (all.size > 20) {
      const old = [...all].sort((a, b) => a[1].ts - b[1].ts).slice(0, all.size - 20).map(([k]) => k);
      await this.ctx.storage.delete(old);
    }
    return { count: Math.min(all.size, 20) };
  }
  async unsubscribe(endpoint) {
    await this.ctx.storage.delete("sub:" + endpoint);
    return { count: (await this.ctx.storage.list({ prefix: "sub:" })).size };
  }
  async notifyOthers(roomId, joinerCid) {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;
    const vapid = { publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY, subject: this.env.VAPID_SUBJECT };
    const payload = { title: "Собеседник на связи!", body: "К вашей комнате подключился участник", url: SITE + "#" + roomId, roomId };
    const subs = await this.ctx.storage.list({ prefix: "sub:" });
    await Promise.all([...subs].filter(([, v]) => v.clientId !== joinerCid).map(async ([k, v]) => {
      try {
        const r = await sendPush(v.subscription, payload, vapid);
        if (r.status === 404 || r.status === 410) await this.ctx.storage.delete(k);
        else if (!r.ok) console.log("push failed", r.status);
      } catch (e) { console.log("push error", e.message); }
    }));
  }
  info(ws) { return ws.deserializeAttachment() || {}; }
  live() { return this.ctx.getWebSockets().filter(w => !this.info(w).gone); }
  lastSeen(ws) {
    const t = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
    return Math.max(t, this.info(ws).seen || 0);
  }
  drop(ws, reason) {
    const a = this.info(ws); if (a.gone) return;
    ws.serializeAttachment({ ...a, gone: true });
    try { ws.close(4001, reason); } catch {}
    this.broadcast({ type: "peer-left", id: a.id, reason }, ws);
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const p of this.live()) if (p !== except) try { p.send(s); } catch {}
  }
  evictStale() {
    const now = Date.now();
    for (const ws of this.live()) if (now - this.lastSeen(ws) > STALE_MS) this.drop(ws, "stale");
  }
  async alarm() {
    this.evictStale();
    if (this.live().length) await this.ctx.storage.setAlarm(Date.now() + 2000);
  }
  async fetch(req) {
    const roomId = req.headers.get("X-Room-Id") || "";
    let kind = await this.ctx.storage.get("kind");
    if (!kind) { kind = roomId.startsWith("g-") ? "group" : "1:1"; await this.ctx.storage.put("kind", kind); }
    const max = kind === "group" ? 5 : 2;
    const q = new URL(req.url).searchParams;
    const cid = CID_RE.test(q.get("cid") || "") ? q.get("cid") : null;
    const nick = String(q.get("nick") || "player").slice(0, 32);
    this.evictStale();
    if (cid) for (const ws of this.live()) if (this.info(ws).cid === cid) this.drop(ws, "replaced"); // same client rejoining
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peers = this.live();
    if (peers.length >= max) {
      server.accept(); server.send(JSON.stringify({ type: "full", max })); server.close(4000, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, cid, nick, seen: Date.now() });
    server.send(JSON.stringify({ type: "welcome", id, kind, max, peers: peers.map(p => ({ id: this.info(p).id, nick: this.info(p).nick })) }));
    this.broadcast({ type: "peer-joined", id, nick }, server);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 2000);
    if (roomId) this.ctx.waitUntil(this.notifyOthers(roomId, cid));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    const a = this.info(ws); if (a.gone) return;
    ws.serializeAttachment({ ...a, seen: Date.now() });
    if (typeof msg !== "string" || msg.length > 65536) return;
    let data; try { data = JSON.parse(msg); } catch { return; }
    if (data.type === "ping") { ws.send(PONG); return; }
    if (!["offer", "answer", "ice"].includes(data.type) || typeof data.to !== "string") return;
    data.from = a.id;
    const out = JSON.stringify(data);
    for (const p of this.live()) if (p !== ws && this.info(p).id === data.to) p.send(out);
  }
  async webSocketClose(ws) { this.drop(ws, "closed"); }
  async webSocketError(ws) { this.drop(ws, "error"); }
}

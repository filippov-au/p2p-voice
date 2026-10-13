import { DurableObject } from "cloudflare:workers";
import { sendPush } from "./webpush.js";

const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SITE = "https://filippov-au.github.io/p2p-voice/";
const ALLOWED_ORIGINS = ["https://filippov-au.github.io"];

function cors(req) {
  const o = req.headers.get("Origin");
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
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

export class Room extends DurableObject {
  // Push subscriptions live in DO storage ("sub:<endpoint>") and survive the room being empty.
  async subscribe(subscription, clientId) {
    await this.ctx.storage.put("sub:" + subscription.endpoint, { subscription, clientId, ts: Date.now() });
    const all = await this.ctx.storage.list({ prefix: "sub:" });
    if (all.size > 20) { // cap per room: drop oldest
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
    const payload = { title: "Собеседник на связи!", body: "К вашей комнате подключился второй участник", url: SITE + "#" + roomId, roomId };
    const subs = await this.ctx.storage.list({ prefix: "sub:" });
    await Promise.all([...subs].filter(([, v]) => v.clientId !== joinerCid).map(async ([k, v]) => {
      try {
        const r = await sendPush(v.subscription, payload, vapid);
        if (r.status === 404 || r.status === 410) await this.ctx.storage.delete(k);
        else if (!r.ok) console.log("push failed", r.status, await r.text().catch(() => ""));
      } catch (e) { console.log("push error", e.message); }
    }));
  }
  async fetch(req) {
    const peers = this.ctx.getWebSockets();
    if (peers.length >= 2) return new Response("Room full", { status: 403 });
    const roomId = req.headers.get("X-Room-Id");
    const cidParam = new URL(req.url).searchParams.get("cid") || "";
    const cid = CID_RE.test(cidParam) ? cidParam : null;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, cid });
    server.send(JSON.stringify({ type: "welcome", id, peers: peers.map(p => p.deserializeAttachment()?.id) }));
    for (const p of peers) p.send(JSON.stringify({ type: "peer-joined", id }));
    if (roomId) this.ctx.waitUntil(this.notifyOthers(roomId, cid));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 65536) return;
    let data; try { data = JSON.parse(msg); } catch { return; }
    if (!["offer", "answer", "ice", "hello"].includes(data.type)) return;
    data.from = ws.deserializeAttachment()?.id;
    const out = JSON.stringify(data);
    for (const p of this.ctx.getWebSockets()) if (p !== ws) p.send(out);
  }
  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    const id = ws.deserializeAttachment()?.id;
    try { ws.close(1000); } catch {}
    for (const p of this.ctx.getWebSockets()) if (p !== ws) try { p.send(JSON.stringify({ type: "peer-left", id })); } catch {}
  }
}

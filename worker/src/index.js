import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
    if (!m) return new Response("p2p-voice signaling. WS: /room/<id>", { status: url.pathname === "/" ? 200 : 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  },
};

export class Room extends DurableObject {
  async fetch(req) {
    const peers = this.ctx.getWebSockets();
    if (peers.length >= 2) return new Response("Room full", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ type: "welcome", id, peers: peers.map(p => p.deserializeAttachment()?.id) }));
    for (const p of peers) p.send(JSON.stringify({ type: "peer-joined", id }));
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

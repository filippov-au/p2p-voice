// Protocol test: spawns the server and drives it with ws clients.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";

const PORT = 18787, ORIGIN = "https://filippov-au.github.io", SECRET = "test-secret";
const srv = spawn(process.execPath, [new URL("../index.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
  env: { ...process.env, PORT, ALLOWED_ORIGINS: ORIGIN, TURN_SECRET: SECRET, TURN_URLS: "stun:t.example:3478,turn:t.example:3478?transport=udp" },
  stdio: ["ignore", "pipe", "inherit"] });
await new Promise(r => srv.stdout.once("data", r));

function client(room, cid, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room/${room}?cid=${cid}&nick=${cid}`, { origin });
  const q = [], waiters = [];
  ws.on("message", d => { const m = JSON.parse(d); const w = waiters.shift(); w ? w(m) : q.push(m); });
  ws.next = () => q.length ? Promise.resolve(q.shift()) : new Promise((r, j) => { waiters.push(r); setTimeout(() => j(new Error("timeout")), 2000); });
  ws.opened = new Promise((r, j) => { ws.once("open", r); ws.once("error", j); ws.once("unexpected-response", (_, res) => j(new Error("HTTP " + res.statusCode))); });
  return ws;
}

try {
  // bad origin rejected
  await assert.rejects(client("roomAAAA1", "cidAAAA1", "https://evil.example").opened, /403/);

  const a = client("roomAAAA1", "cidAAAA1"); await a.opened;
  const wa = await a.next();
  assert.equal(wa.type, "welcome"); assert.equal(wa.kind, "1:1"); assert.equal(wa.max, 2); assert.deepEqual(wa.peers, []);
  const turn = wa.ice.find(x => x.username);
  assert.ok(wa.ice.some(x => x.urls.includes("stun:t.example:3478")));
  assert.equal(turn.credential, crypto.createHmac("sha1", SECRET).update(turn.username).digest("base64"));
  assert.match(turn.username, /^\d+:cidAAAA1$/);

  const b = client("roomAAAA1", "cidBBBB1"); await b.opened;
  const wb = await b.next(); assert.deepEqual(wb.peers, [{ id: wa.id, nick: "cidAAAA1" }]);
  const pj = await a.next(); assert.equal(pj.type, "peer-joined"); assert.equal(pj.id, wb.id);

  // targeted relay with "from"
  b.send(JSON.stringify({ type: "offer", to: wa.id, sdp: "x" }));
  const off = await a.next(); assert.equal(off.type, "offer"); assert.equal(off.from, wb.id); assert.equal(off.sdp, "x");
  // ignored types are not relayed; ping -> pong
  b.send(JSON.stringify({ type: "evil" })); a.send('{"type":"ping"}');
  assert.equal((await a.next()).type, "pong");

  // third peer in 1:1 -> full
  const c = client("roomAAAA1", "cidCCCC1"); await c.opened;
  assert.deepEqual(await c.next(), { type: "full", max: 2 });

  // same cid rejoin replaces old socket
  const b2 = client("roomAAAA1", "cidBBBB1"); await b2.opened;
  const left = await a.next(); assert.equal(left.type, "peer-left"); assert.equal(left.reason, "replaced");
  const wb2 = await b2.next(); assert.equal(wb2.type, "welcome"); assert.equal(wb2.peers.length, 1);
  assert.equal((await a.next()).type, "peer-joined");

  // group room
  const g = client("g-roomGGGG", "cidGGGG1"); await g.opened;
  const wg = await g.next(); assert.equal(wg.kind, "group"); assert.equal(wg.max, 5);

  for (const w of [a, b2, g]) w.close();
  console.log("signal tests: ok");
} finally { srv.kill(); }

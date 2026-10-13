# p2p-voice
Low-latency P2P voice + text chat for gaming (2 peers). WebRTC Opus mono 48k, ~40 kbps, 10 ms ptime, FEC+DTX; chat over DataChannel; public STUN only (no TURN).
- `docs/` — static frontend (GitHub Pages).
- `worker/` — Cloudflare Worker + Durable Object signaling (`/room/<id>` WebSocket, max 2 peers).
Open the site, click **Create room**, share the link (room secret is in the URL hash).

# p2p-voice
Low-latency P2P voice + text chat for gaming (2 peers). WebRTC Opus mono 48k, ~40 kbps, 10 ms ptime, FEC+DTX; chat over DataChannel; public STUN only (no TURN). Echo cancellation, noise suppression and auto gain are always on.
- `docs/` — static frontend (GitHub Pages).
- `worker/` — Cloudflare Worker + Durable Object signaling (`/room/<id>` WebSocket, max 2 peers).
Open the site, click **Create room**, share the link (room secret is in the URL hash).

## Features
- **Screen Wake Lock** (`docs/wakelock.js`): screen stays on while the call is connected; re-acquired when the tab becomes visible again.
- **Tones** (`docs/tones.js`): Web Audio connect (440→587 Hz) / disconnect (440→330 Hz) beeps, no audio files.
- **Web Push** (`docs/sw.js`, `docs/push.js`, `docs/manifest.webmanifest`, `worker/src/webpush.js`): always on, no toggle. Permission is asked on the **Create room** click (or the first tap in a room opened from a link); if granted, the browser subscribes silently, if denied nothing happens. When somebody else joins that room you get a push even if the tab is closed. iOS: Safari 16.4+, only after "Add to Home Screen" and opening from the icon.

## Worker API
- `WS /room/<id>?cid=<clientId>` — signaling (max 2 peers).
- `GET /api/push/vapid-public-key` → `{publicKey}`
- `POST /api/push/subscribe` `{subscription, roomId, clientId}` — stored in the room's Durable Object (survives an empty room; max 20 per room; deleted on 404/410 from the push service).
- `POST /api/push/unsubscribe` `{roomId, endpoint}` (kept for API use; the UI doesn't call it)

## VAPID setup (Worker env)
| var | where |
|---|---|
| `VAPID_PUBLIC_KEY` | `worker/wrangler.toml` `[vars]` |
| `VAPID_SUBJECT` | `worker/wrangler.toml` `[vars]` (`mailto:…`) |
| `VAPID_PRIVATE_KEY` | secret: `npx wrangler secret put VAPID_PRIVATE_KEY` (never commit) |

```sh
cd worker
npm run gen-vapid            # prints a new key pair
npm test                     # RFC 8291 encryption vector + VAPID JWT check
npx wrangler@3 deploy
```
For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`. Rotating keys invalidates existing subscriptions (users get re-subscribed on their next visit).

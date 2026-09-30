# Push notifications (WP3.3)

When an agent turn finishes (`done`, `error`, `interrupted`), the server owner's installed PWA /
browser gets a Web Push; tapping it opens that session. Cancelled turns (your own action) don't notify.

**Privacy.** The push payload is ids only: `{type:"agent-turn", sessionId, turnId, status}`. The
notification text is generic ("Your agent finished" / "Agent needs attention"). No prompt, answer,
title or note content ever goes through Apple/Google/Mozilla.

## Setup
1. `npm run gen-vapid -w @prism/server` — prints a keypair (never writes it anywhere).
2. Put it in `apps/server/.env`:
   ```
   VAPID_PUBLIC_KEY=...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com   # optional; defaults to mailto:$OWNER_EMAIL
   ```
3. Restart the server (pm2 `prism-server` does not hot-reload). Without keys push is simply off
   (`GET /api/push/vapid-public-key` → 503, the Settings section explains it).
4. Web build must be deployed (service worker imports `push-sw.js`). Settings → Account → "Notify me
   when an agent finishes" → toggle on → "Send a test notification".

Rotating the private key invalidates every subscription: re-toggle on each device.

## iOS
Web Push on iPhone/iPad works **only for an installed PWA** (Share → Add to Home Screen, open it from
the Home Screen; iOS 16.4+). In Safari tabs the Settings toggle shows install guidance instead.

## API (server owner only, like `/api/agent`)
- `GET /api/push/vapid-public-key` → `{publicKey}` (503 when unconfigured)
- `POST /api/push/subscribe` `{endpoint, keys:{p256dh, auth}}` — idempotent upsert
- `DELETE /api/push/subscribe` `{endpoint}`
- `POST /api/push/test` — content-free test ping → `{sent, pruned, failed}`

Subscriptions live in `push_subscriptions`; 404/410 from the push service prunes the row, other
failures increment `failures` and drop it at 5 (a success resets).

## Design notes
- `apps/server/src/push.ts` — `web-push` (lazy import; RFC 8291/8292 crypto is not worth hand-rolling),
  injectable sender for tests, `notifyTurnEnd()` seam called from `agent-sessions.ts` (fire-and-forget).
- Service worker stays `generateSW`; `push` + `notificationclick` live in `apps/web/public/push-sw.js`
  loaded with Workbox `importScripts`, so precache and `navigateFallbackDenylist` are unchanged.
- Click → focuses an open window and postMessages the id, else opens `/agent/<sessionId>` (a client
  route; the server SPA-falls back to `index.html`).
- **WP3.2 handoff:** `apps/web/src/push/deeplink.ts` exposes `takePendingAgentSession()` /
  `onAgentSessionRequest(cb)` and dispatches a `prism:open-agent-session` DOM event. The Agent view
  should open that session on mount and on the event. Until then the id is held, nothing else happens.
- Native (WP2.2) build: no web push registration (`PushProvider` gets `null`). APNs (WP5.3) implements
  the same `PushClient` seam in core.

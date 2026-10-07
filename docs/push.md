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

## APNs (native iOS app)

The iOS Prism Client gets agent-turn notifications through Apple Push Notification service, sent by the
server next to web push (`notifyTurnEnd()` → `src/apns.ts`). Web push is unaffected either way.

**Privacy.** Same contract as web push: ids + generic text only. The APNs body is exactly
```json
{"aps":{"alert":{"title":"Prism","body":"Your agent finished"},"sound":"default","thread-id":"<sessionId>"},
 "type":"agent-turn","sessionId":"<sessionId>","turnId":"<turnId>","status":"done|error|interrupted",
 "url":"/agent/<sessionId>"}
```
(`body` is "Agent needs attention" for `error`/`interrupted`). Headers: `apns-topic` = `APNS_TOPIC`,
`apns-push-type: alert`, `apns-priority: 10`, `apns-expiration` = now + 24 h, `apns-collapse-id` =
`agent-<sessionId>` (a newer turn of the same session replaces the older notification). No prompt, reply,
title or note content ever goes to Apple. Device token values are never logged — only an 8-hex sha256 prefix.

### Owner setup
1. Apple Developer portal → Certificates, Identifiers & Profiles → **Keys** → "+" → enable **Apple Push
   Notifications service (APNs)** → download `AuthKey_<KEYID>.p8` (downloadable once). Note the 10-character
   **Key ID** and your 10-character **Team ID** (Membership details). One token-based key works for every
   app of the team and for both environments.
2. Copy the `.p8` to the server host outside the repo, owned by the pm2 user, and lock it down:
   `chmod 600 AuthKey_<KEYID>.p8`. A file readable by group/others is **refused** (APNs stays off and the
   server prints `[apns] WARNING: APNs is DISABLED — … chmod 600`).
3. In `apps/server/.env` (host-only; none of these is editable through `PUT /acl/server/config`):
   ```
   APNS_KEY_PATH=/Users/<you>/.prism/AuthKey_XXXXXXXXXX.p8
   APNS_KEY_ID=XXXXXXXXXX
   APNS_TEAM_ID=YYYYYYYYYY
   APNS_TOPIC=com.benjaminlife.prism.client   # optional; this is the default (the app's bundle id)
   ```
4. Restart pm2 `prism-server`. The boot banner prints `apns: ON (topic …)`, `apns: off (… unset)`, or the
   warning above. With the three required values unset, APNs is simply off.

### Sandbox vs production
The app reports which APNs environment its token belongs to and the server sends to the matching host:
`sandbox` → `api.sandbox.push.apple.com` (Xcode debug builds with the development `aps-environment`
entitlement), `production` → `api.push.apple.com` (**TestFlight and App Store builds — TestFlight uses the
PRODUCTION environment**). A token sent to the wrong environment answers `400 BadDeviceToken` and is
deleted; the app re-registers on its next launch.

### API (iOS client contract)
All under `/api/push`. Since wave 2A the router admits **every signed-in user** (their own device rows;
agent-turn pushes still only reach the session owner), and these three additionally **require the app's
device credential** (`Authorization: Bearer pd_…`). A browser session cookie, even the owner's, gets
`403 {"error":"device_token_required"}` — an APNs token addresses one installed app, so it is bound to
that app's device credential; capability links and anon get `403 {"error":"forbidden"}`.
No CSRF/Origin check applies (the credential is a bearer header, never ambient). The app's side is
`apps/web/src/native/apnsPush.ts` (register on the user's toggle and on every launch while on, `DELETE`
when turned off; the choice is kept per account on the device).
- `POST /api/push/apns` `{token, environment}` — `token` = the APNs device token as hex (even length,
  64–200 chars, case-insensitive, stored lowercase); `environment` = `"sandbox" | "production"`.
  → `200 {ok:true, apnsEnabled:boolean}`; `400 bad_request` on a bad body. One row per device: calling it
  again replaces the token; the same token registered by a new device credential moves to it. Accepted
  even while APNs is off on the server (`apnsEnabled:false`), so it starts working once configured.
- `DELETE /api/push/apns` — removes this device's registration → `{ok: <a row was removed>}`.
- `POST /api/push/apns/test` — a content-free test notification (`{"aps":{"alert":{"title":"Prism",
  "body":"Notifications are working"},"sound":"default"},"type":"test"}`) to THIS device only →
  `{result:"sent"|"pruned"|"failed"}`; `503 apns_disabled`, `404 not_registered`.

There is no `GET /api/push/status` route.

**Lifecycle.** Rows live in `apns_tokens` (`device_id` PK → `device_tokens.id`, token, environment, owner
email, vault id, created/last seen). Revoking the device — Settings → Signed-in devices,
`DELETE /auth/devices/:id`, the app's own sign-out (`POST /auth/device/revoke`), a password change that
revokes other devices — deletes its APNs row (`revokeDevice`). Sends also join `device_tokens`, so a
revoked or expired device is never pushed to.

**Delivery.** `src/apns.ts`: ES256 provider JWT (`kid` = key id, `iss` = team id, `iat`) signed with
`crypto.sign` (no dependency), cached and re-minted after 50 min; one long-lived HTTP/2 session per APNs
host, reopened after close/goaway/error; 10 s per request; at most 4 requests in flight. Responses:
200 sent · 410 / 400 `BadDeviceToken` / 400 `DeviceTokenNotForTopic` → row deleted · 403
`ExpiredProviderToken` → re-mint once and retry (never sooner than 20 min after the last mint — Apple's
`TooManyProviderTokenUpdates` limit) · 429 / 5xx / network error / timeout → up to 2 retries with capped
exponential backoff (≤ 5 s) · anything else → failed, logged. Tests: `apps/server/test/apns.test.ts`
(fake transport + a local cleartext HTTP/2 server; nothing reaches Apple).

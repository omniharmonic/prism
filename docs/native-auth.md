# Native sign-in (device tokens)

How a native Prism client (the Tauri laptop app, the iPhone app, a CLI) signs in to
a Prism Server over the public internet. It never holds a vault token and never
uses the loopback-only `COLLAB_TOKEN` owner path. Instead it runs **OAuth 2.0 for
native apps** ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)) with **PKCE
S256** ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)). The user signs in
with the existing web login in the system browser, and the app receives a
revocable per-device bearer token.

Server code: `apps/server/src/auth/device.ts` (token logic) and
`apps/server/src/routes/device.ts` (HTTP). Tests: `apps/server/test/device-auth.test.ts`.

## Flow

```
app                               system browser                         Prism Server
 │ verifier = random(32B) b64url
 │ challenge = b64url(sha256(verifier))
 │── open ──▶ GET /auth/device/authorize?client_id=prism-native
 │              &redirect_uri=prism://auth/callback&code_challenge=…
 │              &code_challenge_method=S256&state=…&label=Ben's iPhone ──▶ validate, park request
 │                                      signed out? → /?next=/auth/device/continue (web login:
 │                                      password, owner magic link) → /auth/device/continue
 │                                      consent: "Sign in Prism on Ben's iPhone?"  [Approve]
 │◀── prism://auth/callback?code=…&state=… ─────────────────────────────── (302)
 │ check state
 │── POST /auth/device/token  grant_type=authorization_code, code, code_verifier,
 │                            redirect_uri, client_id=prism-native ─────────────────────▶
 │◀── { access_token: "pd_…", token_type: "Bearer", expires_in, device_id } ──────────────
 │ store in Keychain; send  Authorization: Bearer pd_…  on every request
```

## Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /auth/device/authorize` | browser | Starts the flow. Params: `client_id=prism-native` (or `omni-native`, see Clients), `redirect_uri`, `code_challenge` (43-char base64url), `code_challenge_method=S256` (`plain` is refused), `state` (recommended, ≤512 chars, echoed), `label` (device name, ≤80 chars), optional `response_type=code`. |
| `GET /auth/device/continue` | browser | Where the web login returns. Internal; clients never call it. |
| `POST /auth/device/approve` | browser session + CSRF | The consent form. Redirects to `redirect_uri?code=…&state=…`, or `?error=access_denied&state=…` on Deny. |
| `POST /auth/device/token` | none (PKCE) | Form-encoded or JSON body. Returns `{access_token, token_type:"Bearer", expires_in, device_id}` with `Cache-Control: no-store`. Rate-limited to 20 per 10 minutes per client IP. Errors follow OAuth: `400 invalid_request / invalid_grant / unsupported_grant_type`, `401 invalid_client`. |
| `POST /auth/device/revoke` | see below | `token=pd_…`: revokes that token, always 200 (RFC 7009 style). `device_id=…` with a session or device token: revokes your own device, or any device if you are the server owner. An empty body with `Authorization: Bearer pd_…` revokes the calling token (sign out). |
| `GET /auth/devices` | session or device token | Your live devices: `{devices:[{id,label,clientId,email,createdAt,lastSeenAt,expiresAt,current}]}`. The server owner may add `?all=1`. |
| `DELETE /auth/devices/:id` | session or device token | Revoke your device (the owner may revoke any). Someone else's device returns 404. |

Errors before consent are **never redirected**, whatever caused them: an
unregistered `redirect_uri`, an unknown `client_id`, another app's custom scheme, `plain` or a missing PKCE
challenge, a bad `response_type`, or an over-long `state`. Each gets a 400 error
page, and nothing is parked or set as a cookie. Error parameters are never added
to a URL the requester supplied. Only a completed consent redirects: `code` on
Approve, `error=access_denied` on Deny.

### Redirect URIs

- Exact string match against `DEVICE_REDIRECT_URIS`, comma-separated (default
  `prism://auth/callback,omni://auth/callback`). No query and no trailing slash variants
  are accepted. A server that sets the variable itself must list every URI it wants.
  Add a universal link (an `https://…` URL your app claims) here for the stronger
  iOS option.
- Desktop loopback (RFC 8252 §7.3): exactly `http://127.0.0.1:<port>/callback` or
  `http://127.0.0.1:<port>/`, or the same with `[::1]`.
  - The port must be explicit and at least 1024.
  - The URI may not contain a query, fragment or userinfo.
  - `localhost` is not accepted.
  - Set `DEVICE_ALLOW_LOOPBACK=false` to disable loopback redirects.

### Clients

| `client_id` | App | Its custom-scheme redirect | Accepted |
|---|---|---|---|
| `prism-native` | Prism Client (Mac, iPhone, iPad) | `prism://auth/callback` | always |
| `omni-native` | Omni (`docs/omni-module.md`) | `omni://auth/callback` | only while `OMNI_ENABLED=true` |

Both run the same flow and get the same kind of `pd_…` token; the id only says which app a
device is (`clientId` in `GET /auth/devices`, and the default label: "Prism app" / "Omni
app"). Rules, all checked before any login and all answered with a 400 page:

- An unknown `client_id` is refused. With the Omni module off, `omni-native` is unknown.
- A custom scheme belongs to its app: `prism://…` is honoured only for `prism-native`,
  `omni://…` only for `omni-native`. Loopback redirects and other allowlisted URIs
  (a universal link) work for either. This check only narrows the allowlist.
- A code is bound to the client that asked for it; redeeming it under the other id is
  `invalid_grant` and burns the code.

**Universal links never capture this flow.** The server's apple-app-site-association file
(`routes/app-links.ts`) excludes `/auth/*` and `/accept-invite`, and the client's link
handler (`apps/client/src-tauri/src/links.rs`) refuses every path outside
`/page`, `/collab`, `/inbox`, `/agent` and everything under `prism://auth` — the authorize
and consent pages must open in the system browser, and a `prism://auth/callback` redirect
is consumed only by the sign-in session that started it (docs/client-app.md § Links and New
Page). If a redirect URI is ever made a universal link, it must stay out of that allowlist.

### Consent page

The `label` is chosen by the client, so the page presents it as a claim: *An
app calling itself "<label>" wants to sign in to Prism as <email>*. The
validated redirect target is shown prominently beneath it, either the scheme
(`prism://auth/callback`, "an app on this device") or `127.0.0.1:<port>/callback`
("an app on this computer").

## Using the token

- **HTTP:** `Authorization: Bearer pd_…` on `/api/*`, `/acl/*`, `/auth/me`,
  `/auth/profile`, `/auth/change-password` and `/auth/devices`. The token resolves
  to exactly the actor a browser session for that email would get: the same
  per-vault role and grants, recomputed on every request. Pick the vault with
  `X-Prism-Vault` as the web app does. The owner's token gets the owner
  passthrough.
- **Collab WebSocket (`/collab`):** pass the device token as the Hocuspocus
  provider's `token` parameter. `resolveLevel` treats it like a session:
  `effectiveLevel` over the user's grants, read-only below `edit` (suggest-only
  enforcement; `COLLAB_SUGGEST_ENFORCED=false` restores the old read-only-below-`suggest`
  rule). A suggest-level user sends suggestions and comments to
  `POST /api/collab/:id/commands` with the same bearer token.
- **CORS:** requests from `tauri://localhost` and `http://tauri.localhost` (override
  with `NATIVE_ORIGINS`) get CORS **without credentials**. Use the bearer header,
  not cookies. The cookie CORS rule for `APP_ORIGIN` is unchanged.
- **SSE:** `EventSource` cannot set headers, so stream with `fetch` plus a
  `ReadableStream`.

## Token lifetime

- The format is `pd_` plus 32 random bytes in base64url. Only the SHA-256 hash is
  stored.
- **90-day sliding idle expiry** (`DEVICE_TOKEN_IDLE_DAYS`). Use extends it, at
  most one write per minute per device.
- **365-day absolute cap** (`DEVICE_TOKEN_MAX_DAYS`). After that the app must sign
  in again.
- Why: a device in daily use shouldn't nag, but a lost or idle device dies on its
  own, and even an actively used stolen token has a hard end. Revocation takes
  effect immediately, because it is a row update.
- Authorization codes: 5-minute lifetime, single use, bound to `client_id`,
  `redirect_uri` and the S256 challenge. Any redemption attempt burns the code. A
  replayed code also **revokes the token it already produced** (RFC 6749 §4.1.2).
  The single-use claim and the mint are one SQLite transaction, and the claim writes the
  device id in the same statement that marks the code used (`issueDeviceTokenClaimed`): a
  code never reads "used" without naming its device, so a replay at any moment revokes it,
  and a failure after the mint leaves no device. `/auth/pair/token` follows the same rule.

## Passwords and credentials created through a device

- **`/auth/change-password` with a device token** always requires the current
  password. If the account has no password yet (an owner who signs in only by
  magic link), a device token gets `403 password_setup_requires_browser`: the
  first password can only be set from a browser session. A stolen device token
  therefore cannot create a new way to log in.
- **Wrong current passwords are rate-limited** (session or device alike): 5 failures per
  account and 10 per client address per 10 minutes; past either, the route answers
  `429 rate_limited` + `Retry-After`, even for the right password. Successes are not counted.
- **A successful password change revokes the account's other device tokens.** The
  calling device stays signed in. A change made from a browser session revokes
  every device. The response carries `revokedDevices: <n>`.
- **MCP tokens** minted through `/api/mcp/token` while authenticated by a device
  token record that device (`mcp_tokens.device_id`). Revoking the device, whether
  by id, by token, through a replayed code, or by a password change, also revokes
  those hub tokens through the `mcp-token` revoker (the hub enforces it within
  about 60s). If a hub revoke fails, it is logged, and the token stays unrevoked
  and visible in the MCP token list so it can be revoked by hand.
- **Capability (share) links** created through a device **persist** after the
  device is revoked. They are standalone shares owned by the account, the same as
  links created from a browser session. Remove them in the Share dialog.

## Notes for client implementers

- Use `ASWebAuthenticationSession` on iOS and macOS. On Android use a Custom Tab.
  On desktop, open the system browser with a loopback listener or the `prism://`
  deep link. Always check that `state` matches.
- The browser leg needs the user's web login. If the owner uses the magic link, it
  must be opened in the **same browser** so the parked request is found. Otherwise
  the user just starts again from the app once signed in.
- **The emailed link opens in the browser, not in the app's sign-in sheet.** The sheet
  (`ASWebAuthenticationSession`, non-ephemeral) shares the browser's cookies, so the web
  login's "link sent" page waits for the session: while it shows, and only when it was
  reached with `?next=/auth/device/continue`, it asks `GET /auth/me` (every 3 s, on
  focus / `visibilitychange`, and from an "I've opened the link — continue" button) and,
  once signed in, goes to `postLoginTarget()` — that one fixed path. The server then shows
  the CONSENT page as always (session + this browser's parked request); nothing is approved
  by waiting. The browser that opened the link is sent to the same consent page by
  `/auth/callback`; approving THERE sends the code to `prism://auth/callback` outside the
  sheet, where the app ignores it (`links.rs`) — approve in the app's sheet. A new invitee first
  accepts the invite in the browser, then starts sign-in from the app.
- Store the token in the Keychain or Keystore. A single `401` is not proof the token is
  dead: confirm with `GET /auth/me` before dropping it, and never start the flow again
  without the person asking — each run mints a device (six in an hour on the first iOS run).
- Sign-out: call `POST /auth/device/revoke` with the token.

## Known limits

- A custom URL scheme can be claimed by another app on the same device. PKCE does
  not help when the attacker starts the flow, so the consent page names the device
  and warns the user. Prefer a universal-link redirect for iOS production builds.
- Revoking a token blocks new requests and new collab connections at once. A collab
  WebSocket that is already open stays open until it reconnects, the same as for
  sessions.

## Client transport (native build of `apps/web`)

The laptop and iPhone shells (Tauri) load the same React UI as the PWA, built in
**native mode** and served from `tauri://localhost`. The shell that implements this is
`apps/client` ("Prism Client"). It uses the loopback redirect and the Keychain; see
[client-app.md](client-app.md). It talks to the Prism Server at a
configured origin with the device token above. Nothing on the server changed for this.

```bash
npm run build:native -w @prism/web   # -> apps/web/dist-native/  (no service worker, no manifest)
npm run verify:native -w @prism/web  # builds it + asserts the invariants below
node --import tsx apps/web/scripts/verify-sse.ts   # SSE helper behavior
```

`VITE_PRISM_NATIVE=1` is baked in by `--mode native`. The PWA build (`npm run build`)
is unchanged: same-origin, session cookie, service worker.

### Host hook: `window.__PRISM_HOST__`

The shell injects this **before the app script runs** (Tauri `initialization_script`):

```ts
interface PrismHost {
  apiOrigin?: string;            // "https://prism.example.com"; else VITE_PRISM_API_ORIGIN at build time
  getToken(): string | null | undefined | Promise<string | null | undefined>; // Keychain/Keystore `pd_…`
  onUnauthorized?(): void | Promise<void>;  // the token is DEAD (401 confirmed by /auth/me): forget it. Must not sign in.
  signIn?(): void | Promise<void>;          // run the PKCE flow — only for a person's press; one at a time
  onSignedOut?(): void | Promise<void>;     // user signed out; token already revoked server-side
}
```

- `getToken` is called per request (and per collab reconnect), so a rotated token is
  picked up without a reload.
- After a successful sign-in the shell reloads the webview, or dispatches
  `window.dispatchEvent(new Event("prism:host-token"))`; the sign-in screen reloads on it.
- **Auth gate:** `main.tsx` calls `/auth/me` with the bearer. No token skips the call.
  No token, or a token `/auth/me` refuses, renders "Sign in to Prism" (`NativeSignInScreen`),
  whose button calls `host.signIn()` — the ONLY thing that starts a sign-in.
- **When a session ends** (`src/native/sessionGuard.ts`; `npm run verify:session -w @prism/web`):
  1. One 401 is a suspicion. The token that was refused is asked one question, `GET /auth/me`
     with that same token. 401 from `/auth/me` = dead. 200 + `authenticated:true` = alive,
     nothing happens. Anything else (no answer, 5xx, a proxy's page) = unknown, nothing
     happens. One question at a time; a burst of 401s asks once. A 401 for a token that is
     no longer the current one is ignored.
  2. A dead token is forgotten once (`onUnauthorized`), the read cache is emptied, and the
     page reloads into the sign-in screen. Nothing starts a sign-in by itself: every sign-in
     mints a device.
  3. Once the page has sent the token, a request that would go out with NO token is not
     sent (it is answered 401 locally) and the page reloads into the sign-in screen.
  At launch a 401 on `/auth/me` waits for that answer: alive → asked once more; unknown →
  "can't reach the server" (`ReconnectScreen`), never the sign-in screen.
- **Sign-out** (`logout()`): `POST /auth/device/revoke` with the bearer, then
  `onSignedOut`, then the cache is cleared.

### One request helper: `apps/web/src/transport.ts`

`serverFetch(pathOrUrl, init)` is the only way the app reaches the server.

| | PWA | native |
|---|---|---|
| origin | same-origin (`VITE_GATEWAY_URL` in dev) | `host.apiOrigin` |
| credentials | `include` (session cookie) | `omit`, never cookies |
| auth | cookie (+ `Capability` header for share links) | `Authorization: Bearer pd_…`, only to the configured origin |
| 401 | unchanged | confirmed with one `/auth/me`; only a dead token → `host.onUnauthorized()` + reload |
| no token | n/a | after one was sent: not sent, reload into sign-in |

Routed through it: `parachute/rest.ts` (all note/tag/vault/graph/search/history calls),
`offline/outbox.ts` replay, `config.ts` (`/auth/me`, login, register, invite-info,
magic link, logout), `account.ts`, `collab/grant.ts` (`/acl/*`, `/api/*`, `/auth/me`,
`/api/vaults`), `collab/CollabDoc.tsx` (note read, federated lookup), `publish/PublicationView.tsx`,
and, through the `@prism/core` seam `setServerFetch()` (`lib/transport/serverFetch.ts`),
the governance client (`network/governance/api.ts`) and propose-for-review client
(`lib/governance/review.ts`). Deliberately left on bare `fetch`: the cross-origin
federation pairing call to a *peer* server, and the legacy public `ShareView`
(talks to a vault URL directly). `verify:native` fails if a new bare `fetch()` appears.

Native limits: password-gated public `/p/:slug` sites rely on an unlock *cookie*, which a
native client cannot hold. Open those in the system browser.

### SSE: `streamSSE` / `streamServerSSE`

`EventSource` cannot set `Authorization`, so use
`streamSSE(url, { headers, lastEventId, onEvent, signal, onOpen, onError, fetch })`
from `@prism/core` (fetch + `ReadableStream`). It parses CRLF/multi-line events and
comments, reconnects with jittered exponential backoff (honoring server `retry:`),
resumes with `Last-Event-ID`, treats 4xx (except 408/425/429) as fatal, and stops on
`onEvent` returning `"stop"` or on abort. In the web app use
`streamServerSSE("/api/agent/…", opts)` from `transport.ts` to get origin + bearer. It
works in both modes. The agent chat (WP3.2, `apps/web/src/agent/HttpAgentClient.ts`)
is the first consumer: it streams `/api/agent/sessions/:id/stream?after=N` this way
(see CLAUDE.md "Agent client seam + chat UI").

### Collab token

`CollabDoc` opens `HocuspocusProvider({ url: collabWsUrl(), token })`. `collabWsUrl()` is
the configured origin with `http→ws`. `token` is the capability token if present, else the
device token as an async function (resolved on every (re)connect) in native, else the
`"session"` placeholder in the PWA.

### Read-through cache (both modes)

`offline/readCache.ts`, IndexedDB `prism-read-cache`. `rest.ts` routes GETs of
`/notes*`, `/tags*` and `/vault*` (not searches) through it, network-first. Online: revalidate
and refresh the entry (403/404/410 evict it). Offline (`navigator.onLine` false or a
fetch `TypeError`): serve the last good response, else fail as before. The key is
server + vault + workspace + capability-link + path. Bounded LRU: 300 entries / 64 MB,
a body over 16 MB is not cached. Cleared on sign-out, when a native session ends, and when the signed-in
email changes. The write outbox (`offline/outbox.ts`) is independent and works in both modes.

## New devices need an existing device (one door, 2026-10-15 — review R2-1)

A magic link can be read by anything that reads the owner's mailbox, so a browser session
alone no longer signs a NEW device in once the owner already has one:

- **Bootstrap** (the owner has zero live device tokens, or Omni is off): consent works as
  before.
- **Otherwise** pressing Approve on the consent page parks the request and shows "Approve this
  sign-in on a device you already use" (the page polls `/auth/device/wait`). Prism creates a
  `device-sign-in` approval (payload: `clientId`, the client's CLAIMED `label`, `redirectUri`,
  `requestedAt`, coarse `ipHint` / `userAgentHint`) in the Omni app's Needs you. Approving it
  needs a `pd_` device credential and the exact digest, like any approval; it cannot be edited
  or proposed through the hook. Approve → the waiting browser gets its code; Deny or 10
  minutes → `access_denied`. Code: `src/auth/device-confirm.ts`, `routes/device.ts`.
- **Revocation by session is refused** (`DELETE /auth/devices/:id`, `POST /auth/device/revoke`
  by id → 403 `device_required`), so a stolen session cannot empty the account to reopen
  bootstrap. Revoke from a device; revoking with the token itself (RFC 7009) still works. If
  every device is lost, wait for the idle expiry or revoke on the Mini directly.
- Session ids are stored hashed; plaintext rows are rehashed at startup.
- Prism sign-in mail (from `MAGIC_FROM` with a sign-in subject, or carrying an
  `/auth/callback|device …token|code=` link) is never ingested into the vault.

### Round 3 (review C1, I1, M1, M2, M5)
- **Bootstrap** (consent without an existing device's approval) is open only when the account
  has NEVER had a device, or its last device stopped being live (revoked or expired) more than
  **24 h** ago and not through a session-triggered action (`device_account_history`:
  `first_device_at`, `last_live_until`, `last_end_via`; `db.deviceBootstrapOpen`). With Omni
  off and bootstrap closed, a new sign-in is refused (there is no device to approve from).
- **Sessions cannot empty the account:** `/auth/set-password` refuses once a password exists
  (409 `password_exists`; change it with the current one), a password change made with a
  session revokes no device (`revokedDevices: 0`), and per-device revocation is device-only.
  The PWA hides Revoke for browser sessions and explains why.
- **Matching code:** the waiting page and the Omni card show the same 6-digit code (HMAC of
  the parked request id); approve only if they match. Only ONE device sign-in may wait at a
  time (a second gets a 403 page). The client-IP hint is believed only when the request came
  for the tunnel's public host; otherwise "this Mac or the local network". Hints are claims.
- The approval never outlives the parked request; denying it also needs a device.

### Round 4 (review R4)
- **Invites never replace a password (I-a):** `/auth/invite` refuses the owner's own address and
  any account that already has a password (409 `account_exists`); `/auth/register` refuses (409,
  before the invite is consumed — nothing changes) when the account already has a password.
- **Approval lifetime (M-a):** the approval expires at min(10 min, the parked request's expiry);
  a request with under a minute left is not parked (start again).
- **Location hints are claims (M-b):** the card reads "reported from … (unverified)". Any local
  process can forge both the client-IP header and Host, so the hint is never evidence; the
  matching code and the one-at-a-time rule are the check.
- **One at a time (M-c):** while a sign-in waits, a new one gets "Another sign-in is already
  waiting for approval — the waiting request is NOT this one. Deny it in Omni, then try again."
  No replacement (an attacker could displace the owner's own request). **Known limit:** whoever
  can park requests (a lifted session) can keep re-parking after each denial — a repeatable
  denial of new sign-ins, never a sign-in. Revoke the session (sign out everywhere) to end it.
- **What starts the 24 h clock (M-d):** only a device-credential revocation or a natural expiry.
  A used-code replay (`via: replay`) or a token-possession revoke (`via: token`) never does — the
  account then stays closed to bootstrap until a device is signed in through approval (or the
  operator intervenes on the Mini).

## Pairing a phone with a QR code (decision D-G)

The owner signs a phone in without typing a server address or a password on it. It is a
reversed device-authorization grant (RFC 8628 turned around) that ends in the **same** `pd_`
device token as the PKCE flow: minted by the same `issueDeviceToken`, the same row in
Signed-in devices, the same lifetimes, revocation and one-door rule. "Enter server address" +
PKCE stays the fallback, and the way in for everyone but the server owner.

```
Mac (owner: session or pd_)          Prism Server                          Phone (Prism app)
"Pair a phone" ─ POST /auth/pair/start ─▶ pairing {sha256(code), 5 min}
◀─ {pairingId, link, origin} ─ QR: prism://pair?v=1&s=<APP_ORIGIN>&c=<code>
                                                                Camera → opens Prism → pairing.rs
                                                                native "Pair with <origin>?" [Pair]
                                                                GET /health?live=1
                                     ◀─ POST /auth/pair/claim {code, code_challenge, label, platform}
                                     claimed ─────────────────────▶ {claimId, checkCode, interval}
GET /auth/pair/:id (polled) ◀─ "A device calling itself “Sam's iPhone”…"   shows checkCode 0472
owner types 0472 ─ POST /auth/pair/:id/approve {checkCode} ─▶ approved
                                     ◀─ POST /auth/pair/token {claim_id, code_verifier} (every 2 s)
                                     issueDeviceToken ────────────▶ {access_token: pd_…, device_id}
                                                                Keychain; a fresh app saves the server
```

| Route | Auth | Behaviour |
|---|---|---|
| `POST /auth/pair/start` | server owner as a person: session or `pd_` (never a PAT, a link, MCP or the loopback token); `csrfRefusal` | 409 `not_reachable` unless `APP_ORIGIN` passes `reachableOrigin` (https, not loopback, not a placeholder) — a QR never carries an address a phone can't open. Ends the account's earlier open pairings. 10 per 10 min per account. → `{pairingId, link, origin, expiresAt, approveNeedsDevice}`. |
| `GET /auth/pair/:id` | the creator | `{status, label?, platform?, expiresAt, approveNeedsDevice}`. Status: `pending · claimed · approved · completed · denied · contested · failed · replaced · expired`. The check code is never sent here: the owner reads it from the phone. |
| `POST /auth/pair/:id/approve` | the creator, CSRF, `{checkCode}` | Only from `claimed`. A wrong check code → 400 `wrong_check_code {triesLeft}`; the third ends the pairing (`failed`). **One door:** once the owner has a live device (`needsDeviceConfirmation`), a browser session gets 403 `device_required` — only an existing device (`pd_`) adds another. |
| `POST /auth/pair/:id/deny` | the creator, CSRF | From pending / claimed / approved. Closing the dialog sends it. |
| `POST /auth/pair/claim` | none (holds the code) | JSON `{code, code_challenge (S256), label ≤ 80, platform}`. The first valid claim wins → `{claimId, checkCode, interval, expiresIn}`; **a second claim voids the pairing** (`contested`, 409 `already_used` for both). 30 per 10 min per IP; 10 wrong or malformed codes shut that IP out for the window; 300 per 10 min across all clients. |
| `POST /auth/pair/token` | none (PKCE) | JSON `{claim_id, code_verifier}` → OAuth-style `authorization_pending` / `access_denied` / `expired_token` / `invalid_grant`, or `{access_token, token_type, expires_in, device_id}` with `Cache-Control: no-store`. A wrong verifier ends the pairing. Single use: the same claim + verifier again after the token was issued **revokes that device** (the device-code replay rule). 300 per 10 min per IP. |

**What is stored.** SQLite `device_pairings` (created by `auth/pairing.ts`): the SHA-256 of the
code and of the claim id, the S256 challenge, the phone's claimed label and platform, the
4-digit check code, timestamps, the resulting device id. Never the code, the claim id, the
verifier or the token. Rows older than a day are removed when a new pairing starts. Every step
writes one `action_audit` row `auth.pair.{start,claim,approve,deny,token}` with ids only.

**The QR.** The server origin and the one-time code — nothing else: no token, session,
email or vault name. It is drawn on the Mac by Prism's own encoder
(`packages/core/src/lib/qr/qrcode.ts`: byte mode, level M, versions 1–20, no dependency),
black on white in both themes.

**The phone** (`apps/client/src-tauri/src/pairing.rs`). The app registers `prism`, so the
Camera's QR banner opens it; `RunEvent::Opened` reaches links.rs, which hands a pairing link
to pairing.rs before its route rules. The link must be exactly
`prism://pair?v=1&s=<https origin>&c=<22-char code>` (one of each parameter, no path, port,
userinfo or fragment; the origin through `ServerOrigin::parse`, https only), else it is
dropped silently like any unknown `prism://`. Then: wait for the app lock (the links.rs
rule); refuse if the app belongs to another server or is already signed in to this one (a
link never switches servers or replaces a sign-in); a **native** confirmation naming the
server (any web page can fire `prism://`, so a drive-by link must not quietly point a fresh
app at someone else's server); `GET /health?live=1`; claim with a fresh PKCE pair; show the
check code; poll; store the token exactly as a PKCE sign-in does — a fresh app saves the
server first, then boots the page under its CSP. The page only *draws* a sheet
(`__PRISM_SHELL__.pairing(view)`: working / waiting with the code / failed / null); it can
start, approve or retry nothing. No new IPC command (`verify-client.mjs` §9 pins it).

**Threats.** A photographed QR: whoever claims first is shown on the Mac as a claim
("A device calling itself …"), the owner's own phone then gets "already used" and the pairing
is void; and approval needs the code the *claiming* phone shows, typed by the owner, so an
owner who is not holding that phone cannot approve it by clicking. Replay: one claim, a
PKCE-bound single-use token step, 5 minutes. Guessing: 128-bit codes plus the claim limits.
Scope: a pairing mints a device only for the account that started it, and only the server
owner can start one (decision for the owner: open it to every signed-in account).

Code: `apps/server/src/auth/pairing.ts` (rules + storage), `apps/server/src/routes/pairing.ts`
(HTTP), `packages/core/src/components/renderers/network/PairPhoneDialog.tsx` (the dialog, from
the setup checklist's devices step). Tests: `apps/server/test/pairing.test.ts`,
`apps/server/test/qrcode.test.ts`, `cargo test --lib pairing::`,
`apps/web/e2e-fixtures/setup-pairing.spec.ts`, `ios-shell.spec.ts` ("iOS pairing").

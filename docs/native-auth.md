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
| `GET /auth/device/authorize` | browser | Starts the flow. Params: `client_id=prism-native`, `redirect_uri`, `code_challenge` (43-char base64url), `code_challenge_method=S256` (`plain` is refused), `state` (recommended, ≤512 chars, echoed), `label` (device name, ≤80 chars), optional `response_type=code`. |
| `GET /auth/device/continue` | browser | Where the web login returns. Internal; clients never call it. |
| `POST /auth/device/approve` | browser session + CSRF | The consent form. Redirects to `redirect_uri?code=…&state=…`, or `?error=access_denied&state=…` on Deny. |
| `POST /auth/device/token` | none (PKCE) | Form-encoded or JSON body. Returns `{access_token, token_type:"Bearer", expires_in, device_id}` with `Cache-Control: no-store`. Rate-limited to 20 per 10 minutes per client IP. Errors follow OAuth: `400 invalid_request / invalid_grant / unsupported_grant_type`, `401 invalid_client`. |
| `POST /auth/device/revoke` | see below | `token=pd_…`: revokes that token, always 200 (RFC 7009 style). `device_id=…` with a session or device token: revokes your own device, or any device if you are the server owner. An empty body with `Authorization: Bearer pd_…` revokes the calling token (sign out). |
| `GET /auth/devices` | session or device token | Your live devices: `{devices:[{id,label,email,createdAt,lastSeenAt,expiresAt,current}]}`. The server owner may add `?all=1`. |
| `DELETE /auth/devices/:id` | session or device token | Revoke your device (the owner may revoke any). Someone else's device returns 404. |

Errors before consent are **never redirected**, whatever caused them: an
unregistered `redirect_uri`, an unknown `client_id`, `plain` or a missing PKCE
challenge, a bad `response_type`, or an over-long `state`. Each gets a 400 error
page, and nothing is parked or set as a cookie. Error parameters are never added
to a URL the requester supplied. Only a completed consent redirects: `code` on
Approve, `error=access_denied` on Deny.

### Redirect URIs

- Exact string match against `DEVICE_REDIRECT_URIS`, comma-separated (default
  `prism://auth/callback`). No query and no trailing slash variants are accepted.
  Add a universal link (an `https://…` URL your app claims) here for the stronger
  iOS option.
- Desktop loopback (RFC 8252 §7.3): exactly `http://127.0.0.1:<port>/callback` or
  `http://127.0.0.1:<port>/`, or the same with `[::1]`.
  - The port must be explicit and at least 1024.
  - The URI may not contain a query, fragment or userinfo.
  - `localhost` is not accepted.
  - Set `DEVICE_ALLOW_LOOPBACK=false` to disable loopback redirects.

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
  `effectiveLevel` over the user's grants, read-only below `suggest`.
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

## Passwords and credentials created through a device

- **`/auth/change-password` with a device token** always requires the current
  password. If the account has no password yet (an owner who signs in only by
  magic link), a device token gets `403 password_setup_requires_browser`: the
  first password can only be set from a browser session. A stolen device token
  therefore cannot create a new way to log in.
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
  the user just starts again from the app once signed in. A new invitee first
  accepts the invite in the browser, then starts sign-in from the app.
- Store the token in the Keychain or Keystore. On `401`, drop it and run the flow
  again.
- Sign-out: call `POST /auth/device/revoke` with the token.

## Known limits

- A custom URL scheme can be claimed by another app on the same device. PKCE does
  not help when the attacker starts the flow, so the consent page names the device
  and warns the user. Prefer a universal-link redirect for iOS production builds.
- Revoking a token blocks new requests and new collab connections at once. A collab
  WebSocket that is already open stays open until it reconnects, the same as for
  sessions.

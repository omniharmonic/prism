# Prism — Security Model & Hardening

Prism puts your entire knowledge vault behind a single, auditable trust boundary
and exposes only what you explicitly share. This document is the threat model, the
results of the security audit, and the checklist to deploy it safely.

## The one rule

**The Parachute vault token never leaves the home server.** No browser, no phone,
no share link, and no desktop webview ever receives it. Every public request is
authenticated and authorized by the Prism Server before any vault data is touched.

## Trust boundary

```
 Public internet                    Home server (trusted)
 ───────────────                    ─────────────────────
 Browser / Phone ─ session cookie ─┐
 Share-link guest ─ capability ────┤
                                    ▼
                          PRISM SERVER (apps/server)   ── vault token ──▶ Parachute (localhost:1940)
                          · authorizes every read/write
                          · holds ALL secrets
                          · serves the web app
                          · runs real-time collab
                                    ▲
 Desktop app (Tauri) ─ COLLAB_TOKEN ┘  (localhost only — see below)
```

Only the Prism Server holds secrets. Clients hold, at most, a short-lived
httpOnly session cookie or a note-scoped capability token.

## What is reachable from the public internet

The only public entrypoint is the Cloudflare tunnel → `localhost:8787`. Audited
anonymously over the live tunnel:

| Surface | Anonymous / non-owner result |
|---|---|
| `/` and app assets | served (static app shell — no data) |
| `/api/notes`, `/api/search`, `/api/tags` | `[]` — empty, filtered to your grants |
| `/api/notes/:id`, `/api/graph`, `/api/vault` | **403** |
| every other `/api/*` path | **403** (deny-by-default) |
| `/acl/*` (sharing management) | **403** (owner-only) |
| `/collab` (WebSocket) | rejected below `view`; only granted notes |
| `/auth/me` | **401** |

A signed-in **non-owner with no grants sees nothing** — authentication never
implies authorization. The owner is the only actor that gets a full-vault
passthrough, and only via an authenticated session.

## Authentication

- **Owner** (`OWNER_EMAIL`): full access. Signs in by password, or by an
  **owner-only** magic link (bootstrap/recovery — gated at request *and* callback).
- **Invited users**: invite-only. The owner issues a single-use, hashed, 7-day
  invite; the recipient registers a password account (scrypt). **There is no open
  signup.** Sharing by email auto-invites, so a grant binds to a real account.
- **Capability links** ("anyone with the link"): HMAC-signed, scoped to one note
  at one level (`view`/`comment`/`suggest`/`edit`), expiring, and **revocable**
  (revoke removes the grant instantly). Treat a capability URL like a password to
  that one note.
- **Desktop app**: presents a dedicated **`COLLAB_TOKEN`** (separate from the
  vault token, so the vault credential never enters the webview). **This token is
  honored ONLY for local (loopback) requests** — a request that arrives through
  the tunnel (it carries `CF-Connecting-IP`/`X-Forwarded-For`) can never use it.
  So even a leaked `COLLAB_TOKEN` (or vault token) grants nothing from the
  internet. Verified live: token → 200 on `localhost`, **403 over the tunnel**.

Generic 401s avoid account enumeration; `/auth/login`, `/auth/register`, and the
magic-link routes are rate-limited.

## Permissions

Levels `view < comment < suggest < edit < own`. A note's effective level for an
actor is the max over grants matching the note **id** or any of its **tags**
(owner → `own`). Grants live in SQLite and are the authoritative guard; tag-scoped
vault queries only *narrow* what's fetched (defense-in-depth).

## Secrets (all server-side, in `apps/server/.env`, `chmod 600`, gitignored)

| Secret | Purpose | If leaked |
|---|---|---|
| `PARACHUTE_TOKEN` | full vault access | **critical** — rotate immediately (`parachute auth revoke-token`) |
| `SESSION_SECRET` | signs session cookies | forgeable logins — rotate (logs everyone out) |
| `CAPABILITY_SECRET` | signs share links | forgeable links — rotate (invalidates all links) |
| `COLLAB_TOKEN` | desktop owner auth (local-only) | low — inert over the internet; still rotate |
| `RESEND_API_KEY` | sending email | rotate in Resend |

Audited: **zero** of these appear in git history or in any built client bundle;
`.mcp.json` (which also holds the vault token) is gitignored; the browser stores
no token (httpOnly cookie, empty `localStorage`).

## Browser hardening (set by the gateway on every response)

- **Content-Security-Policy**: `script-src 'self' 'wasm-unsafe-eval'` (no inline
  script — scripts are external modules), `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`; inline styles + Google Fonts +
  `data:`/`blob:` for the canvas are allowed. Verified the app + Excalidraw +
  collab run with no violations except Cloudflare's analytics beacon (blocked by
  design — no third-party analytics on the vault).
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
  (camera/mic/geo off), and HSTS on https.

## Deployment hardening checklist

- [ ] `npm run setup` (apps/server) — generates strong `SESSION_SECRET`,
      `CAPABILITY_SECRET`, `COLLAB_TOKEN`; you paste the vault token + owner email.
- [ ] `.env` is `chmod 600` and never committed (the bootstrap does this).
- [ ] Mint the vault token with the **shortest practical** scope/TTL
      (`vault:<name>:write`); plan to rotate it.
- [ ] Public access is **only** via the Cloudflare tunnel → `localhost:8787`.
      Do **not** port-forward `8787` directly (that would defeat the local-only
      owner-token gate, which assumes the public path sets a forwarding header).
- [ ] Set `RESEND_API_KEY` in production so magic links/invites are emailed, not
      logged; `MAGIC_FROM` must be a verified domain.
- [ ] (Optional) Add a Cloudflare Access policy in front of the hostname for an
      extra auth layer; disable Cloudflare Web Analytics to drop the beacon.
- [ ] After any change, **restart** the server (it does not hot-reload) and keep
      the desktop `collab_token` in sync with the server `COLLAB_TOKEN`.

## Incident response

- **Suspected vault-token leak**: `parachute auth revoke-token <jti>` (≈60s cache
  TTL), mint a new one, update `.env` + `.mcp.json` + the desktop config, restart.
- **Suspected session/capability-secret leak**: rotate `SESSION_SECRET` /
  `CAPABILITY_SECRET` in `.env`, restart (logs everyone out / invalidates links).
- **Revoke one share**: delete the link in the share dialog (instant).
- **Revoke a person**: remove them in the share dialog; delete their invite/account.

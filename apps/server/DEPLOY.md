# Deploying the Prism Server (home server)

The Prism Server is the single trust boundary for the web/shared experience: it
holds the vault token, enforces permissions, serves the web app, and runs
real-time collab. Run it on an always-on machine, behind a Cloudflare tunnel so a
sent link "just works" without your laptop open.

> Read **[SECURITY.md](../../SECURITY.md)** for the full threat model. The one
> rule: the vault token never leaves this server.

## 1. Configure (generates strong secrets for you)

```bash
cd apps/server
npm run setup          # interactive: paste the vault token + owner email; secrets auto-generated
```

This writes `apps/server/.env` (chmod 600, gitignored). It mints
`SESSION_SECRET`, `CAPABILITY_SECRET`, and `COLLAB_TOKEN` for you; you provide:
- `APP_ORIGIN` — your public https hostname (e.g. `https://prism.your-domain`).
- `OWNER_EMAIL` — the full-access admin.
- `PARACHUTE_TOKEN` — mint with
  `parachute auth mint-token --scope vault:default:write --expires-in 31536000`.
- `RESEND_API_KEY` (optional but **required in prod** so magic links/invites are
  emailed, not just logged) + `MAGIC_FROM` (a Resend-verified sender).

(Prefer manual? Copy `.env.example` → `.env` and fill it in. Never commit `.env`.)

## 2. Build the web app (served same-origin by the server)

```bash
npm run build -w @prism/web        # → apps/web/dist
```

## 3. Run it (keep it alive)

```bash
cd apps/server && npm start        # node --env-file=.env --import tsx src/index.ts
```

For uptime, use a process manager — e.g. pm2:

```bash
pm2 start "npm start" --name prism-server --cwd apps/server
pm2 save && pm2 startup            # restart on boot
```

> The server compiles via tsx on start and does **not** hot-reload. After any
> code or `.env` change, `pm2 restart prism-server`.

## 4. Cloudflare tunnel → localhost:8787

Use a hostname dedicated to Prism. `~/.cloudflared/<config>.yml`:

```yaml
ingress:
  - hostname: prism.your-domain
    service: http://localhost:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel-name> prism.your-domain
cloudflared tunnel run <tunnel-name>     # (run as a service for uptime)
```

Set `APP_ORIGIN=https://prism.your-domain` to match.

> **Do not** port-forward `8787` directly to the internet. Public access must go
> through the tunnel (or another proxy that sets `X-Forwarded-For`), because the
> local-only owner-token gate trusts the *absence* of a forwarding header to mean
> "this is the local desktop." See SECURITY.md.

## 5. Connect the desktop app (optional, for desktop ⇄ web ⇄ phone live sync)

The Tauri desktop app joins the same real-time collab and can mint share links by
talking to **this server on localhost** with the dedicated `COLLAB_TOKEN`. Add to
the desktop config (macOS: `~/Library/Application Support/prism/prism-config.json`):

```json
"collab_url": "ws://localhost:8787/collab",
"collab_token": "<the COLLAB_TOKEN from apps/server/.env>"
```

Restart the desktop app. (The token is local-only — it's rejected over the tunnel,
so it's safe to keep in the local config. Keep it in sync with the server's value.)

## 6. Verify (from a device that is NOT the server)

```bash
curl https://prism.your-domain/api/notes          # → []  (never the vault, when anon)
curl -o /dev/null -w "%{http_code}\n" https://prism.your-domain/api/graph   # → 403
```

- `https://prism.your-domain/` → the app; signed out, `/auth/me` is 401.
- Sign in as `OWNER_EMAIL` → full app; in devtools `document.cookie` is empty
  (httpOnly session) and `localStorage` holds no token.
- Share a note → open the link in a private window → only that one note loads.

## Security posture (summary — full details in SECURITY.md)

- Browser/phone hold **no vault token** (httpOnly session cookie or HMAC
  capability link only). The desktop uses a dedicated, **local-only** token.
- **Invite-only** accounts; owner-only magic link; generic 401s; rate-limited auth.
- Gateway authorizes + tag-filters every read/write; deny-by-default 403; a
  signed-in non-owner with no grants sees nothing.
- Owner-token (COLLAB_TOKEN / vault token) is honored **only from localhost** —
  inert over the public tunnel even if leaked.
- Hardened headers incl. **Content-Security-Policy**, `X-Frame-Options: DENY`,
  HSTS, `Permissions-Policy`. No secrets in git or client bundles (audited).
- Capability links revoke instantly; vault-token revocation lags ~60s (Parachute
  cache) — prefer gateway-level revocation.

### Future hardening
- Server-side enforcement of **suggest-only** (today suggest-level is locked into
  suggest mode client-side; the hard "which notes" boundary is server-enforced).
- Self-host Excalidraw's runtime fonts to drop the one third-party (`esm.sh`,
  fonts only) request from the canvas.

# Deploying the Prism Server (home server)

The Prism Server is the single trust boundary for the web/shared experience: it
holds the vault token, enforces permissions, serves the web app, and runs collab.
Run it on a machine that stays on (home server / always-on box), behind a
Cloudflare tunnel so a sent link "just works" without your laptop open.

## 1. Build the web app (served by the server, same-origin)

```bash
npm run build -w @prism/web        # → apps/web/dist
```

## 2. Production `.env` (apps/server/.env — gitignored, never commit)

```bash
cd apps/server
cat > .env <<EOF
PORT=8787
APP_ORIGIN=https://prism.<your-domain>        # the public https origin (drives Secure cookies + HSTS)
PARACHUTE_URL=http://localhost:1940
PARACHUTE_VAULT=default
PARACHUTE_TOKEN=<hub JWT: parachute auth mint-token --scope vault:default:write --expires-in 31536000>
SESSION_SECRET=$(openssl rand -base64 48)
CAPABILITY_SECRET=$(openssl rand -base64 48)
OWNER_EMAIL=benjamin@opencivics.co
RESEND_API_KEY=<resend key — REQUIRED in prod so magic links are emailed, not logged>
MAGIC_FROM=Prism <login@your-domain>
DB_PATH=./prism-server.db
WEB_ROOT=../web/dist
EOF
```

Generate `SESSION_SECRET`/`CAPABILITY_SECRET` once and keep them stable (rotating
them invalidates all sessions / capability links). The `PARACHUTE_TOKEN` stays
**only** here — it is never sent to a browser.

## 3. Run it (keep it alive)

```bash
cd apps/server && npm start          # node --env-file=.env src/index.ts (tsx)
```

For uptime use a process manager — e.g. pm2:

```bash
pm2 start "npm start" --name prism-server --cwd apps/server
pm2 save && pm2 startup            # restart on boot
```

(or a macOS `launchd` plist / systemd unit running the same command).

## 4. Cloudflare tunnel → localhost:8787

Use a **separate hostname** from the vault/MCP tunnel (`agent.omniharmonic.com`
stays pointed at the hub). Add an ingress rule to your `cloudflared` config:

```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: prism.<your-domain>
    service: http://localhost:8787
  # ...existing rules (agent.omniharmonic.com → hub) ...
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel-name> prism.<your-domain>
cloudflared tunnel run <tunnel-name>        # (already running as a service in most setups)
```

Set `APP_ORIGIN=https://prism.<your-domain>` to match.

## 5. Verify (from a device that is NOT the server)

- `https://prism.<your-domain>/` → Login screen (NOT the vault).
- Sign in with `OWNER_EMAIL` → full app; `document.cookie` empty (httpOnly session).
- Share a note → open the capability link in a private window → only that note.
- `https://prism.<your-domain>/api/notes` unauthenticated → `[]` (never the vault).

## Security posture (built in)

- Browser holds **no vault token**; auth is an httpOnly, SameSite=Lax, Secure
  (on https) session cookie, or an HMAC capability token.
- **Invite-only accounts.** There is no open self-signup. The owner signs in via
  an **owner-only** magic link (bootstrap/recovery). Everyone else is **invited**
  by the owner → registers a **password account** (scrypt) → logs in with email +
  password. Sharing by email auto-invites, binding the grant to a real account.
  Generic 401s (no enumeration); `/auth/login`,`/auth/register`,`/auth/request`,
  `/auth/callback` are rate-limited.
- Gateway authorizes + tag-filters every read/write; non-owner non-allowlisted
  paths → 403. `effectiveLevel` is the authoritative guard. **A signed-in
  non-owner with no grants sees nothing** — authentication never implies
  authorization; the graph/vault is 403 for everyone but the owner.
- Invites/magic links: single-use, SHA-256-hashed at rest (invites 7-day,
  magic links 15-min).
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, HSTS on https.
- Capability links are revocable instantly (delete the grant); vault-token
  revocation lags ~60s (Parachute cache) — prefer gateway-level revocation.

### Known limitations / future hardening
- The **suggest vs. edit** distinction is enforced client-side (suggest-level is
  locked into suggest mode); the hard boundary (which notes you can touch) is
  server-enforced by the grant. Server-side suggest-only enforcement is future work.
- No CSP yet (the SPA uses inline element styles); add once with full testing.
- Editing a shared note on the **desktop** app (direct Tauri→Parachute) while a
  collab session is live can diverge; onLoadDocument re-seeds from Parachute when
  it detects an external edit, but concurrent desktop+web editing of the same
  note isn't fully reconciled.

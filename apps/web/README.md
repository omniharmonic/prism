# Prism Web

A static, installable **PWA** that mounts the same `@prism/core` UI as the Tauri
desktop app and talks directly to a Parachute vault over HTTP. Edit your vault
from any browser (mobile included); share read-only note links.

There is **no backend to run** — the browser talks straight to the vault. The
desktop-only features (AI agent, Gmail, Calendar, Matrix, Notion, GitHub sync)
degrade gracefully; this build covers the vault-native core: editor, wikilinks,
graph, dashboards, search, and full note CRUD.

## How it works

- `parachute/rest.ts` — the Parachute REST client (single source of HTTP truth).
- `parachute/HttpVaultClient.ts` — implements the `VaultClient` seam the shared
  hooks consume.
- `tauri-shim/{core,event}.ts` — Vite-aliased over `@tauri-apps/api`, so every
  direct `invoke()`/`listen()` in `@prism/core` works in the browser.
- `auth/ConnectScreen.tsx` — collects vault URL + name + token (localStorage).
- `share/ShareView.tsx` — the public `/share/:id` read-only renderer.

## Develop

```bash
npm run dev -w @prism/web      # http://localhost:5180
```

On first load, enter your vault URL (e.g. `http://localhost:1940`), vault name
(`default`), and a token. Mint a token with `parachute auth mint-token`
(scope `vault:<name>:write`).

## Build

```bash
npm run build -w @prism/web    # → apps/web/dist
```

For a hosted instance, bake in the vault it fronts so users don't have to type
the URL (the token is still entered per-device):

```bash
VITE_VAULT_URL=https://vault.example.com VITE_VAULT_NAME=default \
  npm run build -w @prism/web
```

## Deploy (free static host + tunnel)

1. **Expose your vault** from your machine/home server over HTTPS:
   - Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:1940`
   - or Tailscale Funnel: `tailscale funnel 1940`
   CORS is already wide open on the vault, so no server-side change is needed.

2. **Deploy the static app** (global CDN, HTTPS, installable):
   - **Cloudflare Pages / Netlify** — build command
     `npm run build -w @prism/web`, output directory `apps/web/dist`.
     SPA deep links handled by `public/_redirects`.
   - **Vercel** — same build/output; SPA routing handled by `vercel.json`.

3. Open the deployed URL on your phone, enter the vault URL + token, and
   "Add to Home Screen" to install.

### This deployment (live)

- **App:** https://prism-5ko.pages.dev (Cloudflare Pages, project `prism`) —
  built with `VITE_VAULT_URL=https://agent.omniharmonic.com` (the vault's
  existing Parachute Cloudflare tunnel) and `VITE_COLLAB_HOST=prism-collab.benjamin-7c2.workers.dev`.
- **Collab server:** `apps/collab-server` → Cloudflare Worker `prism-collab`
  (Durable Object `Document`, y-partyserver) at
  https://prism-collab.benjamin-7c2.workers.dev.

Redeploy:

```bash
npm run build -w @prism/web
npx wrangler pages deploy apps/web/dist --project-name prism --branch main   # app
npm -w @prism/collab-server run deploy                                       # collab server
```

## Sharing

`/(share|view)/<noteId>` renders a note read-only with no app chrome. It first
tries the vault's public published-note endpoint (`/vault/<name>/view/<id>`),
then falls back to an authenticated read for viewers who have access.

> **Note:** truly anonymous (no-login) sharing requires the vault to serve
> `/view` publicly. On Parachute builds where that endpoint requires auth, share
> links only resolve for viewers who already have a stored connection. Enabling
> public view on the vault unblocks anonymous sharing with no app changes.

## Real-time collaboration (CRDT) — hardened

A note is shared for live editing via the **Share** button (tab bar, desktop +
mobile) or by opening `/collab/<noteId>`. Editing is a Yjs CRDT synced through a
hosted **y-partyserver** Worker (`apps/collab-server`, one Durable Object per
note). Presence carets via CollaborationCaret. The owner seeds content from the
vault and persists changes back (debounced).

**Access control (capability links).** The Worker rejects every connection that
doesn't carry a valid, unexpired grant signed for that exact room:

- The owner's app mints a grant on the fly using its vault token; the Share
  button bakes one into a copyable link (`/collab/<id>?t=<grant>`).
- The Worker only mints a grant after verifying the requester's token against
  the vault — so only people with vault access can create share links.
- A grant authorizes **one note's** room and expires (30 days). A guessed note
  id, a grant for another note, or no grant all fail closed. The vault REST API
  itself remains JWT-only, so the rest of the graph is never exposed via collab.

**Deploy notes.** The Worker needs:
- `wrangler secret put COLLAB_SECRET` — HMAC key for signing grants (without it,
  all connections are rejected — fail-closed).
- `vars.VAULT_URL` / `vars.VAULT_NAME` in `wrangler.jsonc` — the trusted vault
  used to validate owner tokens.

If `VITE_COLLAB_HOST` is unset, the client falls back to peer-to-peer y-webrtc
(public signaling, no gating) — set it to the deployed Worker for the hardened,
durable path.

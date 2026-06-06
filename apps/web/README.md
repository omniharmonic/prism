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

## Sharing

`/(share|view)/<noteId>` renders a note read-only with no app chrome. It first
tries the vault's public published-note endpoint (`/vault/<name>/view/<id>`),
then falls back to an authenticated read for viewers who have access.

> **Note:** truly anonymous (no-login) sharing requires the vault to serve
> `/view` publicly. On Parachute builds where that endpoint requires auth, share
> links only resolve for viewers who already have a stored connection. Enabling
> public view on the vault unblocks anonymous sharing with no app changes.

## Real-time collaboration (CRDT)

`/collab/<noteId>` opens a note in a live, multi-cursor collaborative editor
backed by a Yjs CRDT over **y-webrtc** (peer-to-peer — no server to run;
same-origin tabs also sync instantly via BroadcastChannel).

- Room = note id, so a `/collab/<id>` link is the invite.
- The **owner** (a viewer with a vault connection) seeds the initial content and
  persists changes back to Parachute (debounced). Collaborators **without** vault
  access still edit live — the document syncs peer-to-peer via the CRDT.
- Presence carets are shown via CollaborationCaret.

Signaling defaults to y-webrtc's public servers. For production reliability,
run your own signaling server (or a hosted Yjs backend such as PartyKit /
y-sweet on Cloudflare) and set `VITE_COLLAB_SIGNALING` (comma-separated `wss://`
URLs) at build time. A hosted `y-websocket`/PartyKit backend also adds durable
presence and history beyond the P2P "both-online" model.

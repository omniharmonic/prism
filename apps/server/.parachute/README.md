# Prism as a Parachute hub module (Phase 5.1)

`module.json` registers the Prism Server as a **Parachute hub module** so the hub
owns install / start / port assignment (1939–1949) / reverse-proxy mount /
exposure — replacing the bespoke `pm2 + cloudflared` topology.

- **`websocket: true`** — the hub's Bun-native WS bridge forwards `Upgrade:
  websocket` to `/collab` (deny-by-default, so this flag is required). Transport
  only — Prism still authenticates every socket via `authorizeConnection`.
- **`paths`** — the server-owned prefixes (`/auth`, `/api`, `/acl`, `/collab`);
  everything else is the static PWA served from the same origin.
- **`health: /health`** — the hub's liveness probe.

## Status: READY, NOT ACTIVATED

This is an **opt-in migration artifact**. The live deploy still runs under `pm2`
(`prism-server`) behind the Cloudflare tunnel — activating the hub-module path is
a deploy-topology change made deliberately, not on every checkout, so there is
**zero interruption** to the current architecture. Activate with the hub's module
registration flow when migrating a node onto hub-native supervision.

## Deferred (needs the hub-native runtime to validate)

- **`credentials: [{ scope: "vault:default:write", endpoint }]`** — the H4
  standing-credential flow (hub mints a per-vault token on operator approval and
  POSTs it to a Prism endpoint, dropping the embedded token). Requires a
  token-receiving endpoint on the server; omitted until built + validated against
  a live hub-module registration.
- Routing `/collab` through the hub WS bridge (one fewer exposed port).

Schema reference: hub `src/module-manifest.ts` (0.7.x). The legacy `kind` field is
retired (hub#301/#330) — intentionally omitted.

# apps/desktop: legacy host-mode desktop (retired)

**Status: LEGACY since Arch v2 WP4.3 (2026-10).** Use **Prism Client** (`apps/client`)
on every Mac, the Mac mini included. This app is kept building only as the **rollback
path**; nothing new should be added here.

## Why it is retired

The legacy desktop (`Prism.app`, `com.benjaminlife.prism`) is a "host-mode" app:

- it holds a **vault token** (`parachute_api_key`, a hub JWT) and the server's
  **`collab_token`** in `~/Library/Application Support/prism/prism-config.json`;
- it talks to Parachute (`localhost:1940`), Matrix, Google (`gog`), GitHub, Notion and
  the `claude` CLI directly, bypassing the Prism Server's per-note permissions;
- it used to run all ingest (now server-owned: see `docs/roadmap/architecture-v2/desktop-services-inventory.md`).

Prism Client holds only a revocable per-device `pd_…` token in the Keychain and reaches
everything through the Prism Server gateway, so `effectiveCaps`, governance, private
notes and audit apply to it exactly as they do in a browser.

## What replaced what

The full feature-by-feature table (every Tauri command the UI invoked, and where it lives
now) is `docs/roadmap/architecture-v2/desktop-parity.md`. In short: notes, editing,
collaboration, search (incl. semantic), version history, sharing, publishing, governance,
graph, map, dashboards, tasks, inbox, calendar, agent chat, inline AI edit/transform and
note sync to Google Docs/Notion all work in Prism Client through the server. A few
desktop-only features have no server port yet (Notion database sync, GitHub folder-sync
UI, calendar event edit/delete, local-model routing for interactive AI); they are listed
there with their status.

## Switching over / rolling back

`docs/client-app.md`, section **Switch-over runbook (WP4.3)**: install Prism Client,
sign in, check parity, archive (not delete) `Prism.app`, remove the vault token from the
desktop config (with a backup), and verify with
`scripts/check-client-no-vault-token.sh` + `GET /acl/workers`. The same section has the
rollback steps (restore the archived app and the config backup).

## Building (rollback only)

```bash
cd apps/desktop && npm run tauri build -- --bundles app
cd apps/desktop/src-tauri && cargo check
```

Its config must stay in `ingest_mode: "client"`: the Prism Server owns all ingest, and two
ingesters for one source double-write (`CLAUDE.md`, "Live topology").

---
name: Prism Setup — Desktop
description: "Configure the Prism desktop app: write prism-config.json (Parachute URL/vault/token + collab URL/token) at the platform config path, and render the project .mcp.json so Claude Code gets vault MCP access. Verifies via mcp__parachute-vault__vault-info (the auth check validate_config lacks)."
version: 0.1.0
---

# Prism Setup — Desktop config + .mcp.json

Point the desktop app at the vault (and optionally the collab server), and
render the project-local `.mcp.json` for Claude Code's vault MCP. Needs the
`PARACHUTE_TOKEN` from `prism-setup-vault` and (for collab) the `COLLAB_TOKEN`
from the server `.env`.

## When to use

Step 4 of `prism-setup`, or standalone when the desktop app can't reach the vault.

## Steps

1. **Locate the config path** (created on first app launch; you may create it):
   - macOS: `~/Library/Application Support/prism/prism-config.json`
   - Linux: `~/.config/prism/prism-config.json`
   (See the load logic in `apps/desktop/src-tauri/src/commands/config.rs`.)
2. **Write / merge** these keys (merge — never clobber unrelated keys):
   ```json
   {
     "parachute_url": "http://localhost:1940",
     "parachute_vault": "default",
     "parachute_api_key": "<PARACHUTE_TOKEN>",
     "collab_url": "ws://localhost:8787/collab",
     "collab_token": "<COLLAB_TOKEN from apps/server/.env>"
   }
   ```
   `collab_url`/`collab_token` are only needed if the user runs the server and
   wants the desktop app's edits to sync through it.
3. **Render `.mcp.json`** (closes the gap where the template was never rendered):
   ```bash
   cd apps/server && npm run render:mcp           # reads PARACHUTE_* from .env
   # or, without an .env:
   PARACHUTE_URL=... PARACHUTE_VAULT=... PARACHUTE_TOKEN=... npm run render:mcp
   ```
   This substitutes the placeholders in repo-root `.mcp.json.template` →
   gitignored `.mcp.json`.

## Config artifacts

| File | Keys |
|---|---|
| `~/Library/Application Support/prism/prism-config.json` (macOS) / `~/.config/prism/prism-config.json` (Linux) | `parachute_url`, `parachute_vault`, `parachute_api_key`, `collab_url`, `collab_token` |
| repo-root `.mcp.json` | rendered `parachute-vault` MCP block (no `${...}` left) |

## Verify (pass / fail)

- `prism-config.json` parses as JSON and has the 5 keys.
- `.mcp.json` parses and contains a concrete URL + Bearer — **no `${...}`
  remaining** (the renderer throws if any placeholder is unresolved).
- **Auth proof** (this is the token/MCP check `validate_config` does NOT do): in
  a fresh Claude Code session, `mcp__parachute-vault__vault-info` returns vault
  stats. A 401 ⇒ wrong token; a leftover `${...}` ⇒ render didn't run.
- If the desktop app is runnable: launch it, open a note — it loads.

## Note

The app hot-reloads config on Settings save, but a file written behind its back
may need a relaunch — restart the app after writing `prism-config.json` directly.

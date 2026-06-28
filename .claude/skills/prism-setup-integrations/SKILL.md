---
name: Prism Setup — Integrations
description: "Configure Prism's optional integrations one at a time: Matrix (homeserver + access token), Google (gog CLI + OAuth), Anthropic/Claude (CLI path), Notion (integration key), and transcript sources (Fathom/Fireflies/Meetily). Writes each credential into the desktop prism-config.json and verifies the matching background service starts clean."
version: 0.1.0
---

# Prism Setup — Integrations

One skill, five à-la-carte sections. Each is **collect credential → write into
`prism-config.json` → run the existing check → confirm the background service is
healthy**. Only configure the integrations the user asks for — background
services in `apps/desktop/src-tauri/src/services/mod.rs` are **config-gated**
(absent credential ⇒ service stays stopped, which is correct).

All credential acquisition is **human action** (OAuth consent, choosing a
homeserver, generating a dashboard key). The skill collects + verifies; it
cannot issue credentials. Merge into `prism-config.json` — never clobber
unrelated keys. Field names below are from `AppConfig` in
`apps/desktop/src-tauri/src/commands/config.rs`.

## Matrix  (messaging sync)

- **Fields:** `matrix_homeserver`, `matrix_user`, `matrix_access_token`, `matrix_device_id`.
- **Human action:** run/choose a homeserver (Synapse/Dendrite; default
  `http://localhost:8008`) and obtain an access token by logging in. **Prism
  does not provision a homeserver** — it configures an existing one.
- **Verify:** the `test_matrix` command (a `/sync` ping) returns joined rooms /
  200; the `message_sync` service (60s) shows `last_run`, no `last_error`.

## Google  (calendar + email sync)

- **Fields:** `google_account_primary` (+ optional `google_account_agent`).
- **Human action:** install the `gog` CLI and complete Google **OAuth** through
  it — `gog` holds the tokens in its own keyring; **Prism never holds Google
  tokens**.
- **Verify:** `which gog` resolves; `check_google_cli` reports installed + the
  account is authed; `calendar_sync` (5min) + `email_sync` (3min) run clean.

## Anthropic / Claude  (the agent)

- **Field:** `anthropic_api_key` (macOS Keychain fallback).
- **Reality:** the agent path spawns `claude -p` (the **CLI**), not the HTTP
  SDK. Configure the CLI path; don't promise SDK features.
- **Human action:** install the `claude` CLI and sign in. Optionally paste an
  API key.
- **Verify:** `claude --version` works; a dispatch (`claude -p "..."`) returns
  output; the project `.mcp.json` is picked up (vault MCP tools available).

## Notion  (task sync)

- **Field:** `notion_api_key`.
- **Human action:** create an integration at notion.com/integrations and share
  the target databases with it; paste the secret.
- **Verify:** `test_notion` lists accessible DBs / 200; `notion_task_sync`
  (background) runs clean.

## Transcripts  (meeting notes)

- **Fields:** `fathom_api_key`, `fireflies_api_key`, `meetily_db_path` (also
  `readai_api_key`, `otter_api_key`).
- **Human action:** obtain vendor API keys from each dashboard; locate the
  Meetily SQLite DB (auto-discoverable on macOS).
- **Verify:** `transcript_sync` (10min) shows `items_processed ≥ 0`, no
  `last_error`.

## Skill-wide verify (pass / fail)

- Every **enabled** integration appears in Settings → Service Status as
  `running` with a recent `last_run` and empty `last_error`.
- **Disabled** integrations leave their service stopped — that's correct
  (config-gated), not a failure.

## Honest limitations (state plainly)

- No Matrix homeserver provisioning (configures an existing one).
- Google tokens live in `gog`'s keyring; Prism only verifies `gog` is authed.
- Anthropic = Claude **CLI** path only; no direct SDK routing in desktop today.
- Notion/Fathom/Fireflies/ReadAI/Otter keys are created in each vendor's
  dashboard — manual paste, no automated issuance.

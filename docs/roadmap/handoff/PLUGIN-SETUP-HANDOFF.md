# PLUGIN-SETUP-HANDOFF — Build the comprehensive Prism setup plugin

> **Deliverable:** A Claude Code plugin that bundles skills walking a user through setting up **every part of their Prism** — local Parachute vault + hub, Prism Server (local hosting), desktop config, and every integration (Matrix, Google, Anthropic/Claude, Notion, Fathom/Meetily transcripts), plus tag-schema seeding.
>
> **Audience:** A local Claude Code agent with a live environment (Parachute vault + hub running, the desktop app installed, a browser available). You can run `parachute`, `node`, `npm`, `curl`, `claude`, and edit files in this repo. This document is self-contained.
>
> **Two work modes used throughout:**
> - **CONFIGURE** — run/verify code that already exists. No new code.
> - **BUILD** — write new code/skills/tests.

---

> ## ⬆ STATUS UPDATE (branch `claude/roadmap-test-coverage`)
> Part of this handoff is **already built**. What shipped:
> - ✅ **The `prism-setup` skill family exists** — `.claude/skills/prism-setup{,-vault,-server,-schema,-desktop,-integrations}/SKILL.md` (6 skills, the §2 architecture). G1 + G2 (scaffolding) resolved.
> - ✅ **`.mcp.json` renderer (G3)** — `apps/server/scripts/lib/render-mcp.ts` + CLI `scripts/render-mcp.ts`, **wired into `prism-setup.ts`** so the full flow renders it. Unit-verified (substitutes all `${...}`, validates JSON, rejects missing inputs).
> - ✅ **Root `setup` script (G4)** — `npm run setup` (→ `setup:full -w @prism/server`).
> - ✅ **Standalone seed entrypoint (G5 helper)** — `npm run seed` (`scripts/seed.ts` → `seedTagSchemas` from env, `--dry-run`).
> - ✅ **Manifest + README fixed** — `plugin.json` v0.2.0, README lists the real skill set.
>
> **Still BUILD / to verify against a live vault:**
> - The skills are **authored but unrun** — execute each against a live vault/desktop and confirm its verify (§5).
> - **G5 (desktop config writer):** `prism-setup-desktop` currently *instructs* writing `prism-config.json`; there is still no automated writer command — build one or do it by hand per the skill.
> - **G6** (strengthen `validate_config` with an auth/MCP check) and **G8** (expose `seedTagSchemas` as a Tauri command + wizard verify) remain **optional, unbuilt**.
> - Integration provisioning (Matrix/Google/etc.) is collect-and-verify only, as designed.
>
> ## ⬆ STATUS UPDATE 2 (branch `claude/roadmap-handoff`)
> - ✅ **G6 DONE** — `validate_config` now performs a real auth check: after `/health`
>   it does an authed `GET /vault/:vault/api/notes?limit=1` with the configured
>   Bearer and reports `token_valid` (true / false-with-detail / omitted when no
>   key or unreachable). Catches expired JWTs / rejected legacy `pvt_*` tokens that
>   `api_key_present` can't. Frontend `configApi.validate` type updated. `cargo check`
>   + core typecheck clean.
> - ✅ **G5 ADDRESSED** — an automated desktop config writer already exists:
>   `update_config` (`commands/config.rs`) persists `prism-config.json` field-by-field.
>   The `prism-setup-desktop` skill should drive it (+ verify via `validate_config`'s
>   new `token_valid` and `mcp__parachute-vault__vault-info`).
> - ⏭ **G8 DEFERRED (deliberate)** — a Rust port of `seedTagSchemas` would duplicate
>   the TS additive-merge logic and risk drift from the single source
>   (`tag-schemas.json`). Provisioning is already covered by the server-side
>   `seedTagSchemas` (`npm run seed` / `prism setup`) and the `prism-setup-schema`
>   skill; the desktop wizard should call those rather than a parallel Rust seeder.
> - **Live skill runs** (vault/desktop/integrations) still need real credentials +
>   the desktop app and are left for an operator: they collect Matrix/Google/Notion/
>   transcript secrets and write them into `prism-config.json`. The server + schema
>   skills are exercised by Layer B (`prism-setup.ts` seeding ran; `verify-gateway`
>   green).
>
> The gap table in §1.3 and the build plan in §4 are the **original** assessment; treat the items above as their current status.

## 0. TL;DR — what you're doing

The setup *machinery* (the `prism-setup.ts` Node script + `seedTagSchemas()` library + the desktop wizard) mostly exists and works. What's **missing** is the **plugin packaging**: there is **no `prism-setup` Claude skill** even though `plugin.json`'s README and `PROGRESS.md` claim one exists. The product goal — "a plugin of skills that walks a user through setting up every part of Prism" — is essentially **unbuilt at the plugin layer**.

Your job:
1. **Fix the lie first** (CONFIGURE/correct): the docs claim a `prism-setup` skill that doesn't exist.
2. **BUILD** a family of setup skills — one per setup domain — that *drive* the existing machinery (and fill the holes where machinery is missing, e.g. desktop config writing, `.mcp.json` rendering, vault/token provisioning helpers).
3. **Wire** them into `plugin.json` and validate the plugin installs.
4. **Prove** end-to-end: a brand-new user, following the plugin, reaches a working Prism (vault + server + desktop + chosen integrations).

---

## 1. HONEST ASSESSMENT — current state vs. the goal

### 1.1 What the plugin actually bundles today

| Artifact | Path | State |
|---|---|---|
| Plugin manifest | `/home/user/prism/.claude-plugin/plugin.json` | **Valid.** Wires `skills: ./.claude/skills/` and an MCP server `parachute-vault` (`type=http`, URL + Bearer with `${VAR}` expansion). |
| Plugin README | `/home/user/prism/.claude-plugin/README.md` | **Wrong at line 9** — lists `prism-setup` as a bundled skill. It is not. |
| MCP template | `/home/user/prism/.mcp.json.template` | Committed template with `${PARACHUTE_URL}/${PARACHUTE_VAULT}/${PARACHUTE_TOKEN}` placeholders. **Never rendered to `.mcp.json` by any script** despite CLAUDE.md implying it is. |
| Skills present | `/home/user/prism/.claude/skills/{classify,extract-entities,reconcile,schema-bridge,wikilinks}/SKILL.md` | **5 skills, all vault-data operations.** None are setup skills. Plus a loose `resolve-wikilinks.md`. |

### 1.2 What the setup *machinery* does (exists, works)

| Component | Path | Does | Does NOT |
|---|---|---|---|
| Server setup script | `apps/server/scripts/prism-setup.ts` | Prompts for `APP_ORIGIN`/`OWNER_EMAIL`/`PARACHUTE_URL`/`PARACHUTE_VAULT`/`PARACHUTE_TOKEN`/`RESEND_API_KEY`/`MAGIC_FROM`; generates `SESSION_SECRET`/`CAPABILITY_SECRET`/`COLLAB_TOKEN`; writes `apps/server/.env` (chmod 600); calls `seedTagSchemas()`. `--dry-run`/`--force`. | Mint the Parachute token (manual `parachute auth mint-token`). Render `.mcp.json`. Write desktop `prism-config.json`. Configure any integration. Generate `PEER_SIGNING_KEY`. |
| Tag seeding | `apps/server/scripts/lib/seed-tag-schemas.ts` | Idempotent, additive-only: creates new tags, adds missing fields, fills **empty** descriptions. Never overwrites existing field defs or non-empty descriptions. Returns `{created, updated, unchanged, skipped}`. | Run anywhere but the Node script (not a Tauri command, not a Web API). |
| Canonical schema | `packages/core/src/lib/schemas/tag-schemas.json` | Source of truth (35 tags: description, fields, contentType, precedence). | — |
| Bash equivalent | `apps/server/scripts/bootstrap.sh` | Generates secrets, writes `.env`. | Seed tags. |
| Desktop wizard | `packages/core/src/components/layout/Onboarding.tsx` | 6 steps. Steps 1/3/4 **TEST** connections (`configApi.validate`, `check*`). Step 2 **provisions** tags indirectly via `agentApi.chat` (Claude + MCP). | Provision the vault, install/configure any integration, or *verify* that step 2 actually created the tags before advancing. |
| Desktop config validate | `apps/desktop/src-tauri/src/commands/config.rs` → `validate_config` | Pings Parachute `/health`, returns `ConfigHealth {url, vault, api_key_present, reachable, detail}`. | **Does NOT** test the API token (auth), or the MCP endpoint. `api_key_present` is presence-only. |
| Desktop config model | `apps/desktop/src-tauri/src/commands/config.rs` → `AppConfig` | 20 fields (Parachute, Matrix, Google, Notion, Anthropic, transcripts, collab). Loads/saves `prism-config.json`; Keychain fallback for `anthropic_api_key`. | Be written by any setup script — only the Settings UI writes it today. |

### 1.3 The gaps that block the product goal

| # | Gap | Severity |
|---|---|---|
| G1 | **`prism-setup` Claude skill does not exist.** README L9 + `PROGRESS.md` L-Onb-Seed claim it does. | **Critical (doc lie + missing deliverable)** |
| G2 | **No per-domain setup skills at all** (vault, server, desktop, Matrix, Google, integrations, schema). The "walk the user through every part" product does not exist as a plugin. | **Critical** |
| G3 | `.mcp.json.template` is **never rendered** to `.mcp.json`. CLAUDE.md claims setup renders it. | High |
| G4 | **No root `setup` npm script.** Users must `cd apps/server`. | Medium |
| G5 | `seedTagSchemas()` not exposed to desktop/web (no Tauri command / API). Wizard re-seeds *indirectly* via agent chat and never verifies success. | Medium |
| G6 | `validate_config` only pings `/health`; no **auth/token** check, no MCP-endpoint check. | Medium |
| G7 | Token minting, Matrix homeserver, Google `gog` OAuth, Notion key, transcript keys are all **manual out-of-band** — no skill collects/validates them. | Expected (human-action), but unguided |
| G8 | Web-owner onboarding disabled (`VITE_WEB_OWNER_ONBOARDING=false`) — owners can't self-serve setup in browser. | Known limitation |

**Bottom line:** the machinery is ~70% there for *server + schema*; it is ~0% there as a *guided plugin* and ~0% for *desktop-config writing* and *integration provisioning*. The plugin must be **built**, not just documented.

---

## 2. TARGET PLUGIN ARCHITECTURE — skill-by-skill

Design principle: **one skill per setup domain.** Each skill is conversational (collects human-only inputs), drives existing machinery where it exists, writes the exact config artifact, and ends with a concrete **verify** step that passes/fails. A top-level orchestrator skill chains them.

```
prism-setup            (orchestrator — runs the others in order, tracks what's done)
├── prism-setup-vault          Parachute vault + hub + token
├── prism-setup-server         apps/server/.env + secrets + build/run
├── prism-setup-schema         seed 35 tag schemas into the vault
├── prism-setup-desktop        prism-config.json (Parachute + collab) + .mcp.json render
├── prism-setup-matrix         \
├── prism-setup-google          } prism-setup-integrations (one skill, sectioned by service)
├── prism-setup-notion          }  OR split if you prefer; see §2.6
└── prism-setup-transcripts    /
```

> **Recommendation:** ship **7 skills**: `prism-setup` (orchestrator), `prism-setup-vault`, `prism-setup-server`, `prism-setup-schema`, `prism-setup-desktop`, `prism-setup-integrations` (Matrix/Google/Notion/Anthropic/transcripts in one skill with clearly labeled sections — each integration is short and mostly "paste a credential, run a check"). Splitting integrations into 5 skills is fine but adds manifest churn for little gain.

Each skill below lists: **Purpose · Automates · Human action required · Config artifact written · Verify (pass/fail)**.

---

### 2.1 `prism-setup` (orchestrator)

- **Purpose:** Single entry point. Detect what's already configured, run the domain skills in dependency order, and print a final status table.
- **Automates:** Ordering (vault → server → schema → desktop → integrations), idempotency detection (skip a domain whose verify already passes), final report.
- **Human action:** Choosing which integrations to enable; approving destructive/`--force` actions.
- **Config artifact:** None directly — delegates. May write a small progress marker (e.g. console summary only; do not persist secrets here).
- **Verify (pass):** Running it twice in a row is safe; the second run reports every domain as "already configured / unchanged" and writes nothing new.

**Dependency order (hard):** vault must exist + token minted **before** server (server needs `PARACHUTE_TOKEN`); server `.env` + a reachable vault **before** schema seed; everything else (desktop, integrations) is independent and can run in any order after vault.

---

### 2.2 `prism-setup-vault` — Parachute vault + hub + token  (BUILD)

- **Purpose:** Ensure a Parachute vault is running and mint a long-lived write token.
- **Automates:**
  - Detect hub/vault: `curl -fsS http://localhost:1940/health` and `curl -fsS http://localhost:1939/...` (hub on 1939, vault on 1940).
  - Mint token: run `parachute auth mint-token --scope vault:default:write --expires-in 31536000` and capture the JWT.
- **Human action:** Installing Parachute + starting the hub if not present (the skill cannot install system software silently — instruct, then re-check). Choosing the vault name if not `default`.
- **Config artifact:** None of its own — it **emits `PARACHUTE_TOKEN` / `PARACHUTE_URL` / `PARACHUTE_VAULT`** for the server + desktop skills to consume. Do **not** write the token to disk here; hand it forward in-session.
- **Verify (pass):**
  - `curl -fsS http://localhost:1940/health` → 200.
  - Token works: `curl -fsS -H "Authorization: Bearer $PARACHUTE_TOKEN" http://localhost:1940/vault/default/api/info` (or the vault-info MCP equivalent) → 200, not 401.
  - The token is a **hub JWT** (Parachute 0.5.x), not a legacy `pvt_*` opaque token (those return 401).
- **Verify (fail):** 401 on the authed call ⇒ wrong/expired token, re-mint. Connection refused ⇒ hub/vault not running.

---

### 2.3 `prism-setup-server` — Prism Server `.env` + run  (CONFIGURE-driven, thin BUILD)

- **Purpose:** Provision `apps/server/.env` and get the server running.
- **Automates:** Wraps the existing script. Run:
  ```bash
  cd /home/user/prism/apps/server && node --import tsx scripts/prism-setup.ts
  ```
  This generates `SESSION_SECRET`/`CAPABILITY_SECRET`/`COLLAB_TOKEN`, writes `.env` (chmod 600), and calls `seedTagSchemas()` (so the **schema** domain may already be done after this — see §2.4 note). Use `--dry-run` first to preview, then real run. `--force` rotates secrets.
- **Human action:** Provide `APP_ORIGIN`, `OWNER_EMAIL`, optional `RESEND_API_KEY` + `MAGIC_FROM`. Decide `FEDERATION_ENABLED` (default off) — if on, generate a stable `PEER_SIGNING_KEY` (see below).
- **Config artifact written:** `/home/user/prism/apps/server/.env` — required keys: `PARACHUTE_TOKEN`, `SESSION_SECRET`, `CAPABILITY_SECRET`, `OWNER_EMAIL`, `APP_ORIGIN`; plus `PARACHUTE_URL`, `PARACHUTE_VAULT`, `COLLAB_TOKEN`; optional `RESEND_API_KEY`, `MAGIC_FROM`, `FEDERATION_ENABLED`, `PEER_SIGNING_KEY`, `WEB_ROOT`, `DB_PATH`, `EMBED_*`. Validated by `apps/server/src/config.ts` → `assertConfig()`.
  - **`PEER_SIGNING_KEY` (only if federation):** generate via `peer.ts generateKeyPairB64url()`:
    ```bash
    cd /home/user/prism/apps/server && node --import tsx -e \
      "import {generateKeyPairB64url} from './src/auth/peer.ts'; console.log(generateKeyPairB64url())"
    ```
    Append to `.env`. Without it the server warns and uses an **ephemeral** identity (federation pairings won't survive restart).
- **Verify (pass):**
  - `cd /home/user/prism/apps/server && npm run typecheck` → clean.
  - Build web first: `npm run build -w @prism/web` → `apps/web/dist` exists.
  - Start: `cd /home/user/prism/apps/server && npm run dev` (or `npm start`). No `assertConfig()` throw.
  - `curl -fsS http://localhost:8787/` returns the PWA `index.html`.
  - Security e2e: `node --env-file=.env --import tsx scripts/verify-gateway.ts` passes.
- **Verify (fail):** `assertConfig` throws ⇒ a required secret is missing/empty in `.env`.

> **THIN BUILD here:** the script already does this. The skill's new code is just the conversational wrapper + the federation-key branch + reading back and confirming `.env` (never echoing secrets in full).

---

### 2.4 `prism-setup-schema` — seed 35 tag schemas  (CONFIGURE)

- **Purpose:** Idempotently seed the 35 canonical tag schemas into the vault.
- **Automates:** Calls `seedTagSchemas()`. Today the **only** caller is `prism-setup.ts`. Two paths:
  1. **If §2.3 ran the full script**, schemas are already seeded — this skill just **verifies**.
  2. **Standalone re-seed:** add a tiny entrypoint (BUILD) so the skill can seed without rewriting `.env`. Minimal script:
     ```bash
     cd /home/user/prism/apps/server && node --import tsx -e \
       "import {seedTagSchemas} from './scripts/lib/seed-tag-schemas.ts'; \
        seedTagSchemas({url: process.env.PARACHUTE_URL, vault: process.env.PARACHUTE_VAULT, token: process.env.PARACHUTE_TOKEN}).then(r=>console.log(JSON.stringify(r)))"
     ```
     (Confirm the real `seedTagSchemas` signature before relying on this — adjust args to match.)
- **Human action:** None.
- **Config artifact:** Vault tag schemas (server-side data, not a file). Source: `packages/core/src/lib/schemas/tag-schemas.json`.
- **Verify (pass):** Run twice. **Second run reports `created: 0, updated: 0, unchanged: 35`** (the idempotency proof). Cross-check: `list-tags` MCP / `GET .../tags` returns ≥ 35 tags including the canonical set. Confirm never-overwrite: the additive guards are `if (!(fname in curFields))` and `if (!curDescription && !!desiredDescription)` in `seed-tag-schemas.ts`.
- **Verify (fail):** `created > 0` on the **second** run ⇒ non-idempotent (bug), stop and investigate.

> **Note:** Findings disagree on the count (29 vs 35). The file `tag-schemas.json` is authoritative — **count its entries at runtime** and use that number in your verify, don't hard-code 35 or 29.

---

### 2.5 `prism-setup-desktop` — `prism-config.json` + `.mcp.json`  (BUILD — most new code)

- **Purpose:** Write the desktop app config so the local app talks to the vault and (optionally) the collab server, and render the project `.mcp.json` for Claude Code's vault MCP.
- **Automates:**
  - Locate config path: macOS `~/Library/Application Support/prism/prism-config.json`; Linux `~/.config/prism/prism-config.json`. (See `config.rs` load logic.)
  - Write/merge fields: `parachute_url`, `parachute_vault`, `parachute_api_key` (= `PARACHUTE_TOKEN` from §2.2), `collab_url` (e.g. `ws://localhost:8787/collab`), `collab_token` (= `COLLAB_TOKEN` from server `.env`).
  - **Render `.mcp.json` (closes G3):** substitute `${PARACHUTE_URL}`/`${PARACHUTE_VAULT}`/`${PARACHUTE_TOKEN}` in `/home/user/prism/.mcp.json.template` and write `/home/user/prism/.mcp.json` (gitignored).
- **Human action:** None if vault token is in-session; otherwise paste the token. App must be restarted only if it was running before config changed (config hot-reloads on Settings save, but a file written behind its back may need a relaunch — state this).
- **Config artifacts written:**
  | File | Keys |
  |---|---|
  | `~/Library/Application Support/prism/prism-config.json` (macOS) / `~/.config/prism/prism-config.json` (Linux) | `parachute_url`, `parachute_vault`, `parachute_api_key`, `collab_url`, `collab_token` (+ any integration fields if done here) |
  | `/home/user/prism/.mcp.json` | rendered `parachute-vault` MCP server block |
- **Verify (pass):**
  - `prism-config.json` parses as JSON and contains the 5 keys.
  - `.mcp.json` parses and contains a concrete (no `${...}` left) URL + Bearer.
  - Vault auth from the rendered MCP: in a fresh Claude Code session, `mcp__parachute-vault__vault-info` returns vault stats (proves URL + token + MCP endpoint all good — this is the **auth check `validate_config` lacks**, G6).
  - If desktop app is runnable here: launch it, open a note — it loads (proves `parachute_api_key` valid for reads).
- **Verify (fail):** `${...}` left in `.mcp.json` ⇒ render didn't substitute. 401 from `vault-info` ⇒ wrong token.

---

### 2.6 `prism-setup-integrations` — Matrix / Google / Anthropic / Notion / Transcripts  (BUILD)

One skill, five labeled sections. Each section is "collect credential(s) → write to `prism-config.json` → run the existing check → report." All credential acquisition is **human action** (OAuth consent, homeserver choice, dashboard key generation) — the skill **cannot** do these silently and must say so.

| Section | `AppConfig` field(s) (`config.rs`) | Automates | Human action (cannot automate) | Verify (pass) |
|---|---|---|---|---|
| **Matrix** | `matrix_homeserver`, `matrix_user`, `matrix_access_token`, `matrix_device_id` | Write fields; run `test_matrix` (`/sync` ping). Starts `message_sync` (60s) when token present. | Run/choose a homeserver (Synapse/Dendrite; default `http://localhost:8008`); obtain an access token (login). **No homeserver provisioning exists.** | `test_matrix` returns joined rooms / 200; `message_sync` status shows `last_run`, no `last_error`. |
| **Google** | `google_account_primary`, `google_account_agent` | Detect `gog`: `which gog`; run `check_google_cli`; trigger calendar/email sync. Starts `calendar_sync` (5min) + `email_sync` (3min). | Install `gog` CLI; complete Google **OAuth** via `gog` (its own keyring) — Prism never holds Google tokens. | `which gog` resolves; `gog` account is authed; `calendar_sync`/`email_sync` status clean. |
| **Anthropic / Claude** | `anthropic_api_key` (Keychain fallback on macOS) | Detect CLI: `check_claude_cli` / `which claude`; store key in config or Keychain. | Have `claude` CLI installed + logged in (the agent path uses `claude -p` subprocess, **not** the HTTP API). Optionally paste an API key. | `claude --version` works; an agent dispatch (`claude -p`) returns output; `.mcp.json` is picked up (vault MCP tools available in that session). |
| **Notion** | `notion_api_key` | Write key; run `test_notion`. Starts `notion_task_sync` (background). | Create an integration at notion.com/integrations + share DBs with it; paste the secret. | `test_notion` lists accessible DBs/200; `notion_task_sync` status clean. |
| **Transcripts** | `fathom_api_key`, `fireflies_api_key`, `meetily_db_path` (also `readai_api_key`, `otter_api_key`) | Write keys/path; auto-discover Meetily SQLite on macOS. Starts `transcript_sync` (10min). | Obtain Fathom/Fireflies API keys; locate Meetily DB. | `transcript_sync` status shows `items_processed` ≥ 0, no `last_error`. |

- **Config artifact:** the same `prism-config.json` (merge, never clobber unrelated keys).
- **Skill-wide verify (pass):** every **enabled** integration's background service appears in Settings → Service Status with `running` + recent `last_run` + empty `last_error`. Disabled integrations leave their service stopped (correct — services are config-gated).

> **Honest note on Anthropic:** there is **no direct Anthropic HTTP/SDK routing** in the desktop today — `ClaudeClient` (`clients/anthropic.rs`) spawns `claude -p`. `anthropic_api_key` is stored but only used as a Keychain-backed value; model routing goes to Claude CLI or local Ollama (`ModelRouter`). The skill should configure the **CLI path**, not promise SDK features.

---

## 3. `plugin.json` MANIFEST CHANGES  (BUILD)

File: `/home/user/prism/.claude-plugin/plugin.json`.

1. **Skills are directory-discovered** (`skills: ./.claude/skills/`). Creating each `prism-setup*/SKILL.md` under `.claude/skills/` is sufficient — confirm the manifest needs **no per-skill enumeration**. If it *does* enumerate, add the new names.
2. Keep the `parachute-vault` MCP block as-is (it already uses `${PARACHUTE_URL}/${PARACHUTE_VAULT}/${PARACHUTE_TOKEN}` expansion).
3. Bump `version`.
4. **Fix the README** (`/home/user/prism/.claude-plugin/README.md` line ~9): replace the false single `prism-setup` claim with the real, now-existing skill list (the 5 data skills + the new `prism-setup*` family).
5. Validate installability:
   ```bash
   claude plugin validate /home/user/prism/.claude-plugin
   ```
   (If that subcommand differs in your CLI version, install locally: `/plugin install /home/user/prism` and confirm the skills appear.)

---

## 4. ORDERED BUILD PLAN

Do these in order; each ends in a runnable/verifiable state.

| Step | Mode | Action | Done when |
|---|---|---|---|
| 1 | CONFIGURE | **Confirm the gap.** `ls /home/user/prism/.claude/skills/` — verify no `prism-setup/`. Read README L9 + `PROGRESS.md` L-Onb-Seed. | You've reproduced the doc lie. |
| 2 | CONFIGURE | **Verify machinery works before wrapping it.** Run `prism-setup.ts --dry-run` against the live vault; then real run on a throwaway vault/`.env`; run it again → expect idempotent seed. | `.env` written (chmod 600); 2nd seed = all unchanged. |
| 3 | BUILD | **Add root `setup` script (G4).** In `/home/user/prism/package.json` add `"setup": "npm run setup:full -w @prism/server"` (match the real server script name). | `npm run setup` from repo root works. |
| 4 | BUILD | **Standalone seed entrypoint (G5 helper for §2.4).** A small `scripts/seed.ts` (or `-e` one-liner documented in the skill) calling `seedTagSchemas()` from `.env`. | Seed runs without rewriting `.env`. |
| 5 | BUILD | **`.mcp.json` render (G3).** Add a renderer (in `prism-setup.ts` or a new `scripts/render-mcp.ts`) that substitutes the template → `/home/user/prism/.mcp.json`. Update CLAUDE.md to match reality. | `.mcp.json` has no `${...}` and `vault-info` MCP works. |
| 6 | BUILD | **Write the skills.** `mkdir` each `.claude/skills/prism-setup*/` and author `SKILL.md` (frontmatter: `name`, `description`, `version` + body) per §2. Start with `prism-setup-vault`, `-server`, `-schema`, `-desktop`, then `-integrations`, then the `prism-setup` orchestrator. | Each skill loads and drives its domain. |
| 7 | BUILD (optional, G6) | **Strengthen `validate_config`** (`config.rs`): add an authed call (Bearer token → vault) and an MCP-endpoint reachability check; extend `ConfigHealth` with `auth_ok`/`mcp_ok`. Re-export via `configApi.validate`. | `validate_config` distinguishes "reachable" from "authorized." |
| 8 | BUILD (optional, G5) | **Expose `seedTagSchemas` as a Tauri command** + have Onboarding **step 2 verify** (poll `GET /tags` / `list-tags`) before advancing. | Wizard confirms tags exist, not just "you can skip." |
| 9 | BUILD | **Manifest + README** per §3; bump version; validate plugin. | `claude plugin validate` / local install passes. |
| 10 | CONFIGURE | **Fix tracking docs.** Update `PROGRESS.md` L-Onb-Seed and CLAUDE.md "Onboarding & setup" to state: skills now exist; `prism-setup.ts` is the underlying script; `validate_config` does X. | No doc claims an artifact that doesn't exist. |
| 11 | CONFIGURE | **End-to-end dry run** of the whole plugin against the live environment (§5). | Acceptance checklist passes. |

---

## 5. ACCEPTANCE CHECKLIST — brand-new user, plugin end-to-end

A user with only a fresh machine + this repo, driven by the plugin, must reach a working Prism. Mark each PASS/FAIL.

### Plugin integrity
- [ ] `claude plugin validate /home/user/prism/.claude-plugin` (or local install) passes; skills appear in the skills list.
- [ ] Every `.claude/skills/prism-setup*/SKILL.md` has valid frontmatter (`name`, `description`, `version`) + body.
- [ ] `.claude-plugin/README.md` lists **only** skills that exist (no `prism-setup`-only lie).
- [ ] `PROGRESS.md` L-Onb-Seed and CLAUDE.md match reality.

### Vault (`prism-setup-vault`)
- [ ] `curl -fsS http://localhost:1940/health` → 200.
- [ ] Authed call with minted token → 200 (not 401); token is a hub JWT, not `pvt_*`.

### Server (`prism-setup-server`)
- [ ] `apps/server/.env` exists, chmod 600, has all required keys; `assertConfig()` does not throw.
- [ ] `npm run typecheck -w @prism/server` clean; `verify-gateway.ts` passes.
- [ ] Server starts; `curl -fsS http://localhost:8787/` serves the PWA.
- [ ] Owner magic-link sign-in works (email via Resend, or console log in dev); owner sees full vault via `/api/notes`.

### Schema (`prism-setup-schema`)
- [ ] `seedTagSchemas()` second run = `created:0, updated:0, unchanged:<N>` where `<N>` = entry count of `tag-schemas.json`.
- [ ] `list-tags` shows the canonical set; no existing field def / non-empty description was overwritten.

### Desktop (`prism-setup-desktop`)
- [ ] `prism-config.json` written with `parachute_url/vault/api_key` + `collab_url/token`; parses as JSON.
- [ ] `/home/user/prism/.mcp.json` rendered, **no `${...}` remaining**.
- [ ] `mcp__parachute-vault__vault-info` returns stats in a fresh session (auth + MCP endpoint proven).

### Integrations (`prism-setup-integrations`) — only those the user chose
- [ ] Each enabled service appears in Settings → Service Status: `running`, recent `last_run`, empty `last_error`.
- [ ] Matrix `test_matrix` / Google `which gog` + sync / Notion `test_notion` / transcripts `transcript_sync` each pass for enabled ones.
- [ ] Disabled integrations leave their background service stopped (config-gated, expected).

### Orchestrator (`prism-setup`)
- [ ] Full run reaches a working Prism: vault reachable + authed, server up + owner signed in, 35-ish tags seeded, desktop config + `.mcp.json` valid, chosen integrations green.
- [ ] **Re-running the orchestrator is idempotent** — every domain reports "already configured / unchanged," nothing rewritten, no secrets rotated (unless `--force`).

---

## 6. KNOWN LIMITATIONS to state plainly in the skills (don't pretend to solve)

- **Matrix homeserver provisioning** is out of scope — the skill configures an *existing* homeserver; it does not stand up Synapse/Dendrite.
- **Google OAuth** runs through `gog`'s own keyring; Prism never holds Google tokens. The skill can only verify `gog` is installed + authed.
- **Anthropic** = Claude **CLI** path only (`claude -p`); no direct HTTP/SDK routing in desktop today.
- **Notion / Fathom / Fireflies / ReadAI / Otter** keys are created in each vendor's dashboard — manual paste, no automated key issuance.
- **Parachute token minting** stays a `parachute auth mint-token` step the skill *runs for the user* but cannot magic into existence without the CLI + hub present.
- **`COLLAB_TOKEN`** is shared server↔desktop by the skill copying it from `.env` into `prism-config.json` — there is no auto-enrollment/QR pairing.
- **Federation** (`PEER_SIGNING_KEY`, peer pairing) is gated/off by default and has documented convergence gaps; the skill should only touch it on explicit opt-in.
- **Web-owner onboarding** is disabled by default — first-run setup is desktop/CLI/plugin, not the browser.

---

## 7. KEY FILE REFERENCES

| Purpose | Path · symbol |
|---|---|
| Plugin manifest | `/home/user/prism/.claude-plugin/plugin.json` |
| Plugin README (fix L9) | `/home/user/prism/.claude-plugin/README.md` |
| MCP template (render this) | `/home/user/prism/.mcp.json.template` → `/home/user/prism/.mcp.json` |
| Server setup script | `/home/user/prism/apps/server/scripts/prism-setup.ts` |
| Seed library + guards | `/home/user/prism/apps/server/scripts/lib/seed-tag-schemas.ts` (`if (!(fname in curFields))`, `if (!curDescription && !!desiredDescription)`) |
| Canonical schema | `/home/user/prism/packages/core/src/lib/schemas/tag-schemas.json` |
| Server config validation | `/home/user/prism/apps/server/src/config.ts` → `assertConfig()` |
| Federation keypair | `/home/user/prism/apps/server/src/auth/peer.ts` → `generateKeyPairB64url()` |
| Gateway security e2e | `/home/user/prism/apps/server/scripts/verify-gateway.ts` |
| Desktop config model + validate | `/home/user/prism/apps/desktop/src-tauri/src/commands/config.rs` → `AppConfig`, `validate_config`, `ConfigHealth`, `check_*` |
| Desktop config client wrapper | `/home/user/prism/packages/core/src/lib/agent/client.ts` → `configApi.validate()` |
| Background services | `/home/user/prism/apps/desktop/src-tauri/src/services/mod.rs` → `ServiceManager` |
| Onboarding wizard | `/home/user/prism/packages/core/src/components/layout/Onboarding.tsx` |
| Onboarding gate | `/home/user/prism/packages/core/src/App.tsx`; `/home/user/prism/apps/web/src/main.tsx` (`isViewer`/`skipOnboarding`) |
| Setup guide | `/home/user/prism/docs/onboarding.md` |
| Roadmap tracking (fix) | `/home/user/prism/docs/roadmap/PROGRESS.md` (L-Onb-Seed) |

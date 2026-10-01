# Architecture v2 — sub-agent work plan

Companion to [`PROPOSAL.md`](PROPOSAL.md). Status: **for review** · 2026-09-30.

## 0. Operating model

**Roles.**
- **Overseer** (the main Claude session): owns this plan, spawns work packages, reviews every diff, runs the
  integration gates, and is the **only** actor that touches production (pm2, `~/.parachute`, live DBs, cutovers).
- **Implementer** (one sub-agent per work package, in its own git worktree off the integration branch): builds, tests,
  documents, and reports back. It never deploys.
- **Reviewer** (a fresh sub-agent, or `/code-review`, plus `/security-review` on packages marked 🔒): reads the diff
  cold against the package's acceptance criteria.
- **Verifier** (a sub-agent using the sandbox recipe below): exercises anything that touches Parachute against a
  copy of the data on alternate ports.

**Model choice.** Use Opus for anything marked 🔒 (auth, agent runtime, MCP, governance integrity, data-deleting
ingest) and for cross-cutting design. Use Sonnet for mechanical ports, UI wiring, docs, and test expansion.

**Branching.** Integration branch `arch/v2` (off `main` after D7). Each package lives on `arch/<wp-id>` in a
worktree and merges into `arch/v2` only after its gates pass. `arch/v2` merges to `main` per milestone.

**Concurrency.** At most **3 implementers at once**, each in a different lane. That keeps review bandwidth, merge
conflicts and the 16 GB host sane. Test runs are cheap (`npm test` ≈ 4 s); never run the sandbox for two packages at once.

**Hard rules for every sub-agent** (paste into each prompt):
1. Never modify production: no `pm2 restart`, nothing under `~/.parachute`, no writes to `apps/server/prism-server.db`,
   no global `bun add`, no launchd changes. Production changes are the overseer's.
2. Server tests **only** via `cd apps/server && npm test`. Raw `node --test` has wiped the live DB before.
3. Verify scripts only with an explicit env file pointing at the sandbox. Never default to `:8787` / `:1940`.
4. Anything that touches the vault is verified on the **sandbox**: a `PARACHUTE_HOME` copy with an empty
   `services.json` and no cloudflared or expose state. Otherwise the hub supervisor can kill the live vault, or a copied
   tunnel config can hijack production traffic. The sandbox Prism server has no `SECRETS_KEY` or mirrors and uses
   `INDEX_INTERVAL_MS=0`, so no workers start.
5. Shell: write `${var}` before a `:` (zsh treats `$v:w…` as a history modifier). Never print tokens; decode claims only.
6. The repo is **public**: no vault contents, personal names, emails or tokens in code, tests, fixtures or docs.
7. Definition of done:
   - typecheck `packages/core`, `apps/web`, `apps/desktop`, `apps/server` (plus `cargo check` if Rust changed);
   - `npm test` green, with new tests for new behaviour;
   - web build succeeds;
   - CLAUDE.md updated where behaviour or gotchas changed;
   - a short report: files, tests, risks, and anything not done.

**Gates per package:** implementer DoD → reviewer (🔒 adds a security review) → verifier (if it touches the vault
or ingest) → overseer merge. **Deploy gates** (overseer only) run `scripts/backup-parachute.sh <label>`, then the
package's rollout steps, then its rollback check.

## 1. Lanes and dependency graph

```
Lane A  Server ingest     WP0.4 ─► WP1.1 ─► WP1.2 ─► WP1.3 ─► WP1.4 ─► WP1.5
Lane B  Auth + clients    WP2.1 ─► WP2.2 ─────────► WP4.1 ─► WP4.2 ─► WP4.3
Lane C  Agent runtime     WP0.1 ─► WP3.1 ─► WP3.2* ─► WP3.3 ─► WP3.4
Lane D  Prism MCP         WP0.2, WP0.3 ─► WP6.1 ─► WP6.2 ─► WP6.3 ─► WP6.4 ─► WP6.5
Lane E  Mobile            (D1) WP5.0 ─► WP5.1 ─► WP5.2* ─► WP5.3 ─► WP5.4 ─► WP5.5
Lane F  Node protection   WP0.5, WP0.6 ─► WP7.1 ─► WP7.2
                          * WP3.2 needs WP2.2; WP5.2 needs WP2.1; WP4.1 needs WP1.x done + WP3.2
```

## 2. Milestones

| Milestone | Contents | Proves | Est. (calendar, 3 lanes) |
|---|---|---|---|
| **M0 Stable node** | Phase 0 | Hardened agent runner, no silent ingest failure, permission bugs closed | ~1 week |
| **M1 Server owns ingest** | WP1.1–1.4 | `Prism.app` can quit on the mini with nothing lost | ~2 weeks |
| **M2 Agent anywhere (web)** | WP2.1–2.2, WP3.1–3.3 | Ask from the PWA on the phone, get pushed the answer | ~2 weeks (parallel with M1) |
| **M3 Laptop client** | WP4.1–4.3 | Laptop app, zero ingest, device token | ~1 week |
| **M4 iPhone app** | WP5.0–5.5 | TestFlight build with agent chat + push | ~2–3 weeks (after D1) |
| **M5 Prism MCP** | WP6.1–6.5 | Member agents get Prism permissions; whole-vault member tokens retired | ~2 weeks (parallel from M0) |

Total ≈ 7–9 calendar weeks with three lanes. M1/M2/M5 run concurrently.

## 3. Work packages

Format for each package:
- **Lane · deps · model · 🔒 if security-critical**
- **Build** — what to build
- **Accept** — acceptance criteria
- **Roll out / back** — deploy and rollback steps

### Phase 0 — Stabilize and harden (all parallel)

**WP0.1 Harden the existing agent runner** · C · — · Opus 🔒
- **Build** — in `apps/server/src/agent-exec.ts` and `routes/agent.ts`:
  - `--strict-mcp-config` with a per-vault 0600 temp config;
  - `--tools ""` plus a vault-MCP allowlist (no `Read`/`WebFetch`/`WebSearch`);
  - `--setting-sources ""`, a fixed empty cwd (`~/.prism/agent-cwd`), a secret-free env allowlist;
  - fix `resolveClaude` (`~/.local/bin/claude`);
  - a global semaphore (`AGENT_MAX_CONCURRENT=1`) and a memory admission check (swap > 80% or free < 15% → queued/503);
  - SSE sends deltas, not the full output each time.
- **Accept**:
  - `scripts/verify-agent-exec.ts` asserts `system/init` lists **only** the target vault's MCP tools (no personal
    vault, no gitcoin, no namecheap) and that the tool list has no host file or shell tools;
  - unit tests cover argv, env and cwd via the injectable `Spawner`.
- **Roll out / back** — restart pm2; revert commit.

**WP0.2 Permission bugs in semantic search and comments** · D · — · Opus 🔒
- **Build**:
  - `routes/rag.ts:47` uses `effectiveCaps(...).has("view")` (not the level ladder);
  - `rag/service.ts` becomes vault-aware (or refuses non-primary vaults);
  - decide and fix whether comment-level actors can write comment threads (`collab.ts:572`): allow only comment-map
    writes server-side, or document "comments need suggest".
- **Accept** — tests: a create-only grant gets no semantic hits; cross-vault leakage is impossible; the comment-level
  behaviour is pinned by a test.

**WP0.3 Governance integrity + freeze whole-vault member tokens** · D · — · Opus 🔒
- **Build**:
  - `mutateGovernance` stamps an HMAC (`GOVERNANCE_SIGNING_SECRET`) over the canonical governance metadata;
  - `governance-store` parse ignores unsigned or invalid notes, and logs them loudly;
  - a one-time owner-run `sign-existing` migration;
  - gate member whole-vault token minting (`routes/mcp.ts`) behind `MEMBER_VAULT_TOKENS=false` by default (existing
    tokens are listed and can be revoked from the UI).
- **Accept**:
  - a forged `governance-membership` note written straight to the vault compiles into **no** grant;
  - all governance tests pass;
  - `E2E_FAKE_VAULT=1 ./scripts/e2e-governance.sh` passes.
- **Roll out / back** — run the migration on the sandbox first, then production after a backup. Roll back by
  unsetting the secret, which disables verification.

**WP0.4 Desktop ingest switch** · A · — · Sonnet
- **Build**:
  - add `ingest_mode: "host" | "client"` to `AppConfig` (default `host`; `client` starts no services and no
    scheduler, `services/mod.rs`, `lib.rs:133`);
  - add per-service flags (`disable_email_sync`, `disable_calendar_sync`, `disable_meetily_sync`,
    `disable_embedding_index`, `disable_skill_scheduler`, `disable_notion_task_sync`);
  - stop `ensure_default_skills` from rewriting skill prompts on every launch;
  - add a Settings UI toggle.
- **Accept** — Rust config tests; in `client` mode the Service Status panel shows every service disabled.
- **Roll out / back** — overseer sets `disable_embedding_index=true` on the mini (the server sweep already
  covers it) and rebuilds and restages the desktop.

**WP0.5 Worker observability + staleness alerts** · F · — · Sonnet
- **Build**:
  - `GET /acl/workers` (owner) returns per source (server workers **and** desktop-owned sources, read from the
    newest note of each source) the last success, last error and failure streak;
  - a ServerPanel card;
  - an alert when a source is stale beyond its threshold (email > 30 min, calendar > 1 h, matrix > 15 min), delivered
    through the existing email sender (Resend) and a vault `alert` note.
- **Accept** — tests with the fake vault; a simulated stale source triggers exactly one alert per episode.

**WP0.6 Ingest hygiene** · A/F · — · Sonnet — **FOLDED INTO WP1.2 (2026-09-30).**
- Trace finding: the create-then-409 storm (≈200 per 20k vault requests) is the **desktop** email sync.
  - For each email it GETs the note (exists), looks up the sender, then POSTs a person note that already exists.
  - The cause is that `person_linker`'s lookup misses existing people.
- That code moves to the server in WP1.2, whose port must:
  - use `if_exists` upserts;
  - look people up robustly (exact path + normalized email/name index, not a capped list).
- No separate desktop fix. The original scope below stays as the checklist for WP1.2.
- **Build**:
  - ingesters that create-then-409 switch to `if_exists: "ignore" | "update"` (find the 409 source first with
    `PRISM_VAULT_TRACE=1`, then fix every create-or-patch ingester);
  - Matrix rollover archive creates use `if_exists: "error"` (so a crash-retry is still detected).
- **Accept** — vault 409 rate on `POST /notes` drops to ~0 over one hour of the trace.

### Phase 1 — The server owns ingest (lane A, sequential cutovers)

**WP1.1 Server skill scheduler** · A · WP0.4, WP0.1 · Opus
- **Build** — `apps/server/src/worker/skills.ts`:
  - port `check_and_dispatch` and `structured_skill` (skill notes stay the source of truth);
  - the LM Studio client with an admission guard (reuse the lms-guard thresholds);
  - `claude`-profile skills go through the WP0.1 runner;
  - runs are written as `agent-dispatch` notes (AgentActivity compatible);
  - `SKILLS_ENABLED=false` by default.
- **Accept** — fixture tests for scheduling (cron + interval), the structured-skill parse, and admission refusal.
- **Roll out / back** — `disable_skill_scheduler=true` on the desktop → restart it → `SKILLS_ENABLED=true` →
  restart pm2 → watch one full cycle of `message-classify` and `clickup-task-triage`. Roll back in reverse. Never run
  both schedulers.

**WP1.2 Server Gmail ingest** · A · WP1.1 · Sonnet (Opus review) — **MERGED 2026-09-30, Gmail left OFF.**
- **Live finding: Gmail is not the email pipeline.**
  - The Google account has no Gmail service (`400 failedPrecondition`).
  - The desktop Gmail sync has produced nothing since 2026-07-13; now disabled with `disable_email_sync=true`.
  - All current email (2.2k notes, `metadata.source: proton-bridge`) comes from `omniharmonic_agent/scripts/proton_mail.py`, a 5-min launchd job reading the local Proton Bridge over IMAP.
- **The load and the 409 storm come from that script, not Prism:**
  - every run refreshes read/unread flags for about 500 recent messages with one `GET /notes/<path>` each;
  - its get-by-path → create fallback 409s on existing paths.
- **Kept from WP1.2:** the index-based `people.ts` linker, `if_exists`/`links` in the vault client, Matrix people-linking (flag off). The Gmail worker is dormant.
- **Next (proposed WP1.2b):** port Proton IMAP ingest into the Prism server, reusing `people.ts` and a single list-query flag refresh, and retire `proton_mail.py`. Until then, fix the flag refresh in the agent repo.

**WP1.2b Server Proton ingest** · A · WP1.2 · Opus 🔒 (email + a mail credential) — **BUILT on `arch/wp1.2b`, OFF by default.**
- **What it does:**
  - `worker/proton.ts` + `worker/proton-parse.ts` port `proton_mail.py sync` byte-for-byte. Parity is pinned against fixtures produced by the script's own functions on synthetic mail.
  - Each pass makes one lean vault list and one header-only IMAP fetch. Full sources are fetched only for new messages.
  - The flag refresh sends `{isUnread, labels}` PATCHes with `if_updated_at`.
  - Creates use `if_exists: "ignore"`. There are no deletes and no content rewrites.
- **Credential:** kind `proton-bridge`. Loopback host only, and the cert pin is required. The pin is checked before LOGIN.
- **Gates:** `PROTON_SYNC_ENABLED` and `PROTON_SHADOW`. Shadow means zero writes, with persisted intents at `GET /acl/workers/proton/intents?verify=1`.
- **Health:** `proton` server source. `assertConfig` refuses Gmail and Proton both live.
- **Security review fixes (5f1012f → follow-up):**
  - **C1:** linear HTML scanners replace the quadratic regexes, plus a 500 KB cap per text part.
  - **H1:** the Gmail stand-down is replaced by the `assertConfig` refusal.
  - **M1:** the credential routes are server-owner only, a repoint needs the password again, and a concurrent sync gets 409.
  - **M2:** messages are size-capped by RFC822.SIZE, QP decodes into a preallocated buffer, and the body cut walks code points.
  - **M3:** real loopback TLS pin tests.
  - **L1–L4:** RFC 2231 parameters decode without a spread, skip lists cover poison, oversize and collision UIDs, a dropped connection during mailbox select fails the pass, and intents and logs carry no paths.
- **Roll out / back:** see `docs/runbook/proton-ingest.md`.
  - Run shadow ≥24 h next to the script.
  - Then `launchctl bootout` + `disable` the `com.omniharmonic.proton-mail` agent.
  - Then go live and run the duplicate check on `metadata.messageId`.
  - Roll back with the flag off and `launchctl bootstrap` of the agent.
- **Follow-up in the agent repo** (not this WP): repoint `check_oauth.py`'s 6 h staleness alert at `GET /acl/workers`.
- **Build**:
  - `worker/gmail.ts` via the co-located `gog` CLI (like `worker/googledocs.ts`);
  - **identical** note paths and dedupe keys (`vault/messages/email/<slug>-<threadId>`, `metadata.threadId`);
  - dedupe against the **full** set, not the desktop's 500-note window;
  - port `services/person_linker.rs` (find or create person notes by name/email/Matrix id, then link) as a shared
    server helper. Email needs it, and so does Matrix: the desktop's message sync used it, so check whether
    person-linking for message threads was lost when Matrix ingest moved server-side, and restore it if so;
  - the account comes from the secret store.
- **Accept** — fixture test: an existing desktop-created note is updated, not duplicated.
- **Roll out / back**:
  - `disable_email_sync=true` → restart the desktop → enable the server source;
  - watch for duplicates for two intervals (query by `metadata.threadId` counts);
  - roll back by swapping the flags.

**WP1.3 Server Calendar ingest** · A · WP1.2 · Opus 🔒 (it deletes)
- **Build**:
  - `worker/calendar.ts` with the same `vault/meetings/<date>/<slug>` + `calendarEventId` convention;
  - port the truncation guard;
  - a `CALENDAR_DELETE_MODE=log|archive|delete` flag (default `log`);
  - `POST /api/calendar/sync?from&to` replaces `calendar_sync_range`.
- **Accept** — fixture tests for create, update, cancel and "vanished event"; in `log` mode no vault deletes happen.
- **Roll out / back**:
  - run in `log` mode while the desktop still syncs, and diff the server's intended deletes against the desktop's
    actual ones for 24 h;
  - then the one-step cutover as in WP1.2;
  - enable `archive` (never `delete`) after a clean week.

**WP1.4 Retire leftovers** · A · WP1.3 · Sonnet
- **Build**:
  - Meetily: retire it (sentinel path; remove the loop) unless D-decision says port;
  - the Notion task sync (idle) and the `index_messages` button;
  - switch the mini's desktop to `ingest_mode: client`.
- **Accept** — the desktop in client mode on the mini; M1 check: quit `Prism.app` for an hour and lose nothing.

**WP1.5 Live actions on the server** · A · WP1.2 · Opus 🔒
- **Build**:
  - admin-only, audited `/api/google/gmail/*` (send, reply, archive, label);
  - `/api/google/calendar/*` (RSVP, create);
  - `/api/matrix/*` (send, react), with a room allowlist for anything an agent may trigger;
  - wire the web shim and core seams to them.
- **Accept** — route tests plus an audit-log entry per action; the non-admin/link/anon matrix (403 for all);
  rate limits.

### Phase 2 — One auth plane (lane B)

**WP2.1 Device tokens (native sign-in)** · B · — · Opus 🔒
- **Build**:
  - `/auth/device/authorize` (a browser page reusing the existing login flows, PKCE, a registered redirect of
    `prism://auth/callback` or a universal link);
  - `/auth/device/token` (code → token, rate-limited) and `/auth/device/revoke`;
  - a `device_tokens` table (hashed, `pd_` prefix, label, last-seen, expiry);
  - bearer resolution in `auth/actor.ts` **and** collab `resolveLevel`;
  - CORS allowing `tauri://localhost` and `http://tauri.localhost`;
  - a device list with revoke in Account settings.
  - Must not loosen the loopback-only COLLAB_TOKEN owner path.
- **Accept**:
  - tests: full PKCE round-trip;
  - a wrong verifier, replayed code, expired or revoked token each 401;
  - a device token works over tunnel-style headers where COLLAB_TOKEN does not;
  - a security review.

**WP2.2 Client transport for native shells** · B · WP2.1 · Sonnet
- **Build**:
  - `apps/web` gains a `native` build mode (no service worker; configurable `API_ORIGIN`; an `Authorization: Bearer`
    device token supplied by a host hook);
  - fetch-based SSE helper (EventSource can't send headers);
  - collab provider token param;
  - IndexedDB read-through cache in `HttpVaultClient` (also benefits the PWA).
- **Accept** — web build (PWA mode) unchanged; a native-mode build runs against the sandbox with a device token.

### Phase 3 — Agent runtime (lane C)

**WP3.1 Durable sessions + stream-json runner** · C · WP0.1 · Opus 🔒
- **Build**:
  - tables `agent_sessions` / `agent_turns` / `agent_events`;
  - a stream-json → `AgentEvent` normalizer (text deltas coalesced, tool calls redacted and truncated);
  - `--session-id` → `--resume`;
  - routes `POST /sessions`, `POST /sessions/:id/turns`, `GET /sessions/:id/stream?after=N` (SSE replay), and cancel;
  - a boot sweep that marks orphaned turns `interrupted`;
  - a transcript mirrored to `vault/agent/sessions/<date>/<slug>` (`agent-session` + `agent-dispatch` tags);
  - `/api/agent/dispatch` kept as the one-shot alias.
- **Accept**:
  - tests from recorded stream-json fixtures;
  - a reconnect with `after=N` replays exactly the missed events;
  - a kill-and-restart marks the turn `interrupted`;
  - the concurrency cap queues the second turn.

**WP3.2 Agent client seam + web chat** · C · WP3.1, WP2.2 · Sonnet
- **Build**:
  - an `AgentClient` interface in `packages/core` (like `VaultClient`) with `HttpAgentClient`;
  - `PanelChat` and a full "Agent" tab on the server API (session list, streaming, tool-activity chips, touched-note
    links, cancel);
  - AgentActivity reads sessions on web;
  - the desktop keeps the Tauri path until WP4.
- **Accept** — Playwright on the sandbox: start a session, background the tab, reconnect, and see the full reply;
  mobile viewport.

**WP3.3 Push notifications** · C · WP3.1 · Sonnet
- **Build**:
  - Web Push (VAPID keys in `.env`, a `push_subscriptions` table, `POST /api/agent/push/subscribe`);
  - a push on turn completion carrying ids only (no content leaves through Apple or Google);
  - a PWA service-worker `push` handler with a deep link `/agent/:sessionId` (client route; the service-worker
    denylist stays `/api/*`).
- **Accept** — a push delivered to a real phone's installed PWA; the payload contains no note content.

**WP3.4 Profiles and budgets** · C · WP3.1 · Sonnet
- **Build** — profiles `vault-ro | vault-rw | skill`; per-session and per-day `--max-budget-usd`; a UI picker; later
  swap vault MCP for Prism MCP tools (after WP6.2).
- **Accept** — a read-only profile cannot call `create-note` or `update-note` (asserted from `system/init`).

### Phase 4 — Laptop client (lane B)

**WP4.1 `apps/client` Tauri shell (macOS)** · B · WP2.2, WP3.2, M1 · Opus
- **Build**:
  - a new Tauri 2 app bundling the native-mode web build;
  - keychain storage for the device token (small custom plugin);
  - deep-link handler for the sign-in callback;
  - server-origin setting;
  - no vault token and no `localhost` CSP entries.
- **Accept** — on a machine that isn't the mini, sign in, browse, edit, collab, agent chat, with zero ingest
  processes (verified with the worker status from WP0.5).

**WP4.2 Native extras** · B · WP4.1 · Sonnet
- **Build** — menu-bar quick capture, global shortcut, native notifications for agent completion, export and
  drag-drop.
- **Accept** — each extra covered by a manual checklist plus unit tests where possible.

**WP4.3 Retire host-mode desktop** · B · WP4.1, WP1.4 · Sonnet
- **Build** — the mini runs `apps/client` too; the legacy desktop build is archived; remove `parachute_api_key` and
  `collab_token` from client configs; the docs update the topology.
- **Accept** — no process on any client holds a vault token (grep the configs); `/acl/workers` is green.

### Phase 5 — iPhone app (lane E)

**WP5.0 Toolchain** · E · D1 · overseer + user
- **Build**:
  - install Xcode (~15 GB of the 203 GB free);
  - `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`;
  - CocoaPods;
  - Apple Developer enrollment, and signing via App Store Connect API key.
- **Accept** — `tauri ios init` runs clean in `apps/client`.

**WP5.1 iOS target skeleton** · E · WP5.0, WP4.1 · Sonnet
- **Build** — the iOS target of `apps/client`; mobile UX already exists (pill, bottom sheets); safe-area and
  keyboard handling in WKWebView.
- **Accept** — the simulator runs against the sandbox server.

**WP5.2 Mobile sign-in + keychain (+ biometrics)** · E · WP5.1, WP2.1 · Sonnet (Opus review)
- **Build** — the system-browser PKCE flow via `ASWebAuthenticationSession`; the token in the keychain, unlocked
  with Face ID.
- **Accept** — a device appears in Account settings and revoking it signs the phone out.

**WP5.3 Agent chat + APNs** · E · WP5.2, WP3.3 · Opus
- **Build** — a server APNs sender (a `.p8` key, `http2`) alongside Web Push; the device registers its token; a
  notification tap deep-links into the session; share-sheet capture into a new note or an agent prompt.
- **Accept** — on a real iPhone: ask, lock the phone, receive the push, tap, and see the full transcript.

**WP5.4 Offline + performance on device** · E · WP5.1 · Sonnet
- **Build** — the WP2.2 read-through cache on iOS; check the 3D graph, Excalidraw and MapLibre on a real device,
  degrading gracefully where needed.
- **Accept** — airplane mode: previously opened notes read; edits queue and sync on reconnect.

**WP5.5 TestFlight** · E · WP5.3 · overseer
- **Build** — a signed build, uploaded, installed via TestFlight. A public App Store submission is optional and later.

### Phase 6 — Prism MCP (lane D)

**WP6.1 MCP endpoint + auth** · D · WP0.2, WP0.3 · Opus 🔒
- **Build**:
  - `/mcp` stateless Streamable HTTP (`@modelcontextprotocol/server` v2 + hono adapter);
  - RFC 9728 protected-resource metadata + `WWW-Authenticate`;
  - a Prism PAT table (hashed, per actor, per vault, revocable, `pp_` prefix);
  - the owner's hub JWT also accepted;
  - a per-actor `tools/list`;
  - `/mcp` and `/.well-known/` added to the service-worker denylist (plus `check-sw-denylist`);
  - mountable at `/surface/prism/api/mcp` too.
- **Accept**:
  - conformance tests on initialize-less stateless calls;
  - a 401 challenge shape;
  - the per-actor tool filtering matrix.

**WP6.2 Core note tools** · D · WP6.1 · Sonnet
- **Build** — `prism_whoami`, `query_notes`, `get_note` (+ `_caps` and live-collab flag), `semantic_search`,
  `create_note`, `update_note` (`if_updated_at` required), `delete_note`, `list_tags`, `list_versions`,
  `get_version`, `restore_version`. All call the gateway handlers in-process.
- **Accept** — per tool, the owner / editor / viewer / create-only / link / anon matrix; resource `prism://note/{id}`
  as Markdown.

**WP6.3 Collab-safe tools** · D · WP6.2 · Opus
- **Build**:
  - `update_note` on a live doc applies a minimal Yjs diff via `hocuspocus.openDirectConnection` under origin
    `mcp:<actor>`, not a vault overwrite;
  - `list_comments`, `add_comment` (text-anchored), `resolve_comment`, `suggest_edit`, `sheet_read`,
    `sheet_update` (A1 ranges on the `Y.Array`, not a whole-table rebuild).
- **Accept** — a concurrent human edit plus an MCP edit both survive (a two-client Yjs test); a spreadsheet range
  edit leaves other cells' concurrent edits intact.

**WP6.4 Governance, sharing, dashboards, prompts** · D · WP6.2 · Sonnet
- **Build** — `governance_state`, `propose_change`, `vote`, `withdraw_proposal`, `note_access`, `share` (existing
  accounts only, subset rule), `dashboard_query` (server-side run of `filter-engine`), resources and prompts per
  `arch-mcp.md` §5.
- **Accept** — governance e2e through MCP (propose → vote → applied); a share escalation attempt is denied.

**WP6.5 Migrate members to Prism MCP** · D · WP6.2, WP6.4 · Sonnet
- **Build** — the "Connect your agent" UI mints Prism PATs with copy-paste config for Claude Code, Claude Desktop
  and other MCP clients; revoke existing whole-vault member tokens (with notice); docs.
- **Accept** — no active whole-vault member tokens; a member agent sees exactly their Prism-visible notes.

**WP0.1b Admission metric fix (found live 2026-09-30)** · C · — · Sonnet
- **Problem:** the memory guard's `swap > 80%` test mis-fires on macOS, which grows swap on demand. On the first server triage run, swap sat at 81–95% while `memory_pressure` reported 27% free, and classification stopped after 1 of 243 notes.
- **Stopgap:** production runs with `AGENT_SWAP_MAX_PCT=97`.
- **Fix:** on darwin, gate on `memory_pressure` free% (primary) plus an **absolute** swap-free floor (e.g. `AGENT_SWAP_MIN_FREE_MB=512`); keep the percentage test on Linux. Apply it to both the agent runner and the skills LM Studio admission.

### Phase 7 — Node protection (lane F, after M0)

**WP7.1 Tree projection** · F · WP0.6 · Sonnet
- **Build**:
  - `GET /api/tree` served from a server-side projection (id/path/tags/type/updatedAt), rebuilt from one lean vault
    list and kept fresh by write-through in the gateway plus the vault's live `/api/subscribe` WebSocket;
  - web/desktop `listTree` uses it;
  - an ETag / `If-None-Match` so clients revalidate for free.
- **Accept** — the tree loads in < 200 ms warm; a vault-side edit made elsewhere appears within 5 s; payload < 2 MB.

**WP7.2 Polling → subscription** · F · WP7.1 · Sonnet
- **Build** — a server-sent invalidation channel (`/api/events`, SSE) fed by vault subscribe; the core query client
  invalidates on events; remove or relax the 10–30 s `refetchInterval`s (Inbox, MessagesDashboard,
  VaultMessagesDashboard, AgentActivity, StatusBar).
- **Accept** — vault request rate with 3 open clients idle drops by ≥ 80% (measured with `PRISM_VAULT_TRACE`).

## 4. First wave (proposed kickoff, after approval + D7)

Three implementers in parallel:
- **WP0.1** (C, Opus)
- **WP0.3** (D, Opus)
- **WP0.4** (A, Sonnet)

Then **WP0.2**, **WP0.5** and **WP0.6** as those land. **WP2.1** starts as soon as a lane frees up; it unblocks both
the laptop and the phone. **WP5.0** needs the user (D1) and can run in the background from day one.

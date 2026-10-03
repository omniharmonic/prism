# Session status — 2026-10-03: wave 2 complete on main

Nothing has been deployed. The production server (pm2 `prism-server`, running from the main checkout) has NOT been restarted — production still runs the release recorded in `CURRENT-RELEASE.md` (`cb3178a`).

## Ownership

Codex has left. All work is owned by Claude (orchestrator) + sub-agents. Process per slice: implement in an isolated worktree under `.worktrees/` → independent adversarial review → fixes → integrate (merge main + slice, root typecheck, full server suite, full fixture e2e) → fast-forward main. Gate for any TestFlight/App Store upload: **every item in `NOTION-PARITY-CHECKLIST.md` passes on main** (owner rule).

## On main (`b60104b`)

| Work | Status |
|---|---|
| Backend: suggest-only enforcement, transcript reconciliation, graph identity/linking + agent graph tools, APNs server | merged, reviewed |
| Wave 1: editor blocks (+ schema handshake), typed properties + database views, pages/navigation/trash/lock | merged, reviewed |
| Wave 2A: mentions, inbox, notifications, Home, access requests | merged, reviewed |
| Wave 2B: media, embeds, attachments, covers, find/replace (`COLLAB_SCHEMA_VERSION = 4`) | merged, reviewed |
| Wave 2C: database depth (AND/OR filters, batch, CSV, templates, peek, inline views) | merged, reviewed |
| Wave 2D: page (subtree) grants, shared-with-me, presence, history attribution, suggest-only client | merged, three review rounds |
| Wave 2E: shell, sync state, search route, offline outbox rework, offline pages | merged, reviewed (outbox rework covered by the final round's suites, not a separate review) |
| Gateway hotfix: non-owner create allowlist, tag/path canonicalisation, system notes, 404 unification, ingest keys on every write route | merged, reviewed |

Last full runs at the tip: server 1997/1997; fixture e2e 766 passed, 1 load flake (`agent-reply:189`, passes alone).

## Known open items

- `thread-reading.spec.ts:160` (reading anchor drifts ~116 px) fails on main in isolation — being bisected on `fix/thread-reading`.
- Closed on `feat/w3-gaps` (see `CLAUDE.md` § Wave 3 gaps): unload guard for live documents; MCP suggestions store the opaque actor id; a plain suggest share opens the live suggest editor in the workspace (governance roles keep the propose draft); ⌘F in read-only live documents; sign-out control; swipe actions; published pages load attachments; duplicated pages copy their attachments; suggestion accepted/declined notifications; My tasks = assigned to me; mentioning members without a person note.
- Still open from that work: template copies (3A's `templateCopy`) do not copy attachments yet; documents written before the MCP change still hold the email in `data-actor-id` (read, not rewritten); a nameless account cannot be mentioned (it could only be shown by email).
- Accepted lows (documented in `CLAUDE.md`): path-existence oracle on create/trash; organize in a tag may add that tag without `share`.

## Wave 3 (in progress)

Per checklist §3: 3A import/export + templates, 3B native completion (universal links; `feat/native-ios` must merge main first), 3C performance + accessibility sweep (runs last), 3D verification-only rows and checklist statuses, plus a gaps group for the list above. Then checklist §4 acceptance (Chromium + WebKit, screenshots light/dark at 1440×900 and 390×844, production smoke, device pass), then the iOS build (`apps/client/scripts/ios-release.sh`) and TestFlight.

## Waiting on the owner

1. **Release timing.** Releasing main to production = server restart (active-turn check + online backup), PWA build, Prism Client reinstall; old app copies show "Update required". Order: server with `COLLAB_SUGGEST_ENFORCED=false` → clients → flag on. Push also needs `APNS_*` env and the `.p8` on the server (0600). Until then production still has the non-owner create passthrough and tag-decoration holes the hotfix closed — harmless while the only accounts are owner/admins; consider `SKILLS_ENABLED=false` if a non-admin member is added before the release.
2. **Parity exclusions** in `NOTION-PARITY-CHECKLIST.md` §1.3 — confirm or pull items in.
3. **Move permission**: organize (current) vs plain edit.
4. **Graph cleanup on the live vault**: needs the release first, then the staged runbook in `BACKEND-STATUS-GRAPH.md`.
5. **Nightly skill install** (`docs/skills/`) — needs approval and a Prism PAT.
6. **Native app embeds**: approve a minimal `frame-src` for Prism Client (YouTube-nocookie, Vimeo); until then embeds are "Open in…" cards in the app.
7. Send `docs/roadmap/parachute-embedded-mode-request.md` to the Parachute team.

## Apple account (done)

Team `83Y42N33H8` (Individual). App ID `com.benjaminlife.prism.client`; APNs key `P2648BP7K4` (file still in `~/Downloads` — move it into the password manager); Developer ID Application + Apple Distribution certificates valid in the login keychain; App Store Connect app "Prism Workspace"; API key `AB84HRLBUA` at `~/.appstoreconnect/private_keys/`; provisioning profile "Prism Workspace App Store".

## Update 2026-10-03 (afternoon) — READ FIRST

**This Mac is the production host and memory is its limit.** Two outages today (Cloudflare 524): agents running suites in parallel, then one 2-worker browser run overlapping the hourly local-model run (7 GB). Rules now:
- At most ONE agent runs tests at a time; agents run single spec/test files only (`--workers=1`, hard `alarm` timeout, `--test-force-exit`), behind a blocking gate: load < 6, memory free ≥ 30 %, `lms ps` not LOADING/PROCESSINGPROMPT/GENERATING, health 200 < 1 s. No agent spawns sub-agents.
- Full suites are run by the orchestrator only, with the two scripts kept in the session scratchpad and copied here in spirit: server = every `test/*.test.ts` one file at a time with `.env.test`; browser = `--shard=k/8 --workers=2` behind the gate with a watchdog that kills the shard when free memory < 18 % or health fails or the model wakes, then retries.
- A worktree needs `node_modules/@axe-core` + `axe-core` (copy from `.worktrees/w5-a11y/node_modules`).

**On main (`d7a99cc`, nothing deployed, production not restarted):** everything in the table above plus wave 3 gaps, import/export/templates, wave 4 editor (schema v5), databases, shell/live updates, and today:
- Accessibility pass 1 (axe sweep, serious/critical clean on swept surfaces; `A11Y-RESULTS.md`).
- Performance (`PERF-RESULTS.md`): initial JS 417.8 KB gzip (editor chunk split, `@prism/core/shell`), tree carries title/aliases, ⌘K keeps results, live editor no longer lists the vault.
- Server conversion off the main thread + durable unsaved live typing (`fix/collab-convert`, six review rounds, final verdict GO): see `CLAUDE.md` conversion section incl. residual risks. New tables/columns are additive (`collab_docs` base/attempt columns, `collab_unsaved`, `collab_set_aside`, `block_append_receipts.applied`).
Last full runs at the tip: server 2271/2271 (163 files), browser 1154 passed / 1 skipped.

**In progress:** `feat/w7-a11y` (`.worktrees/w5-a11y`): keyboard-only journeys, 200 % reflow, touch targets, IME, skipped surfaces.

**Next, in order:** PF-09 reconciler gate (server re-reads every open live doc from the vault every 2 s; design in `PERF-RESULTS.md`) → second checklist verification pass (the earlier 61 row drafts were lost; redo against main, update `PARITY-EVIDENCE.md` + checklist Status) → WebKit pass (`feat/w5-webkit`, stale: recreate from main) → native group (universal links, iOS ZIP save; `feat/native-ios` at 446e0a4 must merge main) → checklist §4 acceptance → iOS build → TestFlight (owner-approved only).

**Small backlog:** tree offline cache cap (the tree crosses the 4 MB read-cache limit at ~20–29k notes; give `/tree` its own limit); set-aside has no UI (owner API only); device-only perf rows (iPhone load, iOS memory).

**Owner decisions added today:** conversion worker heap default 512 MB (`CONVERT_HEAP_MB`; Markdown past ~0.4 MB of dense markup opens as plain text) — keep or raise; run production with a low inline conversion limit at release; an iOS simulator has been booted since last night and holds memory — shut it down if not needed. Earlier ones still open: editor shortcuts, DB-11/DB-12/CO-08 deviations, and items 1–7 above.

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

## Update 2026-10-04 — READ FIRST

**This Mac is the production host and memory is its limit** (two 524 outages on 2026-10-03). Rules:
- At most TWO agents that run tests, each behind its own uniquely named blocking gate script (load < 6, memory free ≥ 30 %, `lms ps` idle, no other Playwright run, health 200 < 1 s), single spec/test files only (`--workers=1`, hard `alarm`, `--test-force-exit`, always `--env-file=.env.test`). No agent spawns sub-agents. Agents never edit a worktree while the orchestrator's suite runs from it.
- Full suites are run by the orchestrator only: server = every `test/*.test.ts` one file at a time; browser = `--shard=k/10 --workers=2` behind the gate with a watchdog (kills the shard when free memory < 18 %, health fails or the model wakes; retries; refuses an unresolved merge; aborts on > 25 failures in a shard). Launch them DETACHED (`nohup … & disown`) — a session restart kills ordinary background tasks.
- A worktree needs `node_modules/@axe-core` + `axe-core` (copy from `.worktrees/w5-a11y/node_modules`).
- The server misses a 5 s health probe once an hour at ~:18: LM Studio JIT-loads the 7 GB model for the hourly skill and macOS pages the server + vault out. Code cannot prevent it (admission sees a calm machine); the fix is the owner's: keep the model resident or load it with 1 parallel slot.

**On main (`1544a330`, nothing deployed, production not restarted since `cb3178a`):** everything in the table above plus wave 3 gaps, import/export/templates, wave 4 editor (schema v5), databases, shell/live updates, and since 2026-10-03:
- Accessibility pass 1 (axe) and pass 2 (keyboard journeys, reflow, touch targets, IME, motion, live regions) — `A11Y-RESULTS.md`.
- Performance (`PERF-RESULTS.md`): initial JS 417.8 KB gzip (`@prism/core/shell`), tree carries title/aliases, ⌘K holds results, reconciler gate (idle open documents cost no vault reads while the tree projection is live).
- Server conversion off the main thread + durable unsaved live typing (six review rounds; residual risks in `CLAUDE.md`).
- Gap batch A: title rename via the move route, search created-by/edited-by (server `editor=`), link card + pasted page URL → mention, pull-to-refresh + Trash/email-row swipes.
- Gap batch B: Save as template + Templates gallery (always private, tags remembered), page/selection Summarize·Draft·Transform on a text-only agent profile, lock refused for owner content writes and for vault-rw agent turns.
- Host-stall branch: `/health` vault timeout + `?live=1`, skill JIT-load guard (swap-out rate), lean Matrix listing, per-vault pass guard, conditional append, failed-room replay, `matrix-lost` health.
- Verification pass 2 + missing-assertion specs: checklist 59 passed / 6 deviation / 35 needs-screenshot / 29 needs-device / 27 partial / 4 missing / 1 not-measured (counted BEFORE gap batches A/B were re-verified). Work list: `PARITY-GAPS.md`.
Last full runs: server 2366/2366 (169 files); browser 1603 passed / 7 skipped (10 shards) on the specs branch tip.

**In progress:** `feat/w9-gaps` (`.worktrees/collab-convert`): slices I–M from `PARITY-GAPS.md` — Suggesting mode tracks every deletion, callout colour + agent mark colour, Markdown export/published TOC round-trip, rename reaching an open live doc, database row rename.

**Next, in order:** integrate `feat/w9-gaps` (un-fixme the pinned tests) → WebKit pass (fix the harness incompatibilities: clipboard permissions, CDP IME, `new Touch()`) → third verification pass against main (re-verify rows closed by batches A/B and I–M; update evidence + checklist) → native group (universal links / `apple-app-site-association`, ⌘N in the native shell, iOS ZIP save; `feat/native-ios` at 446e0a4 must merge main; Rust/iOS builds are memory-heavy — schedule them alone, gated) → checklist §4 acceptance (screenshots, device pass, production smoke) → iOS build → TestFlight (owner-approved only, after 161/161).

**Small backlog:** Matrix reconcile should rotate its starting room (a sweep that always hits its deadline never reaches the end of the list); tree offline cache cap (the tree crosses the 4 MB read-cache limit at ~20–29k notes); set-aside has no UI (owner API only); other ingesters (ClickUp, Fathom, Fireflies) have no in-flight guard; share-route page links open without the share token; phone comments panel close button has no accessible name.

**Waiting on the owner:** (1) LM Studio: keep the model resident or 1 parallel slot. (2) Release timing — order: server (pm2 restart; additive DB migrations run at boot) → PWA → Prism Client; the page-agent actions and "Edited by me" need the new server first; run production with a low inline conversion limit. (3) `CONVERT_HEAP_MB` default 512 (dense Markdown past ~0.4 MB opens as plain text) — keep or raise. (4) Make `prism-rw` the default read-write agent profile (closes the remaining page-lock gap for agents). (5) Phone database month view: 40 day cells under 44 px — needs a design choice (e.g. week view on phones). (6) One screenshot review session (35 rows) and one device session (29 rows), steps in `PARITY-GAPS.md` §b. (7) Earlier items still open: parity exclusions §1.3, move permission (organize vs edit), graph cleanup on the live vault, nightly skill install, native embed CSP, sending the Parachute request doc, editor shortcut choices, DB-11/DB-12/CO-08 deviations, moving `AuthKey_P2648BP7K4.p8` into the password manager, the booted iOS simulator.

## In flight at 2026-10-04 evening (usage limit reached mid-run) — resume here

Main is `1ca8396f` + docs (`c3b7c523` discovery report is an ancestor). On main since the section above: WebKit project + fixes, the five fixes (palette press, Safari Tab, selects, settings column, Markdown to-dos, @-menu date race). Agent brief rules: scratchpad `AGENT-RULES.md` pattern (own gate script; tests serialized; assert against a second client / the Y.Doc, not local editor state). A repeated "flake" has twice been a real product race — investigate, never wave through.

Branches NOT merged (worktree → branch → state):
- `collab-convert` → `feat/w9-gaps`: Suggesting mode tracks removals (chips/images/breaks REFUSED — y-tiptap carries marks only on text), callout colours, export round trip + published TOC, live title on other clients, row names. Round-4 fixes in a WIP commit, verification was queued. Needs: full suites, one more focused review, merge. Also check `editor-toolbar.spec.ts:63`.
- `w2-shell` → `feat/w11-native`: association file, link handling, ⌘N. Review GO; should-fix items + macOS export save in progress. Then suites, merge.
- `w2-sharing` → `feat/w12-notify`: assignment notifications + per-page level. Review: S1 (budget author-less comment batches) REQUIRED, S2–S6 sent. Suites were running.
- `w3-verify` → `feat/w11-verify`: verification pass 3 DONE (62 passed / 7 deviation / 39 screenshot / 31 device / 20 partial / 1 missing / 1 not measured). Merge it (docs + specs; expect a PARITY-GAPS.md conflict with w9). Two new S gaps to dispatch: phone sheets have no entrance animation (NP-AX-06, `mobile-workspace.css`), no System theme choice (NP-AX-01, `stores/settings.ts` + `Settings.tsx`).
- `w4-shell` → `feat/w11-shots`: screenshot gallery + visual defect list (running; publish the gallery as an Artifact for the owner; dispatch its defect list).
- `w4-db` → `feat/w11-backlog`: Matrix reconcile rotation, ingester guards, tree cache cap, share-route links, set-aside UI, phone calendar week list (running).
- `w4-editor` → `feat/w11-deviations`: breadcrumb in header, ⌘/ = block menu, two-way relations, change property type, publish flow (running). Owns `EditorKeys.ts`, `lib/shortcuts.ts`, `ShortcutSheet.tsx` — add ⌘L, ⌘⌥T, ⌘⇧T and the mouse-selection/emoji lines at integration.
- `w3-gaps` → `feat/w12-editor-select`: mouse block selection, ⌘A escalation, inline emoji (running).
- `w2-media` → `feat/w12-db-calc`: table calculations, "Me" filter, wrap cells (running).
- `w2-mentions` → `feat/w12-duplicate`: duplicate with sub-pages (running).
- `w5-a11y` → `feat/w12-p2`: search sort, copy link to heading, expand/collapse toggles, ⌘L, reopen tab, peek prev/next, image actions — written as WIP commits, not yet verified.
- `w3-import` → `feat/w12-flakes`: intermittent-failure hunt (10 tests listed in its brief), `FLAKE-LOG.md` (running).
Queued, not started: regional preferences (week start/date/time format — after db-calc and backlog merge; shares `views.tsx`), merge of `feat/native-ios` (2 conflicts, then an iOS rebuild + device pass), AI for members (owner decision), formulas/timeline (later wave).
Each branch: merge main → root typecheck → `both-run.sh <worktree> <port> <tag>` detached (server one file at a time, then 10 browser shards) → independent review → `git merge --ff-only`.

## In flight at 2026-10-04 late evening (usage limit reached again) — READ FIRST

Main = this commit's parent `acc7f8f9` (assignment notifications `feat/w12-notify` merged; server 2,415/0, browser all passed). Nothing deployed.

| Worktree | Branch | State / next step |
|---|---|---|
| w4-db | feat/w11-backlog | Review found B1 (reconcile rotation never repairs cut sweeps) + S1–S5; fixes sent to the agent. Then: merge main, both suites, merge. |
| w2-mentions | feat/w12-duplicate | Re-review found B3 (copy re-publishes a page excluded from a public site) + S1–S6; fixes sent. Baseline suites: server 2,420/0; browser 2 failures not in duplicate code. |
| w3-gaps | feat/w12-editor-select | Review: no blocker, S1–S9 (cut in embedded field deletes blocks; selection jumps after merged remote update; table resize arms takeover; …) sent. Suites were queued (`esel` logs in scratchpad). |
| w4-editor | feat/w11-deviations | Built; must merge main itself (5 conflicts; rules sent), run a11y + WebKit, conversion follow-ups. |
| w4-shell | feat/w14-visual (on feat/w11-shots) | Fixing 48 visual defects from `ACCEPTANCE-SHOTS.md`. Gallery files in `apps/web/acceptance-gallery-{1,2,3}.html` (sent to owner). |
| w2-sharing | feat/w14-icons | Custom page icons (uploaded image) + per-device toggle memory. Just started. |
| collab-convert | feat/w9-gaps | Suggesting mode etc.; WIP `bdfbccd0`, awaiting final report → suites → review → merge. |
| w3-import | feat/w12-flakes | Five root-cause commits (vault switcher race, three @-menu races, …); last verification chain queued. Add `notion-a11y-keyboard.spec.ts:51` and `:179`, `editor-blocks.spec.ts:264`, axe `page-cover-dialog` to its list. |
| w2-media | feat/w12-db-calc | Table calculations, "Me" filter, wrap cells — running. |
| w5-a11y | feat/w12-p2 | P2 conveniences — verifying. |
| w3-verify | feat/w13-appearance | System theme, phone sheet animation, regional prefs (settings half) — running. |
| w2-shell | feat/w13-ios-merge | Merge committed `18da6c7c`; cargo lib 101 passed; remaining spec runs queued. No builds. |

Process per branch: merge main → root typecheck → `scratchpad/both-run.sh` (or `after-run.sh <prev log> …` to chain) → independent review → fixes → `git merge --ff-only`. Never start suites on an unresolved merge (CLAUDE.md conflicts are common: keep both sides).

Open items: one unexplained `/health` miss at 21:54 with 77% memory free (recovered at once, no pm2 restart). Owner decisions added this session: ingest-owned pages cannot be duplicated by anyone (owner exception?); property type conversion not offered on ingest tags incl. `task`; block selection — non-editors keep native text selection across blocks, editors get the toolbar on block selections. Queued, not started: database regional-prefs call sites, timeline view sizing, verification pass 4, AI for members (owner decision).

## Update 2026-10-07 — READ FIRST (credit-conscious run)

Merged to main this run, all on green typecheck + full server + full browser suites: `feat/w12-flakes` (+ the block-menu Comment focus fix), `feat/w12-p2`, `feat/w13-appearance`, `feat/w13-ios-merge` (integration branch `integ/w15`), then `feat/w12-db-calc` (reviewed; B1 work bounds + S1–S6 fixed). P2 and appearance merged WITHOUT an independent review (owner agreed). Nothing deployed.

Still unmerged, each needs ONE small fresh agent (do not resume the old agents — their contexts are huge) and then `scratchpad/after-run.sh` + ff-merge:
- `feat/w11-backlog` (w4-db, 20 uncommitted files): round-2 list — retry-only reconcile sweep + per-room tries/backoff, retry share cap, no Fireflies slot hand-back after an upstream mutation, body-read timeouts, Fathom getSoft rethrow, RecoveredText re-list failure copy, nits; update `matrix-lean.test.ts` expectation for the new `rooms` field only.
- `feat/w12-duplicate` (w2-mentions, 8 uncommitted): round-3 list — `no_path` reorder (protection checks first, 403 `protected` for excluded ids), BulkBar Stop + batch budget, files-phase ids from pass 1, `noteAtPath` timeout, test gaps.
- `feat/w11-deviations` (w4-editor, clean, main merged at b18395a4): needs a11y + WebKit runs, conversion follow-ups (select options, saved views alias, bounds), then suites.
- `feat/w9-gaps` (collab-convert, 4 uncommitted): fixture `diverged()` JSON compare, `noteLinkTitle` blank-title fix, old-code proof for round-3 suggesting fixes, WebKit, split WIP.
- `feat/w12-editor-select` (w3-gaps): review S1–S9 pending. `feat/w14-visual` (w4-shell, 5 uncommitted): visual defects in progress. `feat/w14-icons` (w2-sharing): WIP, unverified.
Open: unexplained `/health` misses with plenty of free memory (2026-10-04 21:54, 2026-10-06 22:46) — check pm2 logs around those times.


## STOPPING POINT 2026-10-07 — READ FIRST (supersedes the sections above)

**Main** = `bf325c96` + whatever landed after this note (check `git log`). NOTHING IS DEPLOYED: production (pm2 `prism-server`, `apps/web/dist`) still runs the release from before this work. Deploy order when the owner says go: restart the server first (`pm2 restart prism-server`, additive DB migrations run at start), then build + ship the PWA, then rebuild the Prism Client. Several features say "server first" (agent error codes, Messages → People route, pinned properties, search filters).

### Landed this run (all on green typecheck + full server + full browser suites unless noted)
Flake fixes (incl. block-menu Comment focus bug), P2 conveniences, appearance (System theme, regional prefs settings), iOS code merge (no build), table calculations (+ "Me" filter, wrap cells), duplicate with sub-pages, backlog (Matrix reconcile retry/back-off, ingest upstream timeouts, Fireflies no re-upload, Recovered text UI, offline tree cache cap), visual polish pass 1, Settings restored + pinned properties, Messages → People across platforms (read-time identity resolution), agent integration (error codes, honest copy at every entry point, one sign-in retry; merged on typecheck + agent server tests + 6 agent/keyboard specs after a full run on its pre-merge tree).

### INCIDENT — fixed, read this
Commit `b9a20c91` (Messages) was made from a stale working tree and silently reverted ~95 files of backlog + visual polish, deleting their tests too, so the suites stayed green. Repaired in `11638fbc` (three-way merge back of every affected file; verified: only Messages + Settings + two small fixes differ from the pre-damage main; full suites green incl. the restored tests). **New merge rule:** before every merge, `git diff --name-only --diff-filter=D main -- '*.test.ts' '*.spec.ts'` must be empty unless deliberate, and look for files reverted to an older version.

### In flight at stop
- `feat/w11-deviations` (w4-editor): header breadcrumb, ⌘/ = block menu (sheet ⌘⇧/, `?`), Publish flow, property type conversion, shortcut rows. Full suites running on main-merged tree (`scratchpad/dev2-*.log`); merge if green.
- `feat/w16-polish` (w4-shell, agent running): real option names, Sentence case ⌘K, status bar removed, simpler task cards, phone More sheet, one page-count footer, phone Rename / slash menu / link card / keyboard toolbar. Needs: merge main, full suites, merge.

### NEXT — in priority order
1. **Agent that is actually useful (owner priority).** (a) The note you have open is in the agent's context automatically when you open it from a note (check every entry point passes `noteId`; server already inlines the first turn). (b) Search across all notes: the agent said it could not — diagnose (profile tool list for `prism-ro`/`vault-ro`, semantic search 409 off-primary, prompt not telling it). (c) Opt-in web access: a profile with WebSearch/WebFetch only (no shell/files), fetched pages fenced as untrusted, chosen per conversation — OWNER DECISION. (d) Read-write mode that can create/edit/link notes within Prism permissions (`prism-rw`, behind `AGENT_PRISM_PROFILES`; decision c.9). Verify against the REAL CLI once (`scripts/verify-agent-exec.ts` text-only case never run).
2. **Claude sign-in on the server** — runs failed with "OAuth token revoked" (2026-10-04 ×2, 2026-10-07 10:18). Owner: `! claude` then `/login` on the server. Suspected refresh-token collision between concurrent CLI processes sharing one login.
3. **Email triage `triage-failed`** — the `message-classify` skill runs on the LOCAL model; today's failures coincide with memory-pressure deferrals while this session's suites/agents loaded the host (not the Claude login). Re-run triage on today's failures by removing `triage-failed` from them (vault write — owner OK needed). Also: Google OAuth for `gog` calendar expired ("invalid_grant") — owner re-auth.
4. **Transcript ↔ calendar matching** misses most connected events — diagnose with real data (window, score, title normalisation) before code.
5. **Comments UX** deeper rethink (panel restyled in polish pass 1).
6. Messages, remaining mockup pieces: previews in People rows, group avatars, "show earlier", file chips, quoted replies, sender popover, paging >100. Owner decisions: turn on `MATRIX_LINK_EXISTING` + `MATRIX_STORE_PARTICIPANT_IDS`; run the people link job for real.
7. Unmerged older branches still holding work: `feat/w12-editor-select` (mouse block selection + inline emoji; review S1–S9 pending — real editing bugs), `feat/w14-icons` (custom page icons + toggle memory; WIP, unverified), `feat/w9-gaps` (Suggesting mode etc.; 4 uncommitted files in `.worktrees/collab-convert`, fixture fix + old-code proof pending).
8. Unexplained `/health` misses with plenty of memory: 2026-10-04 21:54, 2026-10-06 22:46, 2026-10-07 15:37/15:50 (the last two during overlapping suite runs) — look at pm2 logs around those times.
9. Owner decisions recorded by agents: pins per tag (not per page); dead desktop-only settings (sync direction, local vaults list) could be deleted; type conversion not offered on ingest tags (incl. `task`); ingest-owned pages cannot be duplicated by anyone; templates of an excluded page can re-publish (accepted residual).

### How to work on this host
Tests are serialized behind a memory gate (`scratchpad/AGENT-RULES.md`; gate example `w9b-gate.sh`). Full verification = `scratchpad/after-run.sh <wait-log> <worktree> <port> <tag>` (typecheck + server suite one file at a time + browser suite in 10 shards; ~75–90 min). Never run two full suites at once — today's overlap killed a shard three times and caused /health misses. One small fresh agent per branch; do not resume old agents (huge contexts).

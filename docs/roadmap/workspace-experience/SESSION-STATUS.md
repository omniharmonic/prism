# Session status — pause point 2026-10-02 (evening)

Owner paused the session. Everything below is committed; no worktree has uncommitted changes. Nothing has been deployed and the production server (pm2 `prism-server`, running from the main checkout) has NOT been restarted — production still runs the release recorded in `CURRENT-RELEASE.md` (`cb3178a`).

## Ownership

Codex has left. All work is owned by Claude (orchestrator) + sub-agents. Process per slice: implement in an isolated worktree → independent adversarial review → fixes → integrate in `../prism-int-apns` (merge main + slice, typecheck, full server suite, full fixture e2e) → fast-forward main. Gate for any TestFlight/App Store upload: **every item in `NOTION-PARITY-CHECKLIST.md` passes on main** (owner rule).

## On main

| Work | Status |
|---|---|
| Backend: suggest-only enforcement server, transcript reconciliation, graph identity/linking layer + agent graph tools, APNs server | merged (earlier), reviewed |
| Wave 1: editor blocks (+ schema handshake), typed properties + database views, pages/navigation/trash/lock | merged, reviewed |
| Wave 2A: mentions, inbox, notifications, Home, access requests (COLLAB_SCHEMA_VERSION = 3) | merged, reviewed |
| Docs: one-download setup design, Parachute embedded-mode request, frontend gap analysis, Notion parity checklist | on main |

## In flight (resume these)

| Group | Branch / worktree | State at pause |
|---|---|---|
| 2C database depth | `feat/w2-db-depth` | reviewed + fixed; merged into `integrate/w2c` (in `../prism-int-apns`, commit 046e1ad): typecheck + 1,846 server tests pass; full e2e 683 passed, 3 failed — `document-recovery:38` and `page-creation:156` pass alone (load), but `notion-home.spec.ts:9` (2A's Home "Upcoming") fails alone too: expected "Tomorrow", got "Sun, Oct 4 12:16 AM" — likely a date/time-of-day-sensitive fixture or relative-date bug, not yet diagnosed. Fix, re-run, then fast-forward main. Also 2C's `boards.spec.ts:868` flake root cause (found by 2E): drag overlay intercepts the second pointer-down for ~250 ms after a drop — make the overlay `pointer-events:none` in `TaskBoardRenderer.tsx` |
| 2D sharing, page grants, presence, suggest-only client | `feat/w2-sharing` (WIP commit a395ee7) | review: CRITICAL C1 + HIGH H1 + M1 + M2 FIXED with tests; NOT done: M3 (writer-stamp keys owner-only + stripped from non-owner responses — failing test committed), all LOWs, 3 old tests to update (`gateway-caps` ×2 now 403 `move_required`, `sharing-routes` access-preview now 404). Then merge main (after 2C), switch to 2C's `writer-stamp.ts`, root typecheck + e2e, re-review |
| 2B media, embeds, uploads, covers, find/replace | `feat/w2-media` | implementation finishing at pause — check `git log`/`git status` in `.worktrees/w2-media` (it was told to commit WIP and report); not yet reviewed. Must bump COLLAB_SCHEMA_VERSION to 4 at integration (2A took 3); register 2C's `databaseView` node; mount 2D's PresenceAvatars + PageInfo in `DocumentChrome.tsx` |
| 2E shell, phone, offline, search | `feat/w2-shell` (d827578…f8fc6f6, clean) | built: SB-12, PG-06/08/10/14, MB-04, OF-01, OF-04, SR-03, AX-06; partial SB-15/MB-06/SR-04; `document-polish:5` flake ROOT-CAUSED and fixed (disabled input lost focus). Not done: Inbox button in `MobileActionBar` (2A request), SB-13/MB-02 one-action New page, list swipe gestures, search vault scope. Last full e2e 668/1 fail (fixed since, not re-run). RISK to review: `App.tsx` switched React Query to offlineFirst / saves `always` (app-wide). Not yet reviewed |
| iOS app | `feat/native-ios` | built + reviewed + fixed; simulator sign-in verified by owner against the real server; signed `.ipa` NOT produced (by rule) — `apps/client/scripts/ios-release.sh` when parity passes |

Integration notes for wave 2: mount 2D's `SharedWithMe` in `Navigation.tsx` (2A-owned file), `PresenceAvatars`/`PageInfo` in `DocumentChrome.tsx` (2B), `MoveAccessNotice` in the move picker; reconcile schema version; 2D must use 2C's writer stamp.

## After wave 2

Wave 3 per checklist §3: import/export + templates (3A), native completion incl. universal links (3B), performance + accessibility sweep (3C), verification-only rows (3D). Then the checklist §4 acceptance procedure, then TestFlight.

## Waiting on the owner

1. **Release timing**: release main to production now (server restart with active-turn check + online backup, web build, Prism Client reinstall; old app copies will show "Update required") or after wave 2. Production still needs `COLLAB_SUGGEST_ENFORCED=true` once the 2D client ships, and `APNS_*` env + the `.p8` from `~/Downloads/AuthKey_P2648BP7K4.p8` placed on the server (0600) for push.
2. **Parity exclusions** in `NOTION-PARITY-CHECKLIST.md` §1.3 (Notion AI → Prism agent; deferred: synced blocks, block links, formulas/rollups, timeline/chart/form, equations, web clipper/share extension; excluded: automations/buttons; teamspaces → vaults) — confirm or pull items in.
3. **Pages move permission**: organize (current) vs plain edit.
4. **Graph cleanup against the live vault**: needs the release first, then the staged runbook in `BACKEND-STATUS-GRAPH.md` (owner = `vault/people/Benjamin Life`, Matrix member lookup allowed, bulk exact-address links allowed, owner linked to own tasks).
5. **Nightly skill install** (`docs/skills/`) replaces the current nightly weave — needs approval and a Prism PAT.
6. Send `docs/roadmap/parachute-embedded-mode-request.md` to the Parachute team; note hub.db is world-readable on this Mac and Parachute logs don't rotate (hub.log ~1.5 GB).

## Apple account (done)

Team `83Y42N33H8` (Individual — listings show "BENJAMIN GLEASON ROSS"). App ID `com.benjaminlife.prism.client`; APNs key `P2648BP7K4` (file still in ~/Downloads — move into the password manager); Developer ID Application + Apple Distribution certificates valid in the login keychain; App Store Connect app "Prism Workspace"; API key `AB84HRLBUA` (issuer `7c2856fc-0bdf-4d41-b95d-a2ffab2ba726`) at `~/.appstoreconnect/private_keys/`; provisioning profile "Prism Workspace App Store".

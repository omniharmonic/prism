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

## Update 2026-10-03 (later) — READ FIRST

**Incident:** the test agents overloaded the production host (load ~40, 15 GB swap) and Prism returned Cloudflare 524 until all agents and test runs were stopped. Rule from now on: **at most 2 agents running browser/server suites at once on this machine, `--workers=2`, and check `uptime` + `curl 127.0.0.1:8787/health` before launching more.** No sub-agent may spawn its own sub-agents.

**On main (`a550aa7`, nothing deployed):** everything above plus wave 3 gaps, import/export/templates, wave 4 editor (schema v5), databases, shell/live updates. Last full runs: server 2137/2137, browser 899 passed.

**Stopped mid-work (resume, one or two at a time):**
- `fix/collab-convert` (`.worktrees/collab-convert`): server Markdown/HTML conversion off the main thread. Two review rounds; round 3 fixes (persisted absorbed/attempted-write hash honoured at load/reconcile/store; true base for MCP merge; "not saved" notice; sweep rotation; M1–M4) were in progress — check `git status`/log there. Needs main merged, a third independent review, then merge. Until it lands, main still converts on the main thread (a 1 MB note stalls the server ~4 s on live open).
- `feat/w5-verify` (`.worktrees/w3-verify`): second checklist verification pass; drafts for 61 rows, not integrated.
- `feat/w5-a11y` (`.worktrees/w5-a11y`): axe + performance sweep, just started.
- `feat/w5-webkit` (`.worktrees/w5-webkit`): WebKit green, baseline run only.
- Not started: native group (universal links, ZIP save IPC on iOS; `feat/native-ios` must merge main).

**Owner decisions added:** editor shortcuts (⌘K link with selection else quick find; ⌘⇧H highlight; replace ⌘⌥F; ⌘/ shortcut sheet, block menu ⌘⇧/); DB-11 presentation-only property management; DB-12 computed reverse relations; CO-08 direct publish controls kept; conversion timeout/heap values for the mini.

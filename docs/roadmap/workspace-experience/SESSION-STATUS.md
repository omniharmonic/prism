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
- Leaving a tab within ~100 ms of the last keystroke while a live document's socket is down loses those keystrokes (no unload guard).
- An MCP agent's comment/suggestion stores the account email as `data-actor-id` in the shared document (humans store an opaque `h_…` id).
- Suggest-level people opening a shared page from the sidebar get the propose-for-review draft; the live suggest editor is only on `/collab/:id`. ⌘F does not open in read-only collab documents.
- Accepted lows (documented in `CLAUDE.md`): path-existence oracle on create/trash; organize in a tag may add that tag without `share`.
- Gaps carried into wave 3: sign-out button in the web app, list swipe actions, published pages can't load attachments, copied pages reference the original's attachments, "suggestion accepted" notifications, "My tasks" (assigned to me), mentioning members who have no person note.

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
8. Leave-page guard for the 100 ms offline-keystroke window: wanted or not.

## Apple account (done)

Team `83Y42N33H8` (Individual). App ID `com.benjaminlife.prism.client`; APNs key `P2648BP7K4` (file still in `~/Downloads` — move it into the password manager); Developer ID Application + Apple Distribution certificates valid in the login keychain; App Store Connect app "Prism Workspace"; API key `AB84HRLBUA` at `~/.appstoreconnect/private_keys/`; provisioning profile "Prism Workspace App Store".

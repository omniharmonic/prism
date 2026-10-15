# Pre-release polish rollout: October 14, 2026

PR #162 (squash of 20 commits from `polish/pre-release`) merged as `288ce029f65e86f8883f8d47ed3d9148af927222`.
Tags: `prism-v2026.10.14` (server/web) and `prism-client-v2026.10.14` (Prism Client source), both on that commit.

## Validation

- `npm run check` passed: every workspace typecheck, the e2e typecheck, and the dialogs, service-worker and initial-bundle guards.
- Server suite: 3,060 tests, 3,059 passed, 0 failed, 1 skipped.
- `npm run build -w @prism/web` passed.
- GitHub CI on the PR: all 38 checks passed. Browser shard 12 failed once on a network `ECONNRESET` in `parity3-collab.spec.ts` "NP-CO-01". The same commit passed it in the push run, and the re-run of the failed jobs passed.

## Web/server

The deploy.sh (agent repo origin/main) dry run, then `--apply`, both passed. The steps were backup, web build, pm2 restart of `prism-server` only, process and vault health, no newly failing ingest sources, and check-desktop-independence.

- Mini log: `/Users/benjaminlife/deploy-state/prism-20261014T234059Z.log`
- Backup: `/Users/benjaminlife/parachute-backups/20261014T234100Z-pre-deploy-prism-v2026.10.14`
- Mini checkout: `prism-v2026.10.14`, clean. pm2: prism-server, prism-tunnel and bridge-watchdog all online, 0 unstable restarts.
- Public `GET /api/version` → `{"version":"0.1.0","api":1}` (the server package version, not the git tag).
- Public `/health` → `{"ok":true,"vault":true}`.
- `/acl/setup` without credentials → 403.

## macOS Prism Client: installed on laptop and Mini

The source is `prism-client-v2026.10.14`, commit `288ce029`, the same commit as the web deploy. The bundle is `com.benjaminlife.prism.client`. It keeps its existing `0.1.0` bundle version; the tag identifies the release.

### Build checks

- Release build from the tag. verify-client passed; 112 native unit tests passed.
- `verify:native` reports 1 failing check ("transport.ts has 0 credentials:include"). It is not from this release. It comes from #161 (`52946f5b`), already shipped in `prism-v2026.10.12`. The PWA still sends `include`; the guard's literal pattern no longer matches the line. The guard is not in CI.

### Signing and notarization

- Unsigned zip SHA-256: `18a18c721c2c3bbc03f233482dc227da167dc24dbe82b31b6bdb8c62aa3f7fe9`. It matched on the Mini.
- Developer ID signing over SSH returned `errSecInternalComponent`. The owner signed through the Mini's desktop Terminal with `~/release-artifacts/sign-prism-client-v2026.10.14.sh`.
- Re-verified afterwards: Developer ID Application, BENJAMIN GLEASON ROSS, team `83Y42N33H8`. Hardened runtime, secure timestamp, no entitlements. Strict verification passed.
- Signed zip SHA-256: `79d14f70a53f749f6a7e3cc4dbe20648bbcff289329f721f18e1304f896da71b`.
- Apple notarization **Accepted**: `1751702b-2657-4eb6-a877-1544e8a22a12`, submitted 2026-10-15T01:59Z.
- Stapled. Ticket validated, strict signature verified, Gatekeeper accepted ("Notarized Developer ID").

### Artifact

- Notarized zip SHA-256: `46ea47c2d7f95f77905e119a4dbd0fc3c7f9b302439ac71ef894ae51d9327dbf`.
- Installed executable SHA-256: `7814c91bae4cc5989f40d3cb82112faf656d260893ac4a14ca759e0f295aa3c3`.
- Kept on both Macs at `~/release-artifacts/prism-client-v2026.10.14/prism-client/notarized.zip`. The laptop copy was checked again: checksum, strict signature, stapled ticket, Gatekeeper.

### Install

- **Previous app:** `prism-client-v2026.10.11-5` on both Macs (executable `a5796bfe…`).
- **Backups:** `~/release-artifacts/installed-backups/20261014-prism-client-v2026.10.11-5/Prism Client.app` on each Mac.
- **Mini:** the app was not running before replacement.
- **Laptop:** before closing the running app (normal quit, nothing else touched) we checked:
  - the offline outbox was empty;
  - there were no unsynced live-document entries or rescue entries;
  - live-document storage had not been written during the session.
- **After install, on both Macs:** strict signature, stapled ticket and Gatekeeper passed. The app launched and stayed running; the laptop shows its main window.
- **Not changed:** preferences, device sign-in and vault data. No backend was restarted for the install.
- **Owner checks still open, on both Macs:** sign-in, opening a note, navigation.
- **Rollback:** restore the backed-up bundle.

No TestFlight upload.

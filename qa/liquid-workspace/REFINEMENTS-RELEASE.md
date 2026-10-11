# Prism refinements release — October 11, 2026

- PR #133: https://github.com/omniharmonic/prism/pull/133 (merged).
- Source: `968ac003bcd017cceb634dc3b87dbe6cb551553f`.
- Tags: `prism-v2026.10.11`, `prism-client-v2026.10.11`.
- Upstream Omni commits through #134 preserved; no Omni source changes in this PR.

## Checks

Repository typechecks/static checks passed. Full server suite: 3,020 passed, one explicitly heavyweight test skipped. Focused UI verification: 46 Chromium/WebKit checks, six real-server live-editor checks, and two Chromium real-touch gesture checks passed. Native verification and macOS build passed. Full GitHub browser CI still pending when this receipt was started.

## Server and web: deployed

Dry run, backup, web build, process/vault checks and ingestion comparison passed. Log on Mini: `/Users/benjaminlife/deploy-state/prism-20261011T061835Z.log`.

The initial desktop-independence warning read the old monitor cursor before the first scan; rerun passed after the new scan. Public `/health` returned `ok: true, vault: true`.

First v2 scan at 2026-10-11T06:19:13.607Z: healthy, actual failure streak zero, active task coverage 90/137 (65.7%), historical coverage 83/150 (55.3%), no truncated listings. Task-only baseline migration applied; no task data changed. Matrix had a pre-existing fetch failure before deployment, unrelated to this release; a restart's temporary zero/one-failure state does not prove that issue fixed.

## iPhone and iPad: installed and launched

Development-signed iOS build 3 installed and launched on both existing registered devices. Strict signature passed with normal system trust access. Profile contains both UDIDs and expires October 10, 2027. This is the existing development channel; no TestFlight/App Store upload.

IPA SHA-256: `fa453bd509cc25c7745023ae499ba2f6047cb59f2779d996ef28327540b8a3af`.
Preserved app: `/private/tmp/prism-refinements-release/ios/Payload/Prism.app`.
No full interactive physical-device acceptance is claimed from successful launch alone.

## macOS: awaiting owner signing

Unsigned app SHA-256 (ZIP): `ee1d7c10516f9ba71ab643dc7bfaff2e0beea184d6596eb8991492c25539489d`.
Mini staging: `~/release-artifacts/prism-client-v2026.10.11/prism-client`.
SSH signing returned `errSecInternalComponent`; owner command prepared at `~/release-artifacts/sign-prism-refinements.sh` under `docs/runbook/mac-mini-signing.md`. Existing installed apps are unchanged pending signing, notarization, stapling and verification. Laptop pre-install UI showed Home/Synced, no active draft.

The prior October 10 desktop submission `dfe8816f-d96a-42bb-a037-32acc5fa7b02` is now Accepted; this release still requires its own signature and notarization.

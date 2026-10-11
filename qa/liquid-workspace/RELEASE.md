# Approved liquid workspace release — 2026-10-10

- PR: https://github.com/omniharmonic/prism/pull/126 (merged)
- Source: `cb59bbb48745a0f2175b60f7ec31265ba4e4a610`; tree identical to tested branch head `549c6525`.
- Server/web tag: `prism-v2026.10.10-17`.
- Native tag: `prism-client-v2026.10.10-7`.
- Final logo retains the approved broad proportions and line weights, with nested golden-ratio interior subdivisions.

## Validation

Repository check and web/native builds passed. Native verification passed (the first sandboxed attempt could not write Swift's module cache). All six production native startup/recovery checks passed in Chromium/WebKit after correcting the test's entry-script selector to exclude theme-boot.js. Focused integrated UI suite: 58 passed, two phone fixtures timed out during parallel native compilation; both isolated reruns passed. Prior focused design suite passed all five cases in Chromium and WebKit. GitHub server tests/typecheck/build and Rust checks passed. The full 2,628-case browser CI suite remains pending; it is also still running on baseline main. No all-CI-green claim is made.

## Web

Dry run passed; backup taken. Deployment succeeded with process, vault, ingestion-baseline and desktop-independence checks. Pre-existing Matrix ingest failure unchanged. Mini deployment log: `/Users/benjaminlife/deploy-state/prism-20261011T034555Z.log`. Public HTTPS health returned ok; public prism-icon.svg exactly matches the approved source asset.

## iPhone and iPad

Development-signed build 2 installed on both registered devices, matching their existing development distribution channel. Strict bundle signature, exact bundle ID, build number, both-device provisioning and compiled iPhone/iPad icon maps verified. Both launches succeeded (phone first needed unlocking). No TestFlight/App Store publication or full interactive acceptance is claimed.

IPA SHA-256: `5a09011533ea849979543f79e1a4e5a50acbe37fcfabaa093566dfe21c6ab146`.
Preserved extracted app: `/private/tmp/prism-liquid-release/ios/Payload/Prism.app`.
Tauri generated build-local Associated Domains for prism.omniharmonic.com and resolved its generated Swift dependency to swift-rs 1.0.9; generated source modifications were restored after preserving the artifact.

## macOS — pending Apple notarization

Release build passed. Staged on Mini at `~/release-artifacts/prism-client-v2026.10.10-7/prism-client`. Owner signed through desktop Terminal after SSH signing returned errSecInternalComponent. Strict signature, Developer ID/team, hardened runtime, timestamp and empty release entitlements verified. Existing installed notarized apps remain untouched until acceptance/stapling.

Unsigned ZIP SHA-256: `a37cbb2c642e358008324d82f14d710fe73e81bf3ab25e02b0e332a9dc497467`.
Signed ZIP SHA-256: `c9d934d9072663b428208f135de79bc9f98659710d869ac944589ea982f7720d`.
Apple submission: `dfe8816f-d96a-42bb-a037-32acc5fa7b02` (do not resubmit).

After Apple accepts: follow docs/runbook/mac-mini-signing.md to staple, validate, Gatekeeper-check, repackage and verify, preserve previous Applications bundles and install on laptop/Mini. Local pre-install UI showed Home/Synced, no active composer or editor draft. Recheck before quitting.

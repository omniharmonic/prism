# Sidebar performance rollout — October 11, 2026

Implementation PR #142: https://github.com/omniharmonic/prism/pull/142.
Source: `fef3cbd6c09abbc652320cf898e72fbb18251d1b`.
Tags: `prism-v2026.10.11-3`, `prism-client-v2026.10.11-3`.
Concurrent upstream Omni changes through `c775e007` were preserved.

## Verification

Repository check, e2e typecheck, native asset verification and iOS build passed. Final browser runs passed 24 lifecycle/gesture checks, 40 lifecycle/native-shell/vault-parity checks, and two real-touch Chromium checks. These runs overlap; they are not a unique-test count. Local stress measurements and limitations are recorded in README.md and final.txt. GitHub Rust checks passed; other CI jobs were still pending at release verification.

## Web

Deployment dry run and apply succeeded, including backup, build, restart, process/vault checks, ingestion comparison and desktop-independence verification. Public health returned `{"ok":true,"vault":true}` after rollout. The pre-existing Matrix ingestion failure was unchanged.

Mini log: `/Users/benjaminlife/deploy-state/prism-20261011T160730Z.log`.

## iOS build 5

Development-signed build 5 installed and launched successfully on both the owner's iPhone and iPad. Strict signature verification passed; the profile includes both devices and expires October 10, 2027.

IPA: `/private/tmp/prism-sidebar-release/ios/Prism-build5.ipa`.
SHA-256: `025143daa61128079ed19edfa0e56edf1f0ca7ae243df3b59623fa1a512ae194`.

Physical gesture feel remains for owner acceptance. Browser stress timings are not physical iPhone timings. This rollout did not upload to TestFlight or replace the previously notarized macOS app.

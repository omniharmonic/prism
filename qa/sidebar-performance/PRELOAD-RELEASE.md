# Sidebar startup preload rollout — October 11, 2026

PRs #146 and #147 are merged. Final source: `cde19b442d5714960cf2cbe3d73dfe3dd91b6db6`. Tags: `prism-v2026.10.11-5` and `prism-client-v2026.10.11-5`. Concurrent Omni changes through #145 were preserved.

## Validation

Repository checks and native asset verification passed. The initial startup change passed 96 Chromium/WebKit regression checks (two CDP-only cases skipped on WebKit), followed by 12 lifecycle checks after guest handling. The settlement correction passed 40 startup, shortcut, and vault-isolation checks. These runs overlap and are not a unique-test count. The held-access test failed on build 6 and passed with the correction. GitHub Rust jobs passed; other CI jobs were still pending at release verification.

The phone-sized startup screen was visually inspected. `startup-preload.txt` records a fictional 1,206-row development fixture with CPU throttled 4×, opening immediately after startup readiness. The longer startup absorbs initial tree/shortcut work; the prior roughly one-second late update no longer appeared in that run. These are not physical iPhone timings.

## Web

Final-tag dry run and deployment succeeded: backup, build, restart, process/vault health, ingestion comparison, and desktop-independence checks passed. Public health returned `ok: true, vault: true`. The prior Matrix ingestion failure remains unchanged.

Mini deployment log: `/Users/benjaminlife/deploy-state/prism-20261011T163942Z.log`.

## Devices

Build 7 installed and launched successfully on the owner's iPhone and iPad. Strict code-signature verification passed. The native artifact was built from `a509b08f`, whose file tree matches the final merged source.

IPA: `/private/tmp/prism-preload-release/ios7/Prism-build7.ipa`.
SHA-256: `330b04bafc02a7efe198b5a7f11f3e4607953c5c4dc7b6952f2f3c141b25e382`.

Intermediate build 6 was installed during validation but superseded by build 7; its web rollout was held after cold-start profiling exposed the recent-page access race. No TestFlight upload or native macOS replacement occurred in this mobile-focused rollout. The owner subsequently reported that the sidebar is working perfectly on their device. This confirms owner acceptance on that device, not a separate interactive pass on both devices.

## Post-deployment follow-up

Owner reported successful physical-device behavior on October 11. Read-only follow-up found Prism online since the release restart, zero unstable restarts, successful process/vault health endpoints, and link-health OK. All enabled worker statuses were OK except the previously failing Matrix source. Recent error-log history includes Matrix failures, older embedding errors and collaboration access-change reconnects; the untimestamped history is not claimed to contain only post-release events. No new code changes were needed for sidebar acceptance.

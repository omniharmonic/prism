# Accepted sidebar-preload release: macOS rollout

Source: `prism-client-v2026.10.11-5`, commit `cde19b442d5714960cf2cbe3d73dfe3dd91b6db6`.
This is the same source accepted on iPhone/iPad build 7 and deployed to the web.
The macOS bundle retains its existing `0.1.0` bundle version; the source tag identifies this release.

## Artifact and verification (2026-10-12 UTC)

- Release native build, native bundle guard, client verification: passed.
- Native unit tests: 112 passed.
- Unsigned zip SHA-256: `98c5f2de0ba0e01979470f09ee11049ae2222aa95bbd206b0c28681aaa8d444d`.
- Developer ID Application: BENJAMIN GLEASON ROSS, team `83Y42N33H8`.
- Secure timestamp and hardened runtime verified; no debug entitlements.
- Apple notarization **Accepted**: `89c7ec59-deec-41b1-8f34-56ce70f32196`.
- Stapled ticket validated, strict signature verified, Gatekeeper accepted on both Macs.
- Notarized zip SHA-256: `d032452070338c032e3568204b6c0820714c8e602948524dc17e359c751b122d`.
- Approved icon SHA-256 on both Macs: `e383b652e1c190d23b90c2368f519774348e46b7ff92bb49f82571a827b044ee`.

Installed `/Applications/Prism Client.app` on laptop and Mini. Both retain the exact artifact at
`~/release-artifacts/prism-client-v2026.10.11-5/prism-client/notarized.zip`.
Previous bundles are preserved at
`~/release-artifacts/backups/prism-before-build7-20261011/Prism Client.app` on both Macs.
The laptop displayed Saved before quitting; the Mini app was not running before replacement.

Laptop interactive verification: startup completed, existing sign-in and document tabs restored,
retained page tree populated, saved live document rendered with its content. Mini launch was issued;
interactive Mini acceptance remains an owner check. Preferences, vault data and backend were not altered.

## CI follow-up

The release's original browser CI did **not** pass: 128 failed, 2492 passed, 14 skipped,
10 not run. Node checks and Rust checks passed. Browser fixture and assertion repairs are being
verified separately on current main; this receipt does not claim that unfinished check is green.

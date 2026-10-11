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

## macOS: installed on laptop and Mini

Owner signed and verified the staged app through the Mini desktop session. Developer ID/team, secure timestamp, hardened runtime and empty release entitlements verified. Apple submission `78efe90f-c9e8-49f4-82eb-d1c977ed06f9` was Accepted; stapling, ticket validation and Gatekeeper assessment passed. Exact notarized artifact installed on both Macs, with each previous app backed up under `~/release-artifacts/backups/prism-before-2026.10.11/Prism Client.app`.

- Unsigned ZIP SHA-256: `ee1d7c10516f9ba71ab643dc7bfaff2e0beea184d6596eb8991492c25539489d`.
- Signed ZIP SHA-256: `d965c653c4a4b7028bb91f09563bf78e52b61d6bd3b2780560214e3ca7f405b6`.
- Notarized ZIP SHA-256: `05a711e7df0facf70eb4caa364f19e6b9dff4d0ae97bca3bcd4822f2d43790d4`.
- Mini artifact: `~/release-artifacts/prism-client-v2026.10.11/prism-client/notarized.zip`.
- Laptop artifact: `/private/tmp/prism-refinements-release/macos/notarized.zip`.

The installed icon on BOTH Macs exactly matches the approved golden-ratio tetrahedron asset (`icon.icns`, SHA-256 `e383b652e1c190d23b90c2368f519774348e46b7ff92bb49f82571a827b044ee`). The actual packaged icon was converted to PNG and visually inspected; CFBundleIconFile names this resource. No post-signing bundle modifications were made.

Laptop launch and interactive verification passed: workspace Synced, restored Conversation history visible beside the chat, Attach notes beside Capture text, agent permissions present; an existing note opened and showed Saved / Live. No document content was edited. Mini was not running Prism when installed and its Screen Sharing session was locked during the subsequent check, so Mini interactive launch acceptance is not claimed. Its installed signature and icon hash were verified.

The prior October 10 desktop submission `dfe8816f-d96a-42bb-a037-32acc5fa7b02` is also Accepted; this release supersedes it.

# Production rollout — 2026-10-10

Checkpoint after final client builds; production and device acceptance are still in progress.

## Verified production

- Mini Prism: `prism-v2026.10.10-4`, commit `f32425f7`, deployed at 08:05:58 UTC through tagged dry-run/apply. Process, vault reachability, ingest health and desktop independence passed. Log: `~/deploy-state/prism-20261010T080558Z.log`.
- Mini agent: `agent-v2026.10.10-4`, commit `6968326`, passed tagged narrow dry-run/apply. Log: `~/deploy-state/agent-20261010T082935Z.log`. Mini policy 49/bridge 56/generator/producer 30 checks passed. F4 restarted Hermes at 08:31:09 UTC (ACTIVE); startup self-test passed its 53 tools at 08:31:18 UTC. Actual reader results are recorded below. Telegram/Buzz were not restarted.
- PR25 restores bounded reader compatibility: exact read-only Proton state-file access, existing Bridge item lookup through the normal file-based Keychain API without granting security subprocess access, service-token capability only for the trusted sweep, and explicit all-day calendar handling. Existing credential/pin boundaries remain; live verification confirms calendar/context and sweep operation, while mail remains gated on the existing item’s application ACL.

- At 08:34:40 UTC all 11 enabled production sources were healthy with failure streak zero: Matrix, ClickUp, Fireflies, Fathom, index, calendar, Proton, skills, people-link, vault-lint and link-health. Operational server health does not establish Hermes mail-reader authorization. Telegram fallback and Buzz remain in place; no outward test email or message was sent.


## Approved vault work completed

All three separately approved Mini passes completed with zero failures: first repair **12 writes**, duplicate repair **16 operations**, then hygiene **2,363 writes** (2,337 membership patches, 26 project body patches, 19 agent-context changes within those patches).

- First repair undo: `~/parachute-backups/vault-hygiene-20261010T065452Z/undo-m-project-repair.jsonl` (12 entries).
- Duplicate repair backup: `~/parachute-backups/20261010T070551Z-pre-vault-hygiene-keep`; undo: `~/parachute-backups/vault-hygiene-20261010T070551Z/undo-m-project-repair.jsonl` (16 entries).
- Hygiene undo: `~/parachute-backups/vault-hygiene-20261010T070645Z/undo-m-project-hygiene.jsonl` (2,363 entries).
- Undo files verified mode 0600. Herd of God background and duplicate archive bodies exactly match their original bodies; the duplicate remains recoverable in Trash. After these passes, the deployed repair/hygiene dry runs each reported zero planned changes and zero failures.

PR65 adds safe retired-folder alias inference. Production v4 preview reports exactly 19 changes: one retired-folder membership patch for proposal-draft-v1 and 18 generated leaf index retirements; zero failures and zero writes. Explicit owner approval is pending before fresh backup/undo and apply. Do not repeat completed passes or apply either follow-up from this checkpoint.

## Final Prism client artifacts

`prism-client-v2026.10.10-3` points to `3d94c3e177fb0156c7fc98abbde11fe4705e208a`, including the narrow-header and publishing-focus fixes. Build checkout: `~/dev/prism-final-native`; prior v2 artifacts remain under `retained-v2/`.

| Artifact | Path beneath build checkout | SHA-256 |
|---|---|---|
| Mac build executable (before Developer ID signing) | `apps/client/src-tauri/target/release/bundle/macos/Prism Client.app/Contents/MacOS/prism-client` | `9b44ca02b00aaad66b55e857c27e4eb98d59d738fc5205df5dcca9ccbc7d2451` |
| iOS exported executable | `apps/client/src-tauri/gen/apple/build/verified-export/Payload/Prism.app/Prism` | `a165a37b3d345887930f1bd81d1f60c79911bc4b56ef95f973d482cb452cc488` |
| iOS IPA | `apps/client/src-tauri/gen/apple/build/arm64/Prism.ipa` | `547efed955fe7d4372061a10b39c78d6402acb6eae3183ea50e27b455d74d98f` |

Mac Release, iOS development build/export, `verify-client` and exported iOS strict signature verification passed. Source remains the exact v3 tag. After owner Xcode login, automatic provisioning produced profile `ddd7df67-6613-4e2a-a559-8fc01e2390d7`, team `83Y42N33H8`, covering both connected iPhone and iPad; actual signed `aps-environment=development`. The final same-source app installed and launched successfully on both devices. Workspace, notification and biometric acceptance still require owner checks. Original iPhone-only artifacts are preserved under `retained-v3-iphone-only/`; current manifests are `final-native-artifacts.json` and `final-native-ipad-artifacts.json`.

The original unsigned Mac zip SHA-256 `064872c4365791998320fe88b82614130216bb74f1fd43b8454d51a2eb89e873` was staged and verified on Mini at `~/release-artifacts/prism-client-v2026.10.10-3/prism-client`. Owner GUI Developer ID signing subsequently passed strict bundle verification, hardened runtime and timestamp checks. Following explicit owner consent for upload to Apple, notarization submission `035c1ea1-48b2-4c7f-99ed-1d5931b5d671` was submitted at 15:47:36 UTC and remains pending. Neither Mac installation nor successful notarization/stapling is claimed. Use final v3 artifacts, not superseded v1/v2 commands.

## Validation and pending integration

- Full browser fixtures on `3f419191`: **2,571 passed, 13 skipped, 2 failed**. PR66 fixes the 320px Page actions overflow; PR67 fixes publishing focus restoration after pane commits. Each passed eight focused cases with unchanged assertions. The complete suite has not been rerun on final client source; do not describe the original run as all green.
- Omni adaptive UI, app-bound push, app lock and the two-engine V0 voice kit are merged (PR57/60/62). Physical push/biometric checks and owner voice recordings remain acceptance work.
- Full server integration on `97fbb9e0`: **2,940 passed, 1 skipped, 1 failed** (old Matrix lean golden fixture lacked the intentional trusted evidence fields). PR63 corrected only that fixture and passed 15 focused tests. `npm run check` passed. No full server rerun is claimed.
- M3 server/native and read-only producer are merged/deployed. Actual Hermes session `omni_nudge_verify_4959f93154d1` ran four separate read-only calls. Context exited 0 (`contextChecked=true`, zero meeting candidates, `proposed=false`). Sweep exited 0: 15,237 scanned, 103 candidates, 464 unknown reply evidence, one observed/unavailable email account, zero operational proposals/resolutions; neither calendar nor jobs was unavailable. Proton health returned false with `keychain_osstatus_-25293`; weekly audit exited 1 because mail evidence was unavailable. No schedule, committed producer proposal, push or outward send was installed/performed by these checks.
- Hermes mail remains blocked on owner authorization of the exact deployed Python 3.9 executable for only the existing `omniharmonic-proton-bridge` Keychain item. Retain established trusted applications; never choose Allow All Applications or retrieve/re-store credentials. This owner action and repeat normal reader verification remain pending before schedules. See `docs/omni-nudges.md` and the named agent runbook.

- Email-only executors are configured through the named runbook: `OMNI_EXECUTOR_KINDS=email,email-reply`, `OMNI_EXECUTORS=on`, Proton executor/script/Python configured, Prism `ACTIONS_EMAIL_ENABLED=false`. Environment backup is mode 0600; offline Proton safety self-test passed. No actual email was sent. Exact-draft human approval remains required.
- Omni final client tag `omni-client-v2026.10.10-1` points to `f32425f7`. Both Release targets compile. Owner explicitly approved registration of `com.benjaminlife.omni` with Push Notifications. The exact-source signed Release iOS app passed signature, both-device profile and absent-debug-marker checks; actual APNs entitlement is `development`. Both iPhone/iPad install and launch succeeded. Signed archive SHA-256: `7a281be65a3f1ad088bd5407ad0570844d7e1f91ffc9e8c1d543d2eae3743611`; verification record: `/private/tmp/omni-client-v2026.10.10-1/ios-development-verification.json`. The preceding generic compile archive remains a compile-only artifact, superseded for device installation.
- Omni universal Mac unsigned artifact remains staged on Mini at `~/release-artifacts/omni-client-v2026.10.10-1/omni/unsigned.zip` (SHA-256 `386082a22ec5164f4edbe6ae61dcab12a7cf8db3ca0554d363751fcadc937c66`). Production push provisioning profile `25c9679a-e6ed-40da-967a-b7cdee1b708c` was generated and matched the existing Mini certificate. Profile/artifact are staged; owner GUI signing, actual signed entitlement verification, notarization and both Mac installs remain pending.

## Owner and elapsed-time acceptance

Xcode login and Omni App ID registration/provisioning are complete. Owner actions still pending: workspace/notification checks on both installed apps/devices, Omni Mini GUI signing, Mac installation after signing/notarization, and Claude connector scope narrowing. Hub sign-in is available; the scope change has not been performed. No certificates or connector grants were revoked by this rollout.

Device parity sign-off is required before TestFlight. V0 needs the owner's personal recordings and quality comparison. Nudge comparison and link-health switches need the planned week of observation; test success does not replace these gates or remove fallback services.

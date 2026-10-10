# Production rollout — 2026-10-10

Checkpoint after final client builds; production and device acceptance are still in progress.

## Verified production

- Mini Prism: `prism-v2026.10.10-4`, commit `f32425f7`, deployed at 08:05:58 UTC through tagged dry-run/apply. Process, vault reachability, ingest health and desktop independence passed. Log: `~/deploy-state/prism-20261010T080558Z.log`.
- Mini agent: `agent-v2026.10.10-3`, commit `8c79d20`, deployed at 08:07:06 UTC via the narrow code-only workflow. Mini policy/bridge/generator/25 producer checks passed. Log: `~/deploy-state/agent-20261010T080706Z.log`. F4 Hermes restart passed its 53-tool self-test at 08:08:58 UTC without restarting Telegram/Buzz. Earlier calendar access succeeded after the scoped encrypted login-Keychain grant; current nudge reader verification is incomplete as detailed below.
- Enabled-source health passed with failure streak zero at 07:26 UTC. Telegram fallback and Buzz remain in place. No outward test email or message was sent.

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
| Mac executable | `apps/client/src-tauri/target/release/bundle/macos/Prism Client.app/Contents/MacOS/prism-client` | `9b44ca02b00aaad66b55e857c27e4eb98d59d738fc5205df5dcca9ccbc7d2451` |
| iOS exported executable | `apps/client/src-tauri/gen/apple/build/verified-export/Payload/Prism.app/Prism` | `4673eb895c577e5422f455692e3234fdf9d81b3b6892261ee394accc2a9539b6` |
| iOS IPA | `apps/client/src-tauri/gen/apple/build/arm64/Prism.ipa` | `991c116f6cce4bedee456cf5f2852435bb27680afda678e658fe1d5cc9e3a68a` |

Mac Release, iOS development build/export, `verify-client` and exported iOS strict signature verification passed. Mac is arm64 and ad hoc signed until the Mini Developer ID step. iOS uses existing profile `8ace8cc8-215f-4b01-a08b-838eb9fff804`, team `83Y42N33H8`, iPhone only, actual signed `aps-environment=development`. No new provisioning or account changes were made. Final unsigned zip SHA-256 `064872c4365791998320fe88b82614130216bb74f1fd43b8454d51a2eb89e873` is staged on Mini at `~/release-artifacts/prism-client-v2026.10.10-3/prism-client`; executable hash verified. The final exported app installed successfully on iPhone; launch remains blocked by device lock, so workspace acceptance is pending.

Final v3 iPhone installation succeeded but launch was blocked by device lock. iPad remains outside the profile pending owner Xcode account login. The Mac linker ad hoc signature does not seal bundle resources; strict bundle verification awaits Developer ID signing. Mac Developer ID signing over SSH returned `errSecInternalComponent`; owner GUI signing, notarization and both Mac installs remain pending. Use the final v3 artifact and fresh command, not the superseded v1/v2 staging command.

## Validation and pending integration

- Full browser fixtures on `3f419191`: **2,571 passed, 13 skipped, 2 failed**. PR66 fixes the 320px Page actions overflow; PR67 fixes publishing focus restoration after pane commits. Each passed eight focused cases with unchanged assertions. The complete suite has not been rerun on final client source; do not describe the original run as all green.
- Omni adaptive UI, app-bound push, app lock and the two-engine V0 voice kit are merged (PR57/60/62). Physical push/biometric checks and owner voice recordings remain acceptance work.
- Full server integration on `97fbb9e0`: **2,940 passed, 1 skipped, 1 failed** (old Matrix lean golden fixture lacked the intentional trusted evidence fields). PR63 corrected only that fixture and passed 15 focused tests. `npm run check` passed. No full server rerun is claimed.
- M3 server/native and read-only producer are merged and deployed. Actual Hermes Proton health was denied, and context/sweep calendar and jobs evidence was unavailable. Reader compatibility fixes are in progress; no nudge schedules or committed producer proposals have been installed. Do not claim production readers or nudge delivery complete. See `docs/omni-nudges.md` and the agent runbook.
- Email-only executors are configured through the named runbook: `OMNI_EXECUTOR_KINDS=email,email-reply`, `OMNI_EXECUTORS=on`, Proton executor/script/Python configured, Prism `ACTIONS_EMAIL_ENABLED=false`. Environment backup is mode 0600; offline Proton safety self-test passed. No actual email was sent. Exact-draft human approval remains required.
- Omni final client tag `omni-client-v2026.10.10-1` points to `f32425f7`. Both Release targets compile. Universal Mac unsigned zip SHA-256 `386082a22ec5164f4edbe6ae61dcab12a7cf8db3ca0554d363751fcadc937c66` is staged and checksum-verified at `~/release-artifacts/omni-client-v2026.10.10-1/omni/unsigned.zip`. Generic iOS compile zip SHA-256 `442f84225a3aa43a0c9d40c6d5bf17e811fbe8080f28b79e4d4644dd9df4542e` has no embedded profile and is **not installable**. Signing/capability sidecars accompany the Mac artifact; Omni App ID/profile and final signed entitlement checks remain pending.

## Owner and elapsed-time acceptance

Owner actions still pending: Xcode login, Omni App ID confirmation/profiles, unlocked phone workspace checks, Mini GUI signing, and Claude connector scope narrowing. Hub sign-in is available; the scope change has not been performed. No certificates or connector grants were revoked by this rollout.

Device parity sign-off is required before TestFlight. V0 needs the owner's personal recordings and quality comparison. Nudge comparison and link-health switches need the planned week of observation; test success does not replace these gates or remove fallback services.

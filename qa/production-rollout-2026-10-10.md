# Production rollout — 2026-10-10

Checkpoint after final client builds; production and device acceptance are still in progress.

## Verified production

- Mini Prism: `prism-v2026.10.10-3`, commit `4fc714c1`, deployed through tagged dry-run/apply. Process, vault reachability, ingest health and desktop independence passed. Deployment log: `~/deploy-state/prism-20261010T070136Z.log`.
- Mini agent: `agent-v2026.10.10-1`, commit `266e338`. Narrow code-only deployment passed Mini policy, bridge and generator checks. Hermes restarted and passed its 53-tool self-test. Authenticated Hermes calendar reads succeeded after the scoped encrypted login-Keychain read grant; existing Google authorization needed no reconnect.
- Enabled-source health passed with failure streak zero at 07:26 UTC. Telegram fallback and Buzz remain in place. No outward test email or message was sent.

## Approved vault work completed

All three separately approved Mini passes completed with zero failures: first repair **12 writes**, duplicate repair **16 operations**, then hygiene **2,363 writes** (2,337 membership patches, 26 project body patches, 19 agent-context changes within those patches).

- First repair undo: `~/parachute-backups/vault-hygiene-20261010T065452Z/undo-m-project-repair.jsonl` (12 entries).
- Duplicate repair backup: `~/parachute-backups/20261010T070551Z-pre-vault-hygiene-keep`; undo: `~/parachute-backups/vault-hygiene-20261010T070551Z/undo-m-project-repair.jsonl` (16 entries).
- Hygiene undo: `~/parachute-backups/vault-hygiene-20261010T070645Z/undo-m-project-hygiene.jsonl` (2,363 entries).
- Undo files verified mode 0600. Herd of God background and duplicate archive bodies exactly match their original bodies; the duplicate remains recoverable in Trash. After these passes, the deployed repair/hygiene dry runs each reported zero planned changes and zero failures.

PR65 adds safe retired-folder alias inference. The known remaining unassigned substantive note requires a new deployed-code preview and explicit approval. The 18 generated leaf indexes were previewed only; retirement is not approved or applied. Do not repeat completed passes or apply either follow-up from this checkpoint.

## Final Prism client artifacts

`prism-client-v2026.10.10-3` points to `3d94c3e177fb0156c7fc98abbde11fe4705e208a`, including the narrow-header and publishing-focus fixes. Build checkout: `~/dev/prism-final-native`; prior v2 artifacts remain under `retained-v2/`.

| Artifact | Path beneath build checkout | SHA-256 |
|---|---|---|
| Mac executable | `apps/client/src-tauri/target/release/bundle/macos/Prism Client.app/Contents/MacOS/prism-client` | `9b44ca02b00aaad66b55e857c27e4eb98d59d738fc5205df5dcca9ccbc7d2451` |
| iOS exported executable | `apps/client/src-tauri/gen/apple/build/verified-export/Payload/Prism.app/Prism` | `4673eb895c577e5422f455692e3234fdf9d81b3b6892261ee394accc2a9539b6` |
| iOS IPA | `apps/client/src-tauri/gen/apple/build/arm64/Prism.ipa` | `991c116f6cce4bedee456cf5f2852435bb27680afda678e658fe1d5cc9e3a68a` |

Mac Release, iOS development build/export, `verify-client` and exported iOS strict signature verification passed. Mac is arm64 and ad hoc signed until the Mini Developer ID step. iOS uses existing profile `8ace8cc8-215f-4b01-a08b-838eb9fff804`, team `83Y42N33H8`, iPhone only, actual signed `aps-environment=development`. No new provisioning or account changes were made. Final packaging/staging/installation is being handled separately; this checkpoint does not establish v3 installation or workspace acceptance.

The preceding iPhone build installed successfully but launch was blocked by device lock. iPad remains outside the profile pending owner Xcode account login. Mac Developer ID signing over SSH returned `errSecInternalComponent`; owner GUI signing, notarization and both Mac installs remain pending. Use the final v3 artifact and fresh command, not the superseded v1/v2 staging command.

## Validation and pending integration

- Full browser fixtures on `3f419191`: **2,571 passed, 13 skipped, 2 failed**. PR66 fixes the 320px Page actions overflow; PR67 fixes publishing focus restoration after pane commits. Each passed eight focused cases with unchanged assertions. The complete suite has not been rerun on final client source; do not describe the original run as all green.
- Omni adaptive UI, app-bound push, app lock and the two-engine V0 voice kit are merged (PR57/60/62). Physical push/biometric checks and owner voice recordings remain acceptance work.
- M3 remains draft and undeployed. Full server validation is running on M3 checkpoint `97fbb9e0`; results and final server/agent tags will be recorded after completion. See `docs/omni-nudges.md` and the agent runbook for the implementation and activation contract.
- Approved email activation and its exact-draft self-send remain pending the tested final deployment. Keep Prism `ACTIONS_EMAIL_ENABLED=false`; follow the email-only activation runbook rather than enabling unrelated executors.

## Owner and elapsed-time acceptance

Owner actions still pending: Xcode login, Omni App ID confirmation/profiles, unlocked phone workspace checks, Mini GUI signing, and Claude connector scope narrowing. Hub sign-in is available; the scope change has not been performed. No certificates or connector grants were revoked by this rollout.

Device parity sign-off is required before TestFlight. V0 needs the owner's personal recordings and quality comparison. Nudge comparison and link-health switches need the planned week of observation; test success does not replace these gates or remove fallback services.

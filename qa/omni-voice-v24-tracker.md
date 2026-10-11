# Mac wake permission crash repair — build24

Build23 owner test failed immediately when enabling Experimental Hey Omni. Prior release verification covered pure recovery/activation tests, compilation and inactive UI rendering; it did not exercise the real Speech authorization callback. Wake reliability was not accepted.

## Evidence

Local crash report `Omni-2026-10-11-102332.ips`: EXC_BREAKPOINT/SIGTRAP, background thread2, `_dispatch_assert_queue_fail` → `_swift_task_checkIsolatedSwift` → authorization completion closure in `MacWakeListener.reconcile()`. The bundle includes valid microphone/Speech usage descriptions.

The completion closure was created in a MainActor task, while Apple's Speech authorization API does not promise a main-queue completion. The crash occurs before microphone recognition starts. [Apple callback contract](https://developer.apple.com/documentation/speech/sfspeechrecognizer/requestauthorization(_:)).

Saved wake opt-in was turned off to prevent a relaunch crash loop; no credentials, voices or conversations changed.

## Repair and acceptance

Use an explicit nonisolated Sendable callback boundary, delivering only the authorization result through a continuation. Reproduce the old actor violation in a subprocess; invoke the exact production callback from a background queue for all authorization statuses. Keep recognition, audio, and other callbacks audited for the same error.

Before claiming enablement repaired, test enabling the real listener in the signed app; record permission result, wakeStarted, on/off and renewal behavior separately from synthetic tests. Physical phrase detection and post-conversation wake remain required. No installation or acceptance of24 yet.

## Verified before packaging

- Isolated Swift6 subprocess, with actor data-race checks explicitly enabled: old callback pattern exited -5/SIGTRAP with the same dispatch/actor assertion stack; corrected nonisolated Sendable factory exited0. No Speech permission request or microphone used. Evidence lives in the task temp directory `omni-wake-actor-repro-hqd0lxn6`.
- Exact production authorizationCallback invoked from DispatchQueue.global for all4 authorization states: passed and verified MainActor resumption. Existing23 focused wake/gate/activation/ownership tests also passed (24 total across two test bundles).
- Universal Mac Release build24 passed for arm64/x86_64; source/binary Release guards pass.
- Installed23 reopened successfully with saved wake preference off. This is crash-loop recovery, not proof that real wake enablement is repaired.

## Staged repair

PR145 merged; tag `omni-client-v2026.10.11-24` at `9d7fc478ecc0eafc3f034ff2e53ef527c9e6d835`. Exact tagged universal Release rebuilt and guarded. Unsigned ZIP SHA-256 `c892fd0794407d8fafa322794ea1831c768f932d255817ec6821a5c2590b73ed`, Mini checksum matched. Staging `~/release-artifacts/omni-client-v2026.10.11-24/omni`; helper `~/release-artifacts/sign-omni-v24.sh` syntax/path/build checks pass. Awaiting owner signing; no notarization or installation24 yet.

## Installed signed build24

- Apple submission `1effb6b7-979d-4df8-b7be-ea8d6e12d616`: Accepted.
- Signed ZIP SHA-256 `ffc3b5afc93da4b477375116651a0ecdf9686c0b15f7012101a0edadd604d374`.
- Stapled ZIP SHA-256 `2e7971e6eb3def8d0d6b1b373a9395cd7979fb09b99e6d4c095369955b74c682`; verified on transfer. Signature, ticket and Gatekeeper passed.
- Installed `/Applications/Omni.app` build24; build23 preserved at `~/release-artifacts/installed-backups/20261011-omni-v23/Omni.app` (build22 backup retained as well).
- Actual signed-app Settings confirmed24. Enabling wake now completes without the previous actor crash. First recognition attempt ended/retried once; listener then reports Listening locally. Off → On verified in UI and diagnostics (wakePaused → wakeStarted). No simulated callback substituted for this check.
- Main window closed through UI; app remained running. Awaiting 50-second renewal and owner spoken detection test.

Actual closed-window renewal passed: wakeStarted at Apple-reference timestamp813429553.029382, wakeRollover813429605.352965, wakeStarted813429605.457238. No wakePaused event followed closing the window. Latest Omni crash report remains the original build23 failure at10:23:32; no new crash observed. Listener remains enabled for the owner's spoken phrase test. This proves running/renewal, not phrase recognition or successful conversation handoff.

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

# Mac wake-word reliability batch

Current release: Omni22 on laptop/iPhone/iPad. User wants automatic wake reliable and batching before next release. Accepted mobile voice stays unchanged. Experimental speech interruption stays enabled by preference; prior cutoff possibly cough, not confirmed player failure.

Batch scope:
1. Recover automatically from recognizer final/error, with bounded backoff/cooldown, stale-callback rejection and no repeated permission prompts.
2. Keep opt-in wake ready while main window is closed but app runs; honor signed-out/privacy/session-lock/sleep and conversation ownership.
3. Expose local Hey Omni toggle/status in main Mac Settings and retain menu/hotkey fallback.
4. Content-free wake lifecycle diagnostics; no ambient audio/transcript persistence or server upload.
5. Prevent the Replied status from truncating in the chat toolbar beside Voice (owner feedback added to this same batch).

Target acceptance matrix: final/error recovery; stable50s renewal; repeated failures cooldown; off during permission/retry; signout/privacylock/sleep; route change; conversation preemption/release; stale callbacks cannot reactivate; only one activation per wake; mainwindowclosed readiness; hotkey/wake requests queued until mainforeground.

Physical acceptance after final combined install: enable permissions and Hey Omni; 5 wake attempts spaced across2+minutes (cross recognizer renewal); mainwindowclosed; anotherappforeground; end voice and wakeagain; sleep/wake and headset route; brief idle energy/falsewake observation. Wait for Listening before request: wake lead-in remains future work. No claim full sleepingMac wake or perfect false-wake rejection. Notarization follows integrated tests/composited settings review, not each component.

## Verification so far

- 23 focused Swift tests passed with zero failures (`Wake|VoiceActivationTests|VoiceMicrophoneTests`). Covers retry budget/tokens, normal versus rapid final results, wake gates/epochs, microphone ownership, and queued activation after reopening a closed window.
- Source release guards pass; no UI-test launch path outside DEBUG.
- Returning from System Settings reconciles changed permissions without cancelling a pending cooldown. Denied permission does not repeatedly prompt.
- Pure policy tests do not simulate Apple's actual recognizer, audio hardware, or macOS sleep/headset notifications. Those remain physical acceptance checks.
- Universal Mac Release build passed for arm64 and x86_64; build23 metadata and binary release guards passed.
- The isolated menu-bar lifecycle harness compiled. Its eventual marker shows the label appearance callback at initial launch without opening the menu, but desktop automation failed (`stageManagerProcessNotRunning`) before close/reopen UI verification. Closed-window UI acceptance is unverified. Wake binds during Mac app initialization to the same app-owned model, independent of menu-label appearance; main-window shortcut setup remains an idempotent fallback. The final universal Release build passes after this adjustment and the toolbar fix.
- No new app installed or notarization submitted yet. Batch remains held for integrated desktop lifecycle/Settings verification.

- Toolbar fix: status text keeps its intrinsic width; Voice is icon-only; conversation title remains truncatable. Shared iOS Release compilation is in progress. Runtime glass-toolbar rendering remains unverified while desktop automation is unavailable.

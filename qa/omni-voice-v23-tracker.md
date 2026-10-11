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

- Toolbar fix: status text keeps its intrinsic width; Voice is icon-only; conversation title remains truncatable. Shared iOS device Release compilation passed (covers iPhone/iPad targets; unsigned compile only, no installation). Runtime glass-toolbar rendering remains unverified while desktop automation is unavailable.

- Source review: [PR141](https://github.com/omniharmonic/prism/pull/141), held as draft until integrated desktop acceptance.

## Release staging — October 11

- PR141 merged; source tag `omni-client-v2026.10.11-23`, commit `c775e007e3a0eda2634b264b49f2f9a6dbe09bd0`.
- Rebuilt the exact tagged Mac source; universal arm64/x86_64 and Release binary guards pass.
- Unsigned ZIP SHA-256: `e5e27c3718bded3bae46a1fb0d62cca19980eb8daf78a0b0839e773bb60c2170`; Mini transfer matched before extraction.
- Mini staging: `~/release-artifacts/omni-client-v2026.10.11-23/omni`. Existing public provisioning profile and production entitlements preserved. One executable in bundle; no private signing keys moved.
- Exact helper `~/release-artifacts/sign-omni-v23.sh` checks build23 and verifies signature after signing. Awaiting owner GUI signing; no notarization submission yet.
- Desktop automation responds again. Initial close/reopen probe through automation was inconclusive because app inspection reactivated the window; an isolated self-check is in progress.
- GitHub node typecheck/tests/build and Rust checks passed at merge; unrelated web e2e job was still running. Native focused tests and Mac/iOS compilation passed.

## Signed artifact

Owner completed signing. Signature verified with hardened runtime, secure timestamp, correct Developer ID/team, production push entitlement and no get-task-allow.

- Signed ZIP SHA-256: `542229c1112c4ab6f0cb738eeac8de2ace21f40754ab5e5bf0df44cc5f16dd98`.
- Apple submission: `3f319740-58e6-4c23-9fe2-2bbd8d4b2693`, uploaded October11; initial status In Progress.
- CUA again timed out when launching the isolated v2 fixture. No final visual or close/reopen pass claimed. These checks will need installed-app owner acceptance if automation remains unavailable.

## Notarization accepted

Apple accepted submission `3f319740-58e6-4c23-9fe2-2bbd8d4b2693`. Stapler validate and Gatekeeper assessment passed on Mini and laptop. Stapled ZIP SHA-256: `cfc474956f0dd574af430b136ee69e115c8cd55368507a494dced452d9116589`; verified after transfer. Laptop artifact: `/private/tmp/omni-client-v2026.10.11-23/verified/Omni.app`. Awaiting owner confirmation Omni is closed before replacing `/Applications/Omni.app`; build22 is still installed.

## Installed on laptop

Owner authorized replacement. `/Applications/Omni.app` is build23; installed signature, stapled ticket, and Gatekeeper assessment pass. Build22 rollback is preserved at `~/release-artifacts/installed-backups/20261011-omni-v22/Omni.app`.

Desktop automation recovered for installed-app checks: app launched signed in; main Settings shows build23 and Experimental Hey Omni Off with status Off; Voice & Playback opens on first attempt; Kokoro refresh reports Heart ready. Actual conversation toolbar screenshot shows the full Replied label beside icon-only Voice with glass preserved at the current window size. No audio capture started by automation. Owner wake/closed-window/sleep/headset acceptance remains pending. Mobile remains build22.

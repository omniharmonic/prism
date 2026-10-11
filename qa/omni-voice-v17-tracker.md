# Omni 17 — capture readiness, immediate entry, mute, Mac rollout

## Scope and verified source behavior

Build 16 physical trace confirmed five complete replies and returns to Listening (one 78.225 seconds), with no decode/playback failures. Its separate initial capture stop happened 135 ms after premature captureReady, before microphone input. Build 17 awaits first input before publishing Listening. It retries once only after stopping and verifying an empty capture; cancellation or recorded input prevents retry. Any recoverable recognized startup input is saved as an unsent draft. A fixed captureStartupRetry event extends the existing content-free trace.

Opening voice now starts capture through existing privacy, permission, draft and navigation guards. A request-scoped pending start prevents duplicate activation while a Task is queued. Compact interruption controls include microphone mute. During replies, mute blocks input recording/VAD/interruption while output continues; the duplex audio engine may remain active for echo cancellation. During listening, captured words become an unsent draft and unmute resumes that draft. Muted reply completion does not reopen capture. Pre-mute interruption lead-in is cleared. Privacy lock/End still cancel and release ownership.

## Verification

- Integrated 223 Core + 42 UI tests passed: `/private/tmp/omni-v17-native-tests.log`.
- Final 13 focused VoiceKit tests passed: `/private/tmp/omni-v17-voicekit-tests.log`; includes actual capture-file assertion that muted frames are not written, bounded startup retry/cancel/input-preservation gates, readiness and hardware queue tests.
- Final 21 conversation/mute tests passed after normal mute status polish: `/private/tmp/omni-v17-mute-final-tests.log`.
- Two iPhone simulator UI regressions passed (36.169 seconds): first voice turn/main-chat continuity and immediate entry/mute draft/unmute. Synthetic gateway only, no real vault or microphone. Screenshots inspected under `/private/tmp/omni-v17-ui-shots/iphone/iphone-18-pro/light`. Muted saved-draft notice was subsequently changed from error red to the existing neutral captureNotice style.
- Source release guard and diff whitespace checks passed. Full MacSnapshotTests walkthrough remains excluded due to unrelated host service issues. Physical startup/route recovery still needs device acceptance.

## Local models and Mac

Additional model inventory is in `omni-voice-v17-local-tts-research.md` and the TTS evaluation roadmap. Kitten nano's pinned model assets are ~27.65 MB, but its normal runtime dependency path exceeds the bounded 150 MB download budget before complete dependencies. No new model/runtime was downloaded or enabled. Pocket is the next streaming candidate for inventory; existing Kokoro artifacts remain retained for audition and future modular adapter work. No subjective new-model quality claim.

This release must be built from the merged tag. Mac signing/notarization/installation receipts and physical wake-word acceptance remain separate gates. The existing experimental local Hey Omni listener and global keyboard/menu activation remain implemented; a shipped binary does not prove wake capture, permissions, sleep/lock or microphone handoff. No server/vault/agent policy change in this bundle. Outbound communications still require owner approval.

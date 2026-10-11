# Omni voice 16 — MP3 ending repair

Owner reports initial short and final long replies cut off near their ends; intentional interruptions and intervening playback worked. Build 15 iPhone enum-only trace: first playback failed with `playbackDecodeFailed` after 1.658 s; final playback failed with the same category after 82.520 s. Both passed microphone/engine readiness. Two intervening replies were intentionally interrupted. A separate restarted capture logged `audioEngineStoppedByConfiguration`; this remains distinct from the EOF failure.

## Reproduced cause

Generated nonpersonal Edge/Aria speech: “This is a synthetic playback test. The final words must be heard completely.” The existing AVAudioFile loop decoded 148032 frames at 24 kHz, including a last 576-frame buffer, then threw Foundation._GenericObjCError.nilError on the next zero-frame EOF read. Its catch signaled playback failure, pausing the session and discarding up to two seconds still queued for playback. Thus a complete, valid file could lose its audible ending. Earlier interruptions cancel before EOF and do not expose this fault.

The same file through ExtAudioFileRead returns noErr with zero frames at EOF, as documented by Apple: https://developer.apple.com/documentation/audiotoolbox/extaudiofileread(_:_:_:). Build 16 uses that explicit status and frame count. Genuine decoder failures still fail. Decoding remains in 4096-frame blocks, 8–192 kHz, 1–8 channels, bounded to 600 seconds and the existing encoded-byte/queued-PCM limits. Cancellation and hardware-drain completion remain unchanged. No private conversation audio was retrieved.

## Regression evidence

The 37 KB synthetic MP3 is a test-only resource. Tests decode every frame with both partial and exact block-boundary endings, verify repeated EOF, enforce duration limits and reject malformed input. The previous synthetic frame-count-only tests missed AVAudioFile's real EOF behavior; this fixture exercises the actual decoder. Focused 24 speech tests passed. Integrated Core/UI results and release artifacts recorded below. MacSnapshotTests full walkthrough remains excluded due to unrelated host service issues. No agent delegation used in this repair.

## Remaining acceptance

Both short and long replies must finish their last words and return to Listening on physical devices, including after interruption. The underlying audio configuration stop on a separate capture remains open; do not conflate it with this reproduced decoder bug. V03 routes/echo/soak, V04 activation, V05 wake lead-in/energy, and modular local-model quality gates remain in the canonical voice roadmap. No backend/vault changes.

Integrated verification: 219 Core + 42 UI tests passed in `/private/tmp/omni-v16-native-tests.log`; focused speech log `/private/tmp/omni-v16-speech-tests.log`. Source release guard and diff checks passed. Physical acceptance remains pending.

## Tagged release candidates

PR #121 merged as `aa8301a7`, tag `omni-client-v2026.10.10-16`. iOS and universal Mac Release builds passed; signature (iOS), identity/version, DEBUG exclusion, and synthetic test-fixture exclusion verified. Artifacts are at `/private/tmp/omni-client-v2026.10.10-16`:

- `ios.zip`: `06c028fcd7e31d8e34eed8c68c5cb0410a5a6352e9f151264faf7bfbcaee1449`.
- `mac-unsigned.zip`: `83e5d50c6823d3ae19ef506a453eed2bdf67e08998b34f3666ad6d1017452914` (local unsigned candidate only).

Logs: `/private/tmp/omni-v16-ios-release.log`, `/private/tmp/omni-v16-mac-release.log`. Owner confirmed readiness; build 16 installed successfully on both iPhone and iPad. Receipts: `iphone-install.log` and `ipad-install.log` in the artifact directory. Physical voice acceptance remains pending. GitHub repository CI still pending at packaging, separate from passing local native tests. Existing Mac 13 notarization remains In Progress at the latest check; no duplicate submission or desktop installation. Mobile 16 is the latest confirmed installed build; no launch or successful voice playback is inferred from installation.

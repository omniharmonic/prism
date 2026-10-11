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

## Owner acceptance and remaining capture startup fault

Owner reports build 16 mostly worked, with an initial drop followed by several successful interactions. Latest enum-only iPhone trace at `/private/tmp/omni-v16-device-audit/iphone-events.json` confirms five `playbackFinished` events and five returns to Listening, including a 78.225-second reply. No playback/decode failure occurs in this build 16 sequence. This supports the EOF repair; it is not complete route/soak acceptance.

The first reply finished at 02:02:08.879 UTC. Capture reported ready at 02:02:09.536; 135 ms later `audioEngineStoppedByConfiguration` occurred before any new microphone first tap. At 02:02:11.609 the activity watchdog disabled automatic detection. Finishing that capture yielded `emptyCapture`, then one retry delivered microphone input and activity normally. Four subsequent reply/capture cycles succeeded. No interrupted playback appears in this particular post-install trace, so this receipt does not claim a fresh interruption test.

Source audit: `ConversationDevice.start()` awaits `audio.start()` but not actual input delivery; Core therefore publishes Listening and starts its detector watchdog before first-tap readiness. `beginPlaybackMonitor()` already has the required first-tap gate. The next focused repair is capture readiness and bounded recovery for configuration stops before any delivered input. Do not blindly restart an active capture or discard recorded speech. Test cancellation/generation isolation, no-input retry limits, preservation of any delivered input, and first-turn/relisten readiness before shipping. The configuration notification proves the engine stopped during reconfiguration, but does not identify the external trigger or establish a Bluetooth route change. No speculative runtime change was made in this evidence pass.

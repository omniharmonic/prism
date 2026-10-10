# Voice readiness review — implementation versus remaining acceptance

2026-10-10 engineering review draft. This supplements the canonical roadmap; it does not establish physical acceptance or authorize production deployment.

## V04 activation setup and acceptance

On a supported iPhone, open Settings → Action Button, select Shortcut, tap Choose a Shortcut and select Talk to Omni. Press and hold the button. If it is absent from the picker, create a shortcut in Shortcuts containing Omni’s Talk to Omni action, then select that shortcut. The app cannot silently assign a hardware button. [Apple instructions](https://support.apple.com/guide/shortcuts/apdfea15680b/ios).

On iPad, create a shortcut containing Talk to Omni; in the shortcut’s Details select Add to Home Screen. A Shortcuts widget is another system surface. [Apple Home Screen instructions](https://support.apple.com/guide/shortcuts/apd735880972/ios).

On Mac, while Omni runs, Control–Option–Command–Space opens voice through the same readiness coordinator. The Omni Voice menu also offers Talk to Omni; registration failure is visible. Authentication, privacy unlock, mounted navigation and microphone permission still apply. Repeated presses coalesce and retain an active conversation. Cold launch queues expire after 60 seconds. Most recently ready foreground scene selection is deterministic.

Physical checks still required: cold launch and warm launch; signed out then signed in; locked then unlocked; denied microphone permission; repeated presses during preparation, transcription and narration; expired request followed by unrelated launch; supported iPhone hardware assignment and iPad shortcut installation. Unit tests establish coordinator behavior, not hardware-button acceptance.

## V05 current local contract and lead-in gap

Hey Omni is opt-in, experimental full Apple speech recognition with an on-device capability check and requiresOnDeviceRecognition. It is not a dedicated efficient wake engine. Matching uses whole words in a bounded 4,096-character preview; request epochs reject stale and duplicate callbacks. Ambient audio is never written to a file or sent to Hermes. Recognition requests roll over at 50 seconds. Permission denial, unsupported local recognition and recognition errors have visible menu state; no remote fallback exists.

One coordinator preempts wake capture synchronously before a conversation takes the microphone. Conversation ownership lasts through narration and Pause, until End/cancellation. Sleep, privacy lock, sign-out and window readiness stop listening. No sleeping-Mac wake claim or login-helper registration exists. Launch-at-login remains a later explicit setting.

**Lead-in audio is currently missing.** Saying “Hey Omni, tell me…” immediately can clip words during recognition, window activation and conversation preparation. Current honest instruction: after Hey Omni, wait until the voice panel says Listening before speaking. A visual Listening cue is already present. Any optional audible ready cue should be a short local sound after capture readiness, controlled by a remembered preference and suppressed while locked, cancelled, playing previews or denied permission; it must never speak an unapproved action.

A real lead-in bridge requires a bounded in-memory PCM ring owned by a single native capture service, with source timestamps and route/format identity. After a matched phrase, retain only the chosen post-phrase interval; atomically transfer an expiring activation-scoped token into the conversation audio writer, prepend it once before new microphone frames, and destroy it on lock/sign-out/End/expiry/route change. During foreground/authentication delay, either keep the same capture owner recording only a bounded handoff interval or clearly require the ready cue; stopping the wake engine and later opening a separate recorder leaves a gap that a pre-wake ring cannot recover. Replay tests must verify no duplicated/clipped speech and no wake-phrase dispatch. This is a capture redesign requiring ConversationDevice coordination, not a promise made by keyword matching.

Apple SpeechAnalyzer offers wholly on-device long-form recognition with model downloads; it is a feasible future adapter, not proof of wake energy or false-accept performance. [Apple WWDC25](https://developer.apple.com/videos/play/wwdc2025/277/). Porcupine requires an AccessKey and distribution review; openWakeWord’s included pretrained models use CC BY-NC-SA 4.0 despite Apache-2.0 code. [Porcupine](https://picovoice.ai/docs/porcupine/), [openWakeWord](https://github.com/dscripka/openWakeWord).

## Physical acceptance matrix

| Scenario | iPhone | A12Z iPad | Mac |
|---|---|---|---|
| Explicit multi-turn Send/Pause/End, stale callbacks | Required | Required | Required |
| Automatic patient 2/5/10/20-second pauses, grace resumption | Required | Required | Required |
| First new-thread reply, narration drain, second turn | Required | Required | Required |
| Speaker, wired/Bluetooth headset and route changes | Required | Required | Required |
| Permission denial, sign-out, privacy lock, network loss | Required | Required | Required |
| Background/window close and return; never surprise-capture | Required | Required | Required |
| Phone-call/audio interruption and recovery | Required | Required | System interruption |
| Acoustic Interrupt: near-end voice versus speaker echo | Required | Required | Required |
| Action Button/Shortcuts entry | Required | Required | Global chord/menu |
| Wake missed/false triggers during conversation/media | Not offered | Not offered | Required |
| Idle wake energy, sleep/wake, logout/quit | Not offered | Not offered | Required |
| 15-minute thermal/memory/audio continuity soak | Required | Required | Required |

No hands-free detector establishes semantic completion or authorizes an outbound action. Approval must bind to the exact pending action; engineering replay tests send no real messages.

## Optional Kokoro foreground Mac spike

Public metadata only, no model blobs downloaded. FluidAudio v0.17.7 pins v3 release 6c0750dd02ef9d981fb82f147d784a3f171755ee and seven-stage base 006395f65025af251858b1ab0a7178a6a1e73f9f. Applying the actual SDK selection rules yields 118,800,638 bytes for 16 v3 source/metadata files and 82,161,196 bytes for 24 base files. Default English voice adds 522,240 bytes; English vocab adds 1,416 bytes; manifest adds 20,416 bytes. Observed English frontend/G2P plus lexicon adds 12,015,574 bytes. Known download subtotal: **213,521,480 bytes (~213.5 MB decimal)**, excluding base-index JSON, HTTP metadata/notices and compiled caches. Full file hashes/sizes are in omni-kokoro-asset-inventory.json.

This fits a 750 MB download budget with room for metadata, but does not establish retained/transient disk or RAM limits. Local compilation duplicates source/cache assets; measure actual totals separately. Use default af_heart first to minimize extra voices. Preloading af_bella adds a 2,678,538-byte JSON download and a 522,240-byte converted cache file.

Important reproducibility gap: v3/base weights are pinned; shared English G2P and lexicon use the mutable repository main through the SDK downloader. Public main observed revision is d93c5f3eed11847fb81bd6d6a76665e133d7ca77. Pin or prepopulate those exact frontend files and verify cache checks before accepting a repeatable spike. The repository model card and conversion notice list Apache-2.0; retain model/conversion notices and finish selected voice provenance review before distribution. [Pinned SDK asset selection](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/TTS/KokoroAne/V3/KokoroAneV3Assets.swift), [model release](https://huggingface.co/FluidInference/kokoro-82m-coreml/tree/6c0750dd02ef9d981fb82f147d784a3f171755ee/ANE-v3).

Recommended next measurement: isolated foreground Mac subprocess, af_heart, ten synthetic passages, one persistent warm manager, controlled cache/download cap and crash-isolated output. Measure download, compilation, first PCM, resident memory, waveform frames and a 15-minute soak. Do not enable Kokoro in mobile builds before physical iPhone/A12Z testing; pinned upstream still documents unresolved mobile Core ML stability concerns.

Apple baseline attempted with the existing harness and say/Samantha, rendering files without playback at /private/tmp/omni-apple-voice-baseline. The command exited successfully, but sampled WAVs have zero PCM frames; these are unusable for a listening comparison. A renderer must reject empty audio rather than treating file existence as speech. No quality or latency result is recorded from that attempt.

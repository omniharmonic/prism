# Voice readiness review — implementation versus remaining acceptance

2026-10-10 engineering review draft. This supplements the canonical roadmap; it does not establish physical acceptance or authorize production deployment.

## V04 activation setup and acceptance

On a supported iPhone, open Settings → Action Button, select Shortcut, tap Choose a Shortcut and select Talk to Omni. Press and hold the button. If it is absent from the picker, create a shortcut in Shortcuts containing Omni’s Talk to Omni action, then select that shortcut. The app cannot silently assign a hardware button. [Apple instructions](https://support.apple.com/guide/shortcuts/apdfea15680b/ios).

On iPad, create a shortcut containing Talk to Omni; in the shortcut’s Details select Add to Home Screen. A Shortcuts widget is another system surface. [Apple Home Screen instructions](https://support.apple.com/guide/shortcuts/apd735880972/ios).

On Mac, while Omni runs, Control–Option–Command–Space opens voice through the same readiness coordinator. The Omni Voice menu also offers Talk to Omni; registration failure is visible. Authentication, privacy unlock, mounted navigation and microphone permission still apply. Repeated presses coalesce and retain an active conversation. Cold launch queues expire after 60 seconds. Most recently ready foreground scene selection is deterministic.

Physical checks still required: cold launch and warm launch; signed out then signed in; locked then unlocked; denied microphone permission; repeated presses during preparation, transcription and narration; expired request followed by unrelated launch; supported iPhone hardware assignment and iPad shortcut installation. Unit tests establish coordinator behavior, not hardware-button acceptance.

## V05 current local contract and lead-in gap

Hey Omni is opt-in, experimental full Apple speech recognition with an on-device capability check and requiresOnDeviceRecognition. It is not a dedicated efficient wake engine. Matching uses whole words in a bounded 4,096-character preview; request epochs reject stale and duplicate callbacks. Ambient audio is never written to a file or sent to Hermes. Recognition requests roll over at 50 seconds. Permission denial, unsupported local recognition and recognition errors have visible menu state; no remote fallback exists.

One coordinator preempts wake capture synchronously before a conversation takes the microphone. Conversation ownership lasts through narration and Pause, until End/cancellation. Sleep, app privacy lock, sign-out, window readiness and Mac user-session switch stop listening. Public session-switch notifications do not promise ordinary OS screen-lock coverage; verify that separately. A listener initialized after application launch may also miss the early inactive-session launch notification. No sleeping-Mac wake claim or login-helper registration exists. Launch-at-login remains a later explicit setting.

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

The inventory was first measured from public metadata; the corresponding pinned files have now downloaded for the isolated Mac spike. FluidAudio v0.17.7 pins v3 release 6c0750dd02ef9d981fb82f147d784a3f171755ee and seven-stage base 006395f65025af251858b1ab0a7178a6a1e73f9f. Applying the actual SDK selection rules yields 118,800,638 bytes for 16 v3 source/metadata files and 82,161,196 bytes for 24 base files. Default English voice adds 522,240 bytes; English vocab adds 1,416 bytes; manifest adds 20,416 bytes. Observed English frontend/G2P plus lexicon adds 12,015,574 bytes. Known download subtotal: **213,521,480 bytes (~213.5 MB decimal)**, excluding base-index JSON, HTTP metadata/notices and compiled caches. Full file hashes/sizes are in omni-kokoro-asset-inventory.json.

This fits a 750 MB download budget with room for metadata, but does not establish retained/transient disk or RAM limits. Local compilation duplicates source/cache assets; measure actual totals separately. Use default af_heart first to minimize extra voices. Preloading af_bella adds a 2,678,538-byte JSON download and a 522,240-byte converted cache file.

Important reproducibility gap: v3/base weights are pinned; shared English G2P and lexicon use the mutable repository main through the SDK downloader. Public main observed revision is d93c5f3eed11847fb81bd6d6a76665e133d7ca77. Pin or prepopulate those exact frontend files and verify cache checks before accepting a repeatable spike. The repository model card and conversion notice list Apache-2.0; retain model/conversion notices and finish selected voice provenance review before distribution. [Pinned SDK asset selection](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Sources/FluidAudio/TTS/KokoroAne/V3/KokoroAneV3Assets.swift), [model release](https://huggingface.co/FluidInference/kokoro-82m-coreml/tree/6c0750dd02ef9d981fb82f147d784a3f171755ee/ANE-v3).

Recommended next measurement: isolated foreground Mac subprocess, af_heart, ten synthetic passages, one persistent warm manager, controlled cache/download cap and crash-isolated output. Measure download, compilation, first PCM, resident memory, waveform frames and a 15-minute soak. Do not enable Kokoro in mobile builds before physical iPhone/A12Z testing; pinned upstream still documents unresolved mobile Core ML stability concerns.

The initial sandboxed Apple baseline produced zero-frame WAVs despite a successful process exit. The harness now rejects empty PCM. A subsequent unsandboxed say/Samantha render produced ten validated WAVs at /private/tmp/omni-apple-voice-baseline-valid without playback; these are available for listening comparison. No subjective quality or first-audible latency result is recorded yet.

## Evaluation evidence update

The pinned download completed: **213,544,176 bytes** across 57 files including both Apache notices, all checksums verified, within the 750 MB cap. Receipt: /private/tmp/omni-kokoro-cache/download-receipt.json. The complete downloaded manifest also includes exact frontend hashes and observed immutable revision; it is checked in with the isolated tool, not model blobs.

A single Apple say/Samantha render retried outside the sandbox produced 49,704 frames at 24 kHz. Ten fixed synthetic passages then rendered successfully with zero-frame validation: ten WAVs, 1,536,642 total frames, at /private/tmp/omni-apple-voice-baseline-valid. No playback was performed, so subjective quality and first audible latency remain unmeasured. The harness now rejects empty PCM WAVs.

## Isolated Mac Kokoro results

The default af_heart v3 engine successfully rendered three initial passages (nine files), then all ten passages with three renders each (30 finite, nonempty 24 kHz PCM WAVs). Inference ran with ModelHub.offlineMode after the pinned download. It did not play audio or enable Kokoro in Omni. Hardware: Mac14,5 / Apple M2 Max / macOS 26.6.2.

| Measurement | Observed | Boundary |
|---|---|---|
| First initialization with local compilation | 21,215 ms | Download already complete |
| Later process initialization with compiled cache | 872 ms | Model loading, no speech yet |
| Warm whole-utterance PCM, median | 197 ms | Twenty second/third renders; includes text processing |
| Warm whole-utterance PCM, range | 45–410 ms | Utterance lengths differ; not streaming first PCM |
| Peak process RSS | 1,091,207,168 bytes (~1.09 GB) | macOS getrusage peak, not mobile projection |
| Retained cache files after compilation | 406,075,811 bytes (~406 MB) | Transient/system compiler cache peak unmeasured |
| Downloaded bytes incl notices | 213,544,176 | No further inference-time model downloads |

The first short utterance took 3,288 ms to completed PCM in the initial process, then 55/44 ms on repetition; first longer passage took 3,624 ms then 159/147 ms. These show first-use graph costs that warm-only stage timing hides. Six of 30 ten-passage renders used the fast vocoder; longer responses correctly used the fallback path. The NeMo normalization trait was disabled to match the small dependency configuration; number/currency pronunciation is not accepted from this run.

Raw results: /private/tmp/omni-kokoro-ten/measurements.json and summary.json. Compare the warm second render of p02 or p03 against the corresponding Apple WAV at /private/tmp/omni-apple-voice-baseline-valid. Neither engine has been auditioned in this engineering pass; owner preference remains pending. First audible latency, playback underruns, cancellation/route changes, a 15-minute soak, peak transient disk and all iPhone/A12Z measurements remain unmeasured. **The Mac backend is demonstrated feasible to evaluate, not accepted to ship.**

# Omni conversational voice: patient, personal, readily available

Research and proposed implementation sequence, 2026-10-10. Extends O03 in the [product roadmap](prism-omni-product-roadmap.md); does not replace other product commitments. Implementation checkpoint: V01 Apple voice selection and the V04 foreground Talk to Omni shortcut shipped in Omni v7 on both mobile devices (PR101). Owner confirms the downloaded Apple voice appears and sounds better; shortcut acceptance remains pending. V02 explicit-completion persistent sessions are in implementation. V03/V05 and neural TTS remain planned; no wake listener or continuous recording has been enabled in a released build.

## Accepted baseline and remaining gap

Benjamin reports that voice now works after the v6 repair. Record this as owner acceptance of the basic voice exchange, without inferring which devices, Interrupt, lock/background behavior or Mac were tested. The original default speech quality was unacceptable; the owner now confirms a downloaded Apple voice sounds better. The next requested experience is a continuous conversation that tolerates long thinking pauses, with Mac wake-word activation and convenient mobile activation.

Pre-v7 source baseline: `ConversationDevice.speak` used `AVSpeechSynthesisVoice(language: "en-US")`, with no explicit quality preference or voice picker. V7 now supplies both; owner accepts the quality improvement. Current capture records a temporary file, then transcribes after Finish. `VoiceConversation` has off/preparing/listening/transcribing/answering states, generation cancellation and sentence playback, but no playback-completion transition to listening. The view currently cancels on scene inactivity, privacy lock or disappearance and has a two-minute capture limit that keeps a draft. Long think-aloud turns need bounded chunking without automatic submission, and an explicit limit/recovery UX until that exists. Streaming microphone analysis and interruption handling require real implementation; changing button labels will not produce a continuous session.

## Decisions

Keep Hermes as the agent and preserve its conversation, tools, approval receipts and Prism links. Build the conversation layer around it. Local microphone handling, turn decisions and playback should not depend on a future workstation. The Mini can optionally serve a better speech model if device benchmarks justify that path. Larger workstation models are a later quality option, not a prerequisite.

### V01 — Better voice, immediately discoverable settings

Enumerate installed Apple voices by identifier, language and quality. Add short previews, remembered selection, rate control, and a graceful fallback if a voice disappears. Prefer an available premium/enhanced voice in the selected language, with a visible way to audition alternatives. Guide users to system voice downloads where needed; do not promise programmatic installation of Apple voices.

Apple explicitly documents that Siri voices are not available through AVSpeechSynthesizer, even when selected in Spoken Content. Its public API supports installed system voices, including enhanced/premium quality. We should not promise the exact Siri voice or use private APIs. [Apple speech guidance](https://developer.apple.com/videos/play/wwdc2020/10022/), [quality API](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality).

Run a small listening comparison before choosing a bundled neural engine:

| Candidate | Why evaluate it | Decision gate |
| --- | --- | --- |
| Apple premium/enhanced | Existing playback path, minimal integration, device-managed voices | Owner likes one; correct selection persists; no model integration needed for first improvement |
| Kokoro-82M | Small open-weight TTS; multiple voices; existing FluidAudio ecosystem | Naturalness and first-audio latency on physical phone and A12Z iPad, not desktop benchmark extrapolation |
| Pocket TTS | 100M CPU-oriented model with streaming output | Same quality/latency gate, plus actual model download size, RAM and sustained battery cost |

[Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M), [Pocket TTS upstream](https://github.com/kyutai-labs/pocket-tts). Parameter counts are not download or resident-memory sizes. The checked-in dependency pins FluidAudio 0.17.7; its local Pocket documentation describes substantial Core ML assets. Its Kokoro-v3 documentation explicitly leaves physical iOS validation open. Current upstream documents both engines, but that is not proof of performance in our app. Pin the selected implementation and assets and check individual voice licenses before distribution. [FluidAudio](https://github.com/FluidInference/FluidAudio).

Use the same 10 synthetic passages for listening: short answers, warm conversational responses, dates/numbers, questions, and Benjamin/Omni/Prism names. Compare through the same audio route. Measure cold/warm first audio, underruns, peak RAM, disk/download size and a 15-minute conversation. Include the older iPad. Do not promise Siri-level subjective quality before the owner hears it. Host TTS, if selected, sends response text to the authenticated Mini, not ambient microphone audio; keep on-device fallback explicit.

### V02 — A persistent conversation that respects thinking pauses

The main Voice button or shortcut enters one voice session. The user sees a simple listening state, readable optional transcript, mute and End. After a completed reply, it returns to listening automatically. Keep the same Hermes conversation across turns.

Offer two understandable modes:

- **Think aloud (default for Benjamin):** silence never submits a turn. Finish by tapping the main control or an explicit configurable phrase such as “Omni, your turn.” Treat that phrase as a turn delimiter, not permission to send email or execute an outbound action. Make voice-command detection conservative and reversible before dispatch.
- **Automatic conversation (opt-in):** combine speech activity with end-of-turn cues and a configurable generous pause floor. Initial experiment: 6–8 seconds plus a cancellable grace interval; these are tuning candidates, not universal values. Resume speech cancels the pending endpoint immediately. A longer “keep listening” setting holds an uncertain turn instead of forcing submission at a timeout.

No detector can guarantee that a silent person has finished thinking. Explicit completion is the reliable mode for arbitrarily long pauses. Automatic mode must be evaluated against Benjamin's cadence, prioritizing false cutoffs over fastest possible response. Local partial transcription can support an optional live transcript, but partial text must not reach Hermes or trigger tools before the turn is committed. Keep transcript preview optional for users who find moving text distracting.

Start with local VAD and explicit completion. Evaluate a local turn model after the capture pipeline works. Pipecat's Smart Turn is an audio-based candidate with CPU inference; it does not require adopting the entire Pipecat framework. Its native iOS packaging still needs a feasibility spike. LiveKit's research is a useful comparison, not a reason to migrate our agent stack. [Smart Turn](https://github.com/pipecat-ai/smart-turn), [LiveKit turn detection](https://docs.livekit.io/agents/logic/turns/turn-detector/).

Implement one session state machine: inactive → preparing → listening → possible endpoint → submitting → waiting for agent → speaking → listening; mute/end/error are explicit transitions. Track agent completion separately from speech-queue completion. A sentence gap must not reopen recording while more reply audio is queued. Preserve generation ownership across cold launch, routing, cancellation and delayed server replies.

### V03 — Natural interruption and audio continuity

Allow the user to interrupt while Omni speaks. Detected near-end speech stops playback quickly and preserves the start of the user's utterance. Suppress loudspeaker echo so Omni does not answer itself. Investigate Apple's voice-processing audio path first; its route behavior still requires testing. Maintain tap-to-interrupt until reliable acoustic interruption passes on speaker and headphones. [Apple voice processing](https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:)).

Do not treat stopping speech as undoing an action already executed. Preserve any live outbound approval and distinguish stopping narration from cancelling the agent run. Spoken responses should sound conversational: strip Markdown artifacts, speak a useful concise answer, retain full text/cards in chat, and do not read every tool log. Show when a long-running task continues. Auto-resume listening only inside an explicitly active session, never after End, logout, permission denial or an unrelated launch.

### V04 — Instant mobile entry

Provide an App Intent/App Shortcut named “Talk to Omni” that opens a new voice session and starts listening after foreground readiness, authentication and microphone permission. Also support continuing an existing session without spawning duplicate conversations. Expose it for the iPhone Action Button and supported Shortcuts/system surfaces; offer an iPad shortcut/widget or keyboard entry because the current iPad has no iPhone-style Action Button. User assignment of the hardware button is a system setting, not something the app silently changes. [Apple App Shortcuts](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts).

Use the current foreground App Intent execution mode (`supportedModes = .foreground`) and explicit authentication policy for personal voice entry. Queue a bounded activation request through sign-in, app privacy lock and scene readiness; repeated button presses must not create duplicate sessions. [Apple App Intents](https://developer.apple.com/documentation/appintents/getting-started-with-the-app-intents-framework), [authentication policy](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy).

Verify cold/warm launch, locked/unlocked phone and permission denial on real hardware. Do not promise bypassing Face ID, arbitrary always-on background microphone access, or complete replacement of Siri. Background continuation of a deliberately started audio session is a separate capability from launching recording while locked.

### V05 — Mac wake word

Offer an opt-in local “Hey Omni” listener with visible menu-bar state and a global keyboard shortcut fallback. One process owns the microphone; wake detection hands off into the same native conversation session. Keep a short in-memory lead-in buffer so the first word after waking is not clipped. Do not retain ambient audio. Closing a window, quitting, disabling the listener, login, sleep/wake and headset changes need clear behavior; no claim that a sleeping Mac can hear the wake word.

Compare Porcupine's native/custom phrase path against an open local alternative. Porcupine needs an AccessKey and license/distribution review. openWakeWord's code and pretrained-model licenses differ, so do not treat an open code license as blanket redistribution approval. Hermes documents wake support; inspect the installed version before deciding to reuse it. A server-side listener on the Mini cannot hear the laptop's microphone remotely. Hermes documents `wake.start`/`wake.feed`/`wake.detected`, but its remote capture path sends ambient PCM to the backend. Prefer a native on-Mac detector for the proposed local contract, or reuse an adapter only if it preserves local capture and yields the microphone to Omni. App login-helper registration can use [Apple Service Management](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos). Avoid two independently running assistants capturing the same speech. [Porcupine](https://picovoice.ai/docs/porcupine/), [openWakeWord](https://github.com/dscripka/openWakeWord), [Hermes wake words](https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word).

## Delivery order and acceptance

1. V01 Apple voice picker/previews and V04 launch-intent skeleton can be separate Sol assignments. Parent reviews one shared session activation contract first. No speech-model upgrade in this first small release.
2. V02 persistent explicit-completion conversation, automatic re-listening and readable session controls. Replay tests with 2/5/10/20-second pauses must cause zero early submissions in Think aloud mode. End and late callbacks must never restart capture.
3. V03 interruption/echo behavior, then optional automatic endpointing. Measure false endings separately from transcript errors and end-to-first-reply latency; do not hide Hermes/network delays inside speech-engine measurements.
4. V05 Mac wake listener after shared audio ownership is stable. Test missed wakes and false wakes during ordinary speech/media playback, plus idle energy over a normal work session. Freeze the engine/phrase only after listening and licensing checks.
5. Select optional neural TTS from measured owner preference; the Mini is a fallback host before any workstation purchase. Workstation acceleration remains independent of these UX milestones.

Physical acceptance covers phone, older iPad and Mac; built-in speaker and available headset; permission denied, cold launch, lock/background, network loss, phone-call interruption and route changes. User approval is still required for outbound communications, and voice approval must bind to the exact pending action. No real outbound sends during engineering tests without exact authorization.

This plan is a proposed implementation sequence, not a claim these features are shipped. Maintain V01–V05 alongside the broader roadmap rather than letting voice replace collaboration, capability parity or onboarding work.


## V02 implementation scope — current pass

Ship the persistent, explicit-completion session first: Send turn commits recognized text; a verified turn-completion receipt plus an empty playback queue permits re-listening in the same Hermes conversation. Pause stops capture/narration and requires Resume; End, privacy lock, inactivity, navigation and stale callbacks cannot restart recording. A dropped stream is not turn completion. Preserve final text for fast replies and subsequent turns. Keep controls readable on narrow screens and large text.

The existing 120-second recording boundary remains: transcribe to a recoverable draft, explain the limit and pause without sending. This slice does not implement chunked long capture, live VAD, a spoken finishing phrase, acoustic interruption, automatic endpointing or wake words. These remain explicit V02/V03/V05 follow-ups. Test completion/playback ordering and cancellation with injected audio before physical multi-turn acceptance on phone, iPad and Mac.

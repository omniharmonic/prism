# Omni conversational voice: patient, personal, readily available

Research and implementation sequence, 2026-10-10. Extends O03 in the [product roadmap](prism-omni-product-roadmap.md); does not replace other product commitments. **V10 is implemented, not yet released or physically accepted.** The last recorded mobile release is v9. V01 Apple voice selection is owner-accepted; V02 build 8 explicit-session re-listening is owner-confirmed. The owner reports that v9 Automatic mode sends the first turn from a **new voice chat opened from the toolbar**, but produces no spoken reply and does not continue. That failure reopens Automatic acceptance. V10 implements retained-controller adoption, shorter pause choices, long capture, optional acoustic interruption and experimental Mac wake entry. These are implementation checkpoints, not claims that the reported failure or physical audio behavior is resolved. V04 foreground shortcut acceptance and Mac release/acceptance remain pending.

## Accepted baseline and remaining gap

Benjamin reports that voice now works after the v6 repair. Record this as owner acceptance of the basic voice exchange, without inferring which devices, Interrupt, lock/background behavior or Mac were tested. The original default speech quality was unacceptable; the owner now confirms a downloaded Apple voice sounds better. The next requested experience is a continuous conversation that tolerates long thinking pauses, with Mac wake-word activation and convenient mobile activation.

Pre-v7 `ConversationDevice.speak` used a language-only Apple voice. V7 supplies quality selection and previews; the owner accepts the improvement. Build 8 established persistent explicit-completion sessions and verified reply/playback drain. V9 added quiet empty Pause, compact controls and opt-in local VAD. V10 source now records bounded overlapping chunks rather than applying the earlier two-minute boundary, and implements optional playback interruption. Scene inactivity, privacy lock, End and stale callbacks still terminate or block capture; physical foreground/background and route acceptance remains required.

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

- **Think aloud (default for Benjamin):** silence never submits a turn. Finish by tapping Send turn. A configurable finishing phrase such as “Omni, your turn” remains planned; it would delimit a turn, not approve an outbound action.
- **Automatic conversation (opt-in):** V10 adds 2- and 4-second choices to the existing 8/12/20-second local speech-activity pause choices, default 12, followed by a visible 3-second countdown. Shorter choices trade patience for quicker completion and require owner testing. Resumed speech cancels the countdown; Keep listening resets the pause. This detects speech and silence, not semantic completion. A local end-of-turn model remains a possible later evaluation.

No detector can guarantee that a silent person has finished thinking. Explicit completion is the reliable mode for arbitrarily long pauses. Automatic mode must be evaluated against Benjamin's cadence, prioritizing false cutoffs over fastest possible response. Local partial transcription can support an optional live transcript, but partial text must not reach Hermes or trigger tools before the turn is committed. Keep transcript preview optional for users who find moving text distracting.

Start with local VAD and explicit completion. Evaluate a local turn model after the capture pipeline works. Pipecat's Smart Turn is an audio-based candidate with CPU inference; it does not require adopting the entire Pipecat framework. Its native iOS packaging still needs a feasibility spike. LiveKit's research is a useful comparison, not a reason to migrate our agent stack. [Smart Turn](https://github.com/pipecat-ai/smart-turn), [LiveKit turn detection](https://docs.livekit.io/agents/logic/turns/turn-detector/).

Implement one session state machine: inactive → preparing → listening → possible endpoint → submitting → waiting for agent → speaking → listening; mute/end/error are explicit transitions. Track agent completion separately from speech-queue completion. A sentence gap must not reopen recording while more reply audio is queued. Preserve generation ownership across cold launch, routing, cancellation and delayed server replies.

### V03 — Natural interruption and audio continuity

Allow the user to interrupt while Omni speaks. Detected near-end speech stops playback quickly and preserves the start of the user's utterance. Suppress loudspeaker echo so Omni does not answer itself. Investigate Apple's voice-processing audio path first; its route behavior still requires testing. V10 implements opt-in acoustic interruption, default off, while retaining tap-to-interrupt. Apple synthesized PCM is routed through the voice-processing engine, with bounded synthesis and hardware playback queues and an in-memory interruption lead-in promoted into capture. Physical speaker/headset echo rejection, false interruptions and first-word retention remain unaccepted. [Apple voice processing](https://developer.apple.com/documentation/avfaudio/avaudioionode/setvoiceprocessingenabled(_:)).

Do not treat stopping speech as undoing an action already executed. Preserve any live outbound approval and distinguish stopping narration from cancelling the agent run. Spoken responses should sound conversational: strip Markdown artifacts, speak a useful concise answer, retain full text/cards in chat, and do not read every tool log. Show when a long-running task continues. Auto-resume listening only inside an explicitly active session, never after End, logout, permission denial or an unrelated launch.

### V04 — Instant mobile entry

Provide an App Intent/App Shortcut named “Talk to Omni” that opens a new voice session and starts listening after foreground readiness, authentication and microphone permission. Also support continuing an existing session without spawning duplicate conversations. Expose it for the iPhone Action Button and supported Shortcuts/system surfaces; offer an iPad shortcut/widget or keyboard entry because the current iPad has no iPhone-style Action Button. User assignment of the hardware button is a system setting, not something the app silently changes. [Apple App Shortcuts](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts).

Use the current foreground App Intent execution mode (`supportedModes = .foreground`) and explicit authentication policy for personal voice entry. Queue a bounded activation request through sign-in, app privacy lock and scene readiness; repeated button presses must not create duplicate sessions. [Apple App Intents](https://developer.apple.com/documentation/appintents/getting-started-with-the-app-intents-framework), [authentication policy](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy).

Verify cold/warm launch, locked/unlocked phone and permission denial on real hardware. Do not promise bypassing Face ID, arbitrary always-on background microphone access, or complete replacement of Siri. Background continuation of a deliberately started audio session is a separate capability from launching recording while locked.

### V05 — Mac wake word

Offer an opt-in local “Hey Omni” listener with visible menu-bar state and a global keyboard shortcut fallback. One process owns the microphone; wake detection hands off into the same native conversation session. The intended final experience needs an in-memory wake lead-in. V10’s experimental Apple on-device “Hey Omni” listener does not retain wake lead-in: wait for Listening before speaking the request. It provides a global hotkey and menu-bar state, uses shared microphone ownership and yields before foreground capture. Full local speech recognition is an experimental substitute for a dedicated wake engine; idle-energy acceptance is pending. Do not retain ambient audio. Closing a window, quitting, disabling the listener, login, sleep/wake and headset changes need clear behavior; no claim that a sleeping Mac can hear the wake word.

Compare Porcupine's native/custom phrase path against an open local alternative. Porcupine needs an AccessKey and license/distribution review. openWakeWord's code and pretrained-model licenses differ, so do not treat an open code license as blanket redistribution approval. Hermes documents wake support; inspect the installed version before deciding to reuse it. A server-side listener on the Mini cannot hear the laptop's microphone remotely. Hermes documents `wake.start`/`wake.feed`/`wake.detected`, but its remote capture path sends ambient PCM to the backend. Prefer a native on-Mac detector for the proposed local contract, or reuse an adapter only if it preserves local capture and yields the microphone to Omni. App login-helper registration can use [Apple Service Management](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos). Avoid two independently running assistants capturing the same speech. [Porcupine](https://picovoice.ai/docs/porcupine/), [openWakeWord](https://github.com/dscripka/openWakeWord), [Hermes wake words](https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word).

## Delivery order and acceptance

1. V01 Apple voice picker/previews and V04 launch-intent skeleton can be separate Sol assignments. Parent reviews one shared session activation contract first. No speech-model upgrade in this first small release.
2. V02 persistent explicit-completion conversation, automatic re-listening and readable session controls. Replay tests with 2/5/10/20-second pauses must cause zero early submissions in Think aloud mode. End and late callbacks must never restart capture.
3. V9 local endpointing failed the owner’s new-chat Automatic acceptance. V10 implements lifecycle repair, shorter pause choices, chunked capture and optional V03 interruption; release and physical acceptance remain pending. Measure false endings separately from transcript errors and end-to-first-reply latency; do not hide Hermes/network delays inside speech-engine measurements.
4. V10 implements an experimental V05 Mac listener using shared audio ownership; release and physical acceptance remain pending. Test missed wakes and false wakes during ordinary speech/media playback, plus idle energy over a normal work session. Freeze the engine/phrase only after listening and licensing checks.
5. Select optional neural TTS from measured owner preference; the Mini is a fallback host before any workstation purchase. Workstation acceleration remains independent of these UX milestones.

Physical acceptance covers phone, older iPad and Mac; built-in speaker and available headset; permission denied, cold launch, lock/background, network loss, phone-call interruption and route changes. User approval is still required for outbound communications, and voice approval must bind to the exact pending action. No real outbound sends during engineering tests without exact authorization.

Implementation checkpoints above distinguish released builds from implemented work awaiting deployment and physical acceptance. Maintain V01–V05 alongside the broader roadmap rather than letting voice replace collaboration, capability parity or onboarding work.


## V02 implementation scope — current pass

Build 8 implemented persistent explicit completion: Send turn commits recognized text; a verified turn-completion receipt plus empty playback queue permits re-listening in the same Hermes conversation. Pause preserves an unsent draft and requires Resume; End, privacy lock, inactivity, navigation and stale callbacks cannot restart recording. A dropped stream is not completion.

V10 implements 60-second overlapping capture chunks, serial transcription and transcript joining, with a 15-minute total boundary, a three-chunk backlog limit and a 128 MiB disk limit. Per-file disk bounds also constrain high-rate routes. Limit or transcription failure recovers recognized partial words as an **unsent draft**, with an explicit notice that some audio may be unrecognized. No boundary submits automatically. Exact-boundary empty chunks, slow/cancelled transcription and long real-device turns remain physical acceptance work. A spoken finishing phrase remains planned.


## Build 8 acceptance and build 9 implementation

Owner confirms automatic re-listening after a spoken reply. The reported Pause recognition error occurred on an empty turn, not after spoken words: Build 9 implements quiet empty Pause, including a zero-frame capture, while retaining an error for an explicitly submitted empty turn. Physical iPhone screenshots reveal button/status/error overlap that Mac-width snapshots missed; Build 9 implements a compact panel with separate primary, status and secondary controls; physical acceptance remains pending despite simulator and snapshot validation.

Owner expects hands-free completion. Build 9 implements opt-in Automatic mode using local speech activity, a configurable generous pause, and a visible cancellable countdown; Think aloud remains available for arbitrary pauses. The default is 12 seconds plus 3 seconds of grace, with 8/12/20-second options. Silence before any speech cannot submit. Missing/stalled detector data cannot stand in for silence. This is speech-activity endpointing, not a claim to infer the user's intent or know when thinking has finished.

Automatic mode is selected explicitly in Voice options → Voice settings → Turn taking. Think aloud remains the default. Local detector preparation failure, stale evidence or backpressure falls back to manual completion with a visible notice; ambient audio is not sent to a remote detector. Settings apply at the next explicit session start/resume. Physical acceptance must still check patient pauses, resumed speech during countdown, quiet Pause, controls on the actual phone/iPad, and cancellation/background behavior.

### Build 9 release evidence checkpoint

Prism server `prism-v2026.10.10-12` deployed from `959e6af3` on the Mini, with backup and vault-health, worker and desktop-independence checks passing (receipt: `/Users/benjaminlife/deploy-state/prism-20261010T223722Z.log`). iPhone and iPad v9 installations succeeded (receipts: `/private/tmp/omni-client-v2026.10.10-9/iphone-install.log` and `ipad-install.log`). Mac v9 signature verified, with notarization request `5b42176e-30e4-4e0b-bf6b-bf7ec70ab719` still in progress. These receipts do not establish physical Automatic-mode acceptance.

Validation: 176 Core tests, 21 Client tests, five callback tests and one empty-recording regression passed; the full server suite passed 2,984 tests with one skip, plus 95 focused tests. Phone history geometry and 108 Mac snapshots passed. iPad visible-keyboard validation passed; iPhone keyboard automation was blocked by an offscreen target, and Mac XCUITest was blocked by the automation profile. Those blocked checks remain unverified. Prism laptop v6 was installed and native sign-in, opening and synchronization were verified.


## V10 implementation checkpoint — release and physical acceptance pending

The owner narrowed the v9 failure to Automatic mode’s first turn in a new toolbar voice chat. Server metadata for the reported turns at **22:40:38 and 22:41:57 UTC on 2026-10-10** shows successful completion in approximately **2.7 and 3.3 seconds**, with response text and result events and no server error. This establishes server completion, not client playback or resumption.

A concrete client lifecycle vulnerability was repaired: a retained SwiftUI control could keep the voice/audio from its initial state instead of adopting the newly created session. It could then consume a completion receipt while the inactive controller rejected playback. V10 reconciles the shared owner before callbacks and receipt consumption. The regression uses the actual UI coordinator with fake service/audio: an already initialized stale binding cannot steal the receipt, adopts the created controller, speaks the first reply once, waits for playback drain, re-listens, and keeps End ended. This proves the repaired sequence under injection; physical navigation must still verify the reported failure.

V10 also implements 2/4/8/12/20-second Automatic pauses plus the existing 3-second grace, bounded native tap chunking, long recording recovery, conversational narration of complete assistant blocks, default-off PCM acoustic interruption, shared microphone ownership, mobile launch guidance, and experimental local Mac wake/hotkey/menu entry. Full Markdown/cards remain in chat; tools/code are not narrated as a fabricated summary. Apple premium/enhanced remains default. [Optional neural TTS evaluation](omni-tts-evaluation.md) is a synthetic harness/protocol and feasibility review, **not measured Kokoro/Pocket performance or an enabled neural backend**.

Outstanding acceptance and scope:

- Release/install v10 on phone, older A12Z iPad and Mac, then verify first new-chat Automatic send → audible reply → re-listening and subsequent turns. Check every pause option, speech during grace, Keep listening, quiet Pause and narrow/accessibility controls.
- Verify long-turn chunk boundaries, repeated words across overlap, backlog/disk/15-minute limits, partial unsent recovery, cancel/restart and slow STT. A spoken finishing phrase remains planned.
- Test default-off acoustic interruption on speaker and headphones: echo suppression, false positives, retained first words, playback backpressure/failure, cancellation, privacy lock, route changes and calls. No claim of reliable physical echo behavior yet.
- Verify shortcut cold/warm launch, denied permissions, lock/authentication and shared-microphone handoff. Background/locked continuation remains a separate capability; no bypass of system authentication is promised.
- Test experimental Mac wake misses/false wakes, media playback, global hotkey, menu state, sleep/wake, logout/quit and idle energy. Wake lead-in and a measured dedicated low-energy detector remain gaps.
- Run the fixed listening comparison and cold/warm first-audio, download/cache, RAM, battery and soak measurements before selecting optional neural speech. Preserve outbound approval boundaries and the broader collaboration, capability-parity and onboarding roadmap.

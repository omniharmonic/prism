# Omni conversational voice: patient, personal, readily available

Research and implementation sequence, updated 2026-10-10 local time. Extends O03 in the [product roadmap](prism-omni-product-roadmap.md). **Build 17 is installed on iPhone and iPad; server 15 remains live.** Build 14 restored main-chat voice navigation. Build 16 repaired a reproduced MP3 EOF error that cut off queued endings; the owner reports several successful exchanges and the trace confirms five finished replies, including 78 seconds. A separate empty capture configuration stop remained. Build 17 verifies first input before Listening, retries one empty startup, recovers recognized startup words, starts voice on entry, and adds compact input mute that leaves replies playing. Owner reports build 17 iOS worked perfectly and accepts the reported voice troubleshooting as complete. See the [current v17 tracker](../../qa/omni-voice-v17-tracker.md), [v16 cause/evidence](../../qa/omni-voice-v16-tracker.md) and earlier trackers for historical receipts. Mac 17 is signed and independently verified on the Mini, with Apple notarization In Progress; installation and wake-word acceptance on the laptop remain open. Mac 11 retains its accepted/stapled receipt; Mac 13's prior notarization remains pending at the latest check. The [local TTS evaluation](omni-tts-evaluation.md) retains Kokoro and adds a pinned Kitten/Pocket shortlist; Kokoro af_heart audition is owner-preferred; hosted Kokoro integration is underway while the accepted iOS lifecycle remains unchanged.

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
3. V9 local endpointing failed the owner’s new-chat Automatic acceptance. V10 implements lifecycle repair, shorter pause choices, chunked capture and optional V03 interruption; mobile release is installed and physical acceptance remains pending. Measure false endings separately from transcript errors and end-to-first-reply latency; do not hide Hermes/network delays inside speech-engine measurements.
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


## V10 implementation checkpoint — mobile installed, physical acceptance pending

The owner narrowed the v9 failure to Automatic mode’s first turn in a new toolbar voice chat. Server metadata for the reported turns at **22:40:38 and 22:41:57 UTC on 2026-10-10** shows successful completion in approximately **2.7 and 3.3 seconds**, with response text and result events and no server error. This establishes server completion, not client playback or resumption.

A concrete client lifecycle vulnerability was repaired: a retained SwiftUI control could keep the voice/audio from its initial state instead of adopting the newly created session. It could then consume a completion receipt while the inactive controller rejected playback. V10 reconciles the shared owner before callbacks and receipt consumption. The regression uses the actual UI coordinator with fake service/audio: an already initialized stale binding cannot steal the receipt, adopts the created controller, speaks the first reply once, waits for playback drain, re-listens, and keeps End ended. This proves the repaired sequence under injection; physical navigation must still verify the reported failure.

V10 also implements 2/4/8/12/20-second Automatic pauses plus the existing 3-second grace, bounded native tap chunking, long recording recovery, conversational narration of complete assistant blocks, default-off PCM acoustic interruption, shared microphone ownership, mobile launch guidance, and experimental local Mac wake/hotkey/menu entry. Full Markdown/cards remain in chat; tools/code are not narrated as a fabricated summary. Build 11 selects the owner-requested Hermes/Edge provider, with downloaded Apple speech retained as an explicit local choice and fallback. The modular generation/playback contract preserves a future local-model adapter. [Optional neural TTS evaluation](omni-tts-evaluation.md) now includes an isolated Mac Kokoro measurement: 30 valid WAVs and about 1.09 GB peak RSS; no subjective/mobile/soak acceptance or production neural backend is claimed.

Outstanding acceptance and scope:

- Retest the current installed mobile release on phone and older A12Z iPad, then repeat after any v13 release; complete Mac rollout, and verify first new-chat Automatic send → audible reply → re-listening and subsequent turns. Check every pause option, speech during grace, Keep listening, quiet Pause and narrow/accessibility controls.
- Verify long-turn chunk boundaries, repeated words across overlap, backlog/disk/15-minute limits, partial unsent recovery, cancel/restart and slow STT. A spoken finishing phrase remains planned.
- Test default-off acoustic interruption on speaker and headphones: echo suppression, false positives, retained first words, playback backpressure/failure, cancellation, privacy lock, route changes and calls. No claim of reliable physical echo behavior yet.
- Verify shortcut cold/warm launch, denied permissions, lock/authentication and shared-microphone handoff. Background/locked continuation remains a separate capability; no bypass of system authentication is promised.
- Test experimental Mac wake misses/false wakes, media playback, global hotkey, menu state, sleep/wake, logout/quit and idle energy. Wake lead-in and a measured dedicated low-energy detector remain gaps.
- Run the fixed listening comparison and cold/warm first-audio, download/cache, RAM, battery and soak measurements before selecting optional neural speech. Preserve outbound approval boundaries and the broader collaboration, capability-parity and onboarding roadmap.


### Build 10 release checkpoint

PR109 merged as `f9f921b2430b7c7ee10ac74333b65cf9e7402512`, tagged `omni-client-v2026.10.10-10`. Both physical mobile installations succeeded. The server remains `prism-v2026.10.10-12`; this native-only release needs no server deployment. Mac build 10 is staged on the Mini with `sign-omni-v10.sh`; signing, notarization and installation remain pending. Build 9's prior notarization submission remains in progress and is not evidence that either Mac release is installed.

Validation: 197 Core tests, 24 VoiceKit tests and 10 targeted audio/layout tests passed; workspace `npm run check` passed. iOS Release and universal arm64/x86_64 Mac Release built successfully from the merged tag. Both binaries exclude DEBUG launch markers; strict iOS signature and both-device provisioning checks passed. Hosted CI was still running at this checkpoint; Rust jobs passed. Artifact hashes and install logs are in `/private/tmp/omni-client-v2026.10.10-10/release-evidence.txt`.

Requested physical acceptance: start from the Today/Threads **new voice chat** entry, select Automatic with a 4-second pause, and complete two turns. Verify the first full reply is spoken, re-listening starts, and the second turn works. Keep acoustic interruption off for this baseline; test its optional speaker/headset behavior separately. Installation alone does not close the reported failure.

## Historical build 11 verification checkpoint

The first-reply failure was reproduced in a mounted SwiftUI navigation test: the loading-to-transcript branch replaced the voice inset, and an obsolete control cancelled the adopted session. A stable container and ownership guards make that same test pass with one narrated first reply and a second listening turn. Resume now preserves the paused draft. Provider generation/cancellation, generated-audio drain, preview ownership, spoken-path filtering and an opaque adaptive composer surface are integrated. 208 Core tests and 25 UI tests passed together; the final preview-failure addition passed all 14 speech tests. Server tests passed 2,993 with one skip, plus 16 focused API/smoke checks. Physical first-reply and Pause/Resume acceptance remains pending; see the [working ledger](../../qa/omni-voice-v11-tracker.md) for deployment status.

At that checkpoint, build 11 was installed on iPhone and iPad. Server14 was live with a verified authenticated Edge MP3/cancellation test. Mac11 was signed and awaiting Apple notarization; the latest Accepted/stapled status is recorded above. Physical first-reply/Pause/Resume confirmation remains open; [current receipts](../../qa/omni-voice-v11-tracker.md#production-activation--verified).


## Historical build 12 evidence and v13 investigation

Build 12/server 15 are live. In the latest supplied iPhone trace, capture became ready at **00:15:15 UTC**, reply drain began at **00:15:33.7**, synthesis finished at **00:15:34.7**, playback began at **00:15:35.1** and finished at **00:15:38.8**. Re-listening/resume followed at **00:15:39.08**, then fresh capture ready at **00:15:39.59**. The returned MP3 was **21,312 bytes**, and about **3.7 seconds** of playback completed. No playback failure or acoustic-interruption event appears in this trace. The owner then reported “Automatic detection stopped”; the existing watchdog notice had no dedicated event in build 12. A restarted engine is not evidence that microphone taps or detector callbacks resumed.

Read-only preferences confirm **Automatic, 4-second pause, acoustic interruption enabled**. The owner has not yet supplied an acoustic-off comparison. This trace does not resolve the earlier longer-reply cutoff, validate speaker echo cancellation, or establish reliable subsequent turns. Reusable voice-processing graph starvation remains a hypothesis, not a confirmed cause or justification for a graph rewrite.

V13 source work separates watchdog delivery liveness from source-audio freshness, allows a bounded first-result startup interval, and adds coarse first-tap/first-detector/watchdog milestones. Source timestamps, stale-evidence rejection and endpoint continuity checks remain intact. Actual first-tap reporting is once per active, nonempty capture and rejects cancelled Device generations. The normal microphone/voice-processing graph is unchanged. The final actual iPhone XCUITest passed one same-render sheet handoff test (`ebd67299`, integrated `93e6e718`), with an inspected screenshot showing one retained sheet and voice panel. Sheet/navigation ownership and sustained callback regressions remain separate from physical audio acceptance; integrated verification passed 219 Core and 34 UI tests. The unrelated all-screen Mac snapshot walk was stopped after system Contacts XPC failures. **Build 13 is installed on both mobile devices; successful owner retest is still pending.** See the [v13 tracker](../../qa/omni-voice-v13-tracker.md) for the complete acceptance list and evidence limits.

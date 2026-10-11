# Omni voice v13: evidence and open acceptance

Checkpoint: 2026-10-10 local time. Canonical scope remains [V01–V05](../docs/roadmap/omni-conversational-voice-plan.md) and [O03 plus the broader product backlog](../docs/roadmap/prism-omni-product-roadmap.md). This tracker supersedes the current-state summary in the [v11 ledger](omni-voice-v11-tracker.md), without removing historical receipts or acceptance obligations.

## Release state

| Component | Current checkpoint |
| --- | --- |
| Mobile | Build 12 released; reported iPhone trace is from build 12. Installation is not complete Automatic-mode acceptance. Phone and older A12Z iPad need explicit current-build acceptance. |
| Server | Server 15 live; authenticated Hermes/Edge synthesis is available. Server success does not prove client playback or microphone resumption. |
| Mac 11 | Apple notarization Accepted; stapled, validated and Gatekeeper accepted. No new Mac installation this turn; interactive acceptance remains open. |
| Mac 12 | Staged unsigned; signing, notarization, installation and physical acceptance remain pending. |
| V13 | Repair, instrumentation and regression work in progress on `fix/omni-voice-rearm-v13`. **Not shipped, installed or owner-accepted at this checkpoint.** |

Release receipts belong in the chronological evidence logs. Do not silently convert staged artifacts, passing tests or an earlier notarization submission into installation or acceptance.

## Confirmed findings

The original Automatic failure starts a **new voice chat from the toolbar**. Reported server turns at 22:40:38 and 22:41:57 UTC completed in approximately 2.7/3.3 seconds, with text/result events and no server error. Mounted SwiftUI tests later reproduced the obsolete loading-branch inset cancelling the adopted voice controller; stable ownership/container repairs pass the same injected first-reply/re-listening sequence. Those tests do not close physical voice acceptance.

The owner prefers Hermes-generated Edge speech over Apple speech. The earlier longer reply reportedly began speaking, then glitched after its first words. Its cutoff cause remains unresolved. The latest trace below is a **different, short reply** that completed playback before the detector warning.

Latest supplied iPhone evidence (UTC times as supplied):

| Time | Event / fact |
| --- | --- |
| 00:15:15 | Initial capture ready. |
| 00:15:33.7 | Playback drain requested. This is a session wait boundary, not proof of audible playback. |
| 00:15:34.7 | Synthesis finished. |
| 00:15:35.1 | Playback started. Server returned a 21,312-byte MP3. |
| 00:15:38.8 | Playback finished after approximately 3.7 seconds. |
| 00:15:39.08 | Listening again / resumed. |
| 00:15:39.59 | Fresh capture ready after the normal playback drain. |
| Later | Owner reported “Automatic detection stopped”; owner cancelled roughly 58 seconds later. Exact cancellation time is not restated here. |

No playback failure or acoustic-interruption event appears in that trace. Build 12 did not log a dedicated watchdog event, so the warning's precise callback/timer history is not yet established by the trace. `captureReady` establishes successful engine startup, **not** arrival of microphone buffers or detector results.

Read-only device preferences still show **Automatic, 4-second pause, acoustic interruption enabled**. No acoustic-off comparison has been supplied. Absence of an interruption event on this turn rules out an observed promotion on that turn; it does not prove the enabled duplex path has no effect on restart or establish echo reliability.

## Confirmed source repairs and hypotheses

| Topic | Evidence / limit |
| --- | --- |
| Watchdog startup/liveness | The original watchdog started a 0.75-second deadline at capture ready and used source capture time for callback liveness. V13 separates delivery time from source freshness and allows a bounded two-second first-result interval, then retains 0.75-second ongoing delivery starvation detection. Source freshness and endpoint continuity checks remain unchanged. Physical warning resolution is pending. |
| Detector cadence | Pinned FluidAudio 0.17.7 processes 4,096 samples at 16 kHz: 256 ms per inference chunk. Tap arrival, chunk accumulation, inference and main-actor delivery occur before the first accepted result. This explains why startup readiness and first-result delivery must be distinguished; it is not a measured iPhone restart cause. |
| Tap / detector evidence | V13 records one `microphoneFirstTap` per active nonempty capture, generation guarded, plus first accepted detector frame, unavailable and watchdog milestones. No PCM, narration, paths, IDs or raw errors enter the bounded device-local diagnostic API. |
| Callback ownership | Read-only audit found coherent cancel → generation advance → new receiver → start ordering. Old detector tasks are stopped and queued old Device callbacks are rejected. No generation mismatch has been confirmed in the observed normal-drain restart. |
| Voice-processing graph reuse | AudioIO reuses its engine/player connection after stopping playback/engine, removing the tap and closing the detector. A graph-restart starvation defect remains a hypothesis. No speculative graph reset/rewrite is included in this work. |
| Playback cleanup | A confirmed failure-callback reentrancy issue was repaired: failed ownership is cleared before a session callback can start replacement playback. The regression keeps replacement audio pending until its own completion; no claim that it caused the reported longer-reply cutoff. |
| Empty recovery / drafts | Successful-empty Automatic results may rearm at most twice while session ownership remains valid. Manual Pause, errors, recovery notices and owner loss do not rearm. Acoustic promotion clears previously accepted resumed draft/captured words, preserving the new lead-in instead of duplicating an old prefix. Physical repeated-turn acceptance remains open. |
| Sheet/navigation | v13 sheet handoff and actual mounted lifecycle coverage are tracked alongside the earlier inset repair. The final actual iPhone XCUITest passed one test including the same-render repair (`ebd67299`, integrated `93e6e718`); screenshot review shows one retained sheet and voice panel. This UI lifecycle test does not establish physical microphone/echo or owner speech acceptance. |

The latest short reply completed. Treat “longer reply cuts off” and “Automatic detector warns after a completed short reply” as separate bugs until evidence connects them.

## Validation checkpoint

Source-only/synthetic evidence recorded for the speech work:

- 16 shared Speech tests, six provider tests and two diagnostic utility tests passed; OmniUI compiled. Cases cover cancellation, long/queued reply suppression, preview leases, failure drain and enum-only diagnostic boundaries.
- Eight VoiceKit stream/queue tests passed, including 90-second synthetic 24 kHz mono and 48 kHz stereo replay: all scheduled frames drain within the two-second / 4 MiB hardware window. This does not test physical playback, echo or an actual decoded MP3 route.
- First-tap work passed eight LocalSpeechActivity and two Device callback tests: fresh/empty/closed taps, native-rate input, stale/drop rejection, off-main delivery and cancelled-generation rejection. No real microphone was used; no engine graph acceptance is inferred.
- The final actual iPhone XCUITest passed one same-render sheet/voice handoff test, and its screenshot was inspected. Core/watchdog and hosted lifecycle regressions passed their focused runs. The full integrated native suite is currently running; no completed full-suite result is claimed here. UI fixtures and synthetic tests do not replace owner audio acceptance.

Do not count a synthetic trace or successful file render as physical first-audible latency, continuous microphone delivery, battery/thermal acceptance or a cross-platform release.

## Outstanding acceptance checklist

| Area | Open gate |
| --- | --- |
| First and subsequent turns | Today/Threads new-chat entry → first complete audible reply → sustained re-listening → at least two subsequent turns on phone, A12Z iPad and Mac. Check existing-chat and sheet/navigation handoff too. |
| Automatic warning | With the current selected four-second setting, correlate first tap, first accepted detector frame, unavailable/watchdog events and actual UI notice after normal playback drain. Repeat with acoustic interruption explicitly off as a baseline; compare the enabled path separately. |
| Longer replies | Reproduce the earlier cutoff with a genuinely longer reply; distinguish provider completion, complete audible playback, queue drain, interruption and cancellation. Short 3.7-second playback is insufficient acceptance. |
| Patient endpointing | Test 2/4/8/12/20-second pause choices plus three-second grace, resumed speech, Keep listening, silence before any speech, thinking pauses and all missing/stale detector paths. Think aloud remains explicit completion; semantic turn detection and a spoken finishing phrase are planned. |
| Pause / Resume / End | Quiet empty Pause; recognized and edited unsent draft retention; Resume exactly once; no old prefix after an accepted turn or acoustic promotion; End stays ended. Manual/error/recovery paths cannot silently rearm or send. |
| Long capture | 60-second overlap boundaries, repeated-word joining, slow/cancelled STT, exact-boundary empty chunks, three-chunk backlog, 128 MiB disk and 15-minute limits. Recover partial words as an unsent draft with a truthful notice; never auto-send a limit/failure. |
| Interruption / echo | Speaker and headphones, false interruptions, assistant echo, retained first words, playback failure/backpressure, near-end evidence and tap-to-interrupt. Acoustic interruption remains optional/default off; the owner's current preference is on. |
| Privacy / routes | Permission denial/revocation, privacy lock, End/logout, inactivity/background, route/headset changes, calls and capture cancellation. Shared microphone ownership and stale callbacks must preserve those boundaries. |
| Mobile activation | Cold/warm “Talk to Omni” shortcut, Action Button/Shortcuts assignment, locked/unlocked/authenticated/denied states, repeated launch requests, current sheet handoff and older-iPad entry. Locked/background continuation is separate; no authentication bypass. |
| Layout / accessibility | Actual phone/iPad narrow controls, keyboard/composer contrast, large text, VoiceOver, status versus primary actions and quiet notices. |
| Mac release | Finish the exact validated artifact's installation/launch checks on Mini and laptop, then real voice acceptance; keep Mac 11 and Mac 12 receipts distinct. |
| Mac wake | Experimental local Apple “Hey Omni,” hotkey/menu, shared microphone yield, misses/false wakes, media playback, quit/logout, sleep/wake and idle energy. Wake lead-in and a measured dedicated low-energy detector remain open. |
| Provider robustness | Explicit Hermes/Apple selection persists; downloaded Apple identifier is preserved; unavailable/timeout/cancellation/rate-limit paths show fallback truthfully; preview cannot preempt capture/reply; complete reply and hardware drain remain separate. |
| Outbound actions | Stopping narration is not undoing tools or cancelling an approved action. Preserve all existing approval receipts and outbound authorization boundaries. |

## Modular speech quality roadmap

Hermes/Edge is the owner-selected provider for this rollout, with settings disclosure that selected narration text goes to Microsoft through authenticated Hermes. Microphone detection remains local. Apple on-device speech remains an explicit choice and fallback; later explicit user selection must not be overwritten. The provider/rendering contract supports future local adapters without coupling turn state to one synthesis engine. A future adapter is a roadmap seam, not an enabled local feature.

Keep excellent local speech models on the roadmap. The [Kokoro evaluation](../docs/roadmap/omni-tts-evaluation.md) produced 30 valid Mac WAV renders in isolation, with roughly 213.5 MB verified download, 406.1 MB retained compiled cache and 1.09 GB peak RSS on an M2 Max. These are file-render/resource measurements, not streaming first-audio or mobile projections. Subjective owner comparison, normalization/pronunciation, actual audible latency, cancellation/underruns, transient disk peak, route changes, 15-minute soak, battery/thermal behavior and all phone/A12Z measurements remain open. Pocket TTS and other local adapters require pinned APIs/assets, license review and the same measurable quality/resource gates before adoption. The Mini/workstation quality option does not replace a reliable local microphone/session path.

No voice milestone removes the broader product backlog: collaboration/multi-user isolation, capability parity, recurring jobs/skills, notification destination/logo, task coverage, current Mac distribution, onboarding/installer and public distribution obligations remain separately tracked.

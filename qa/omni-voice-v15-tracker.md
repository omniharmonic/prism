# Omni voice v15 release candidate

Checkpoint: 2026-10-10 local time. **Mobile build 14 is installed. Build 15 source repair and regression verification are complete; packaging and physical acceptance remain pending.** Server 15 remains live. Historical release receipts and prior investigation remain in the [v14 tracker](omni-voice-v14-tracker.md); scope remains [V01–V05](../docs/roadmap/omni-conversational-voice-plan.md).

## Latest owner report

Main-chat navigation works almost perfectly. The owner intentionally interrupted the first spoken reply successfully, then the second longer reply encountered a playback error. Main-chat navigation acceptance is distinct from uninterrupted multi-turn audio acceptance. Earlier generic playback failures and detector warnings are historical evidence; do not merge their causes into this latest typed failure.

## Exact bounded device evidence

The local enum-only trace is `/private/tmp/omni-v14-device-audit/iphone-events.json`. It includes older sessions as well as the newest reproduction. This tracker records only event boundaries and elapsed times, never speech, message contents, audio, raw errors, credentials or identifiers.

| Latest sequence | Observation / limit |
| --- | --- |
| First reply | Synthesis completed; playback started and a microphone first tap followed in 107 ms. |
| Intentional interruption | `acousticInterruption` occurred approximately 30.31 seconds after playback start; `activityFirstFrame` followed in 203 ms. The promoted capture delivered accepted activity evidence. |
| Next turn | Transcribing, sending and sendAccepted occurred. Reply text queued, synthesis started, reply completion received and playback drain requested. |
| Synthesis | `synthesisFinished` followed synthesis start by 7.52 seconds. This indicates synthesis completion, not audible playback success. |
| Playback | At **01:12:15.648 UTC**, `playbackStarted`; **20.12 ms** later `playbackEngineInactive`, immediately followed by `playbackFailed`. There is no new `microphoneFirstTap` between this playback start and failure. |
| Recovery | `paused` followed failure in 204 ms; cancellation followed later. |

The typed category establishes that the shared playback engine was inactive at the guarded playback boundary. It does **not** establish who stopped the engine, a route-change cause, decoder corruption, cloud failure or assistant echo. No new tap before failure is useful evidence, not proof that every capture-start path failed. Successful earlier interruption and detector delivery do not close the subsequent playback failure.

## Investigation ownership

Speech quality owner investigates shared engine/route lifecycle and tests any proven repair. Continuity owner audits Core drain generations and stale completion behavior. Parent integrates and runs the actual main-chat UI and relevant regression checks before any separately tagged build 15 release. No production change or native build was performed for this documentation checkpoint.

## Distribution state

Mac 13 signature verification passed and notarization was submitted as `2cb6db1a-b22a-44ce-9d58-195842da86f4`; the **last reported status remains pending** until parent checks. Mac 14 is a local unsigned artifact. Neither statement implies installed desktop acceptance. Preserve earlier Mac 11 accepted/stapled receipts separately.

## Remaining roadmap gates

Retest intentional interruption followed by a complete subsequent long reply and automatic capture, interruption off/on, hardware drain, Pause/Resume, bounded empty recovery, permission/privacy/background/End/logout and route/headset/call changes. Repeat on iPhone and older A12Z iPad, including narrow/large-text/VoiceOver controls. Preserve approval and outbound-action boundaries.

V04 retains physical cold/warm Talk to Omni, Action Button/Shortcuts assignment, locked/authenticated/denied and duplicate activation tests. V05 retains opt-in experimental local Apple wake, visible menu/hotkey fallback, shared microphone yield, wake lead-in, false wakes, sleep/lock and idle energy gates. Modular providers remain explicit: Hermes/Edge and Apple are available choices; future local adapters must remain swappable without coupling session state to synthesis. Excellent local models remain on the roadmap. [Kokoro's retained Mac evaluation](../docs/roadmap/omni-tts-evaluation.md) is measured isolated file rendering, not an enabled production adapter or mobile/streaming quality claim. Subjective comparison, normalization, audible latency, cancellation/underruns, routes, soak and phone/A12Z resource measurements remain open.

## Reviewed repair and verification

Build 15 requires a first delivered microphone buffer and a running engine before enabling optional duplex playback. Startup is bounded to one second and scoped to the capture generation. Stop invalidates readiness; cancellation cannot enable a later capture. If optional acoustic monitoring cannot start, it is cleaned up and narration uses ordinary playback with manual interruption available. No blind engine restart or replay is introduced. The exact cause of the physical engine stop remains unproven. Fixed diagnostic categories now distinguish engine state at entry, after reconnect, while queued, and configuration changes.

Independent continuity review found no blocker: canceled old drain tasks cannot stop the next monitor, and failed readiness clears duplex before ordinary playback. Parent reviewed first-tap and notification callback ownership and stop invalidation. Integrated verification: 219 Core tests and 39 UI tests passed; 7 focused VoiceKit readiness/queue tests passed. Logs: `/private/tmp/omni-v15-native-tests.log`, `/private/tmp/omni-v15-voicekit-tests.log`. Source release guard passed. The unrelated MacSnapshotTests full walkthrough remains excluded; host Contacts/CoreData XPC warnings did not fail the selected tests. No UI route changed in this repair; build 14's actual iPhone main-chat UI pass remains historical evidence.

Physical acceptance remains mandatory: intentionally interrupt one reply, then hear a complete subsequent long reply and return to Listening. A successful build does not close this gate.

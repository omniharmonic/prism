# Omni voice v14 investigation — not released

Checkpoint: 2026-10-10 local time. Build 13 remains installed on iPhone and iPad; server 15 remains live. **No build 14 artifact, test result, installation or acceptance is claimed here.** Historical release and test receipts remain in the [v13 tracker](omni-voice-v13-tracker.md). Scope remains [V01–V05](../docs/roadmap/omni-conversational-voice-plan.md).

## Owner feedback and device evidence

The owner reports build 13 “pretty much works perfectly,” but wants the conversation in the main chat instead of a persistent popup. The owner intentionally interrupted the first spoken reply acoustically, then encountered an error. This is substantial progress, not complete voice acceptance.

The supplied local enum-only trace at `/private/tmp/omni-v13-device-audit/iphone-events.json` spans earlier and current sessions. It contains event names and timestamps only; do not attach audio, transcripts, message contents, credentials or raw errors to this tracker.

| Current observed boundary | Evidence and limit |
| --- | --- |
| Initial capture | `captureReady` → `microphoneFirstTap` in 106 ms → `activityFirstFrame` in another 216 ms. The detector delivered an accepted frame. |
| Intentional interruption | `playbackStarted` → `acousticInterruption` in 2.115 seconds → `activityFirstFrame` in 296 ms. The promoted capture delivered accepted activity evidence. |
| Subsequent turn | `transcribing` → `sending` → `sendAccepted`, then synthesis finished and playback started. |
| Playback failure | `playbackFailed` followed playback start by **19.13 ms**, then `paused` after 211 ms. The trace proves a client playback failure boundary; it does not identify the raw failure or prove cloud synthesis caused it. |
| Later capture | A new session reached capture ready, first tap in 112 ms and first accepted detector frame in another 211 ms. A later accepted send ended with Pause approximately 60.8 seconds afterward; this trace alone does not explain that Pause. |

No `activityUnavailable` or `activityWatchdog` event appears in the current supplied sequence. Successful detector delivery is distinct from the unresolved playback failure. Earlier build 12's completed 3.7-second reply followed by the detector warning remains historical evidence, not the latest failure's diagnosis. The event trace cannot establish absence of all route, echo or playback issues.

## Work in progress

- Continuity owner: replace persistent first-turn sheet with main-chat handoff while preserving one mounted voice owner, avoiding overlapping dismissal/push transitions and stale destination restoration. Existing build 13 retained-sheet behavior was deliberate but does not match the owner's preference.
- Speech owner: inspect the proven post-interruption playback-failure boundary and add bounded, privacy-safe failure classification only where needed. Do not attribute the 19 ms failure to an unproven cause.
- Parent: integrate, run focused and integrated checks, inspect actual iPhone navigation, then build and install a separately tagged release. Passing synthetic navigation is not physical audio acceptance.

## Release distinction

Mac 13 signature verification passed and the artifact was submitted for Apple notarization under `2cb6db1a-b22a-44ce-9d58-195842da86f4`. Status is **pending until the parent checks**; submission is not acceptance, stapling, installation or voice validation. No notarization poll was performed for this documentation checkpoint.

## Acceptance still open

Main-chat first-turn handoff; intentional acoustic interruption followed by a complete subsequent reply and automatic capture; long replies with interruption off/on; Pause/Resume and bounded empty-turn recovery; speaker/headphone and route changes; privacy lock, background, End and logout; narrow/large-text/VoiceOver controls; older A12Z iPad acceptance. Preserve all approval and outbound-action boundaries.

V04 still needs physical cold/warm Talk to Omni, Action Button/Shortcuts assignment, lock/authentication/permission and duplicate-launch checks. V05 remains an opt-in experimental local Apple wake listener with visible state and hotkey fallback; wake lead-in, false wakes, sleep/lock coverage and idle energy remain gates. Excellent local models remain explicit: [Kokoro's measured Mac file-render evaluation](../docs/roadmap/omni-tts-evaluation.md) is retained, with no production local adapter or mobile quality/resource claim. Subjective comparison, audible latency, cancellation, normalization, routes, soak and phone/A12Z measurements remain open.

## Synthetic UI fixture

The previous loopback gateway launcher PID 310 was stopped. A fresh backend process is required before the next XCUITest. Existing private synthetic env/DB under `/private/tmp/omni-v13-ui-fixture` may be reused for a focused test, but a new isolated DB/stub state is preferable for independent navigation fixtures and reproducible receipts. Launch with a scrubbed environment, explicit dummy `PARACHUTE_TOKEN` (preventing vault-token mint), dead-loopback Parachute URL and disabled executors/approvals. Never use production/dev secrets or real agents. `uitest.sh` creates a short-lived fixture browser session and real scoped test-device credential, then revokes/deletes them at cleanup; keep credentials out of logs. Check the selected loopback ports are free. No backend was started and no native build was run for this checkpoint.

## Integrated repair candidate

Voice creation now enters the main Threads navigation stack. A single retained entry resolves directly to the created conversation, without a popup or a second push. Same-thread external navigation preserves the owner; Back, text composition and unrelated destinations clear abandoned routes. The actual iPhone simulator test passed the main-chat creation, transcript, one-panel, End/Back/new-voice path; final integrated rerun is pending.

Compressed speech now reads bounded chunks to actual decoded EOF, independently caps decoded duration, rejects empty audio and preserves thrown decoder errors. The private MP3 remains available until decoding exits, then is removed on completion, failure or cancellation. The actual resource scope is covered by 21 focused speech tests, including cancellation while the bounded hardware queue is full. The synthetic MP3 host probe failed to decode; it did not reproduce the owner's physical failure. No audio graph rewrite or root-cause claim is made.

New fixed diagnostic categories distinguish decode, route, engine, capture and buffer-budget failures. Completion receipt, first narration queue and UI pause requests are also enum-only; no message/audio content, identifiers or raw errors are recorded. Independent review found no remaining blockers. Integrated native tests, Release builds and physical acceptance remain to be recorded.

## Final integration verification

Integrated Core219 and UI39 tests passed, excluding only the unrelated full Mac screenshot walk. Final actual iPhone XCUITest passed1 in20.54seconds after all source changes; the main-chat screenshot was inspected. Independent review cleared same-thread link ownership, Back/unrelated-route cleanup, bounded decoder EOF, cancellation cleanup and enum-only diagnostic privacy. Release source exclusions and whitespace checks pass. Hosted CI and physical build14 acceptance remain pending; these results do not reproduce the original phone playback failure.

# Automatic relisten and iPhone voice-sheet handoff

Build 12 device feedback described a screen flash when the initial voice turn became a thread, then an “Automatic detection stopped” notice after reply playback. Existing device diagnostics showed normal playback drain, relisten, and capture readiness, without a playback failure. This does not establish the physical detector failure's cause.

## Detector startup versus heartbeat

The Core watchdog previously applied a 0.75-second timeout immediately after capture readiness and measured its liveness against the detector's source capture timestamp. The pinned local VAD accumulates 4096 samples at 16 kHz (256 ms) before inference; a ready microphone does not mean the first detector result has arrived.

Core now permits two seconds for the first accepted result, then applies the existing 0.75-second delivered-callback heartbeat. Source capture freshness remains independently checked by `VoiceEndpointPolicy` (at most 0.5 seconds old with bounded continuous audio time). Delayed or stale source audio cannot count as a healthy result. Unavailable detection leaves explicit Send turn available. Replacing a watchdog cancels its prior timer, and frames after unavailability cannot create a new health milestone.

Coarse enum-only diagnostics distinguish first microphone tap, first accepted detector frame, unavailability, and watchdog expiry. No PCM, speech text, IDs, raw errors, or per-frame logs are recorded.

`VoiceActivityLivenessTests` uses the production watchdog Task, real monotonic uptime, and a timed synthetic callback source. It tests a 1.1-second first-result delay and sustained 256-ms callbacks across reply drain and automatic relisten, rejects 0.6-second-old source audio without a send, and preserves bounded missing-startup/lost-heartbeat fallback. It does not request microphone permission or use a speech model.

## iPhone navigation

The iPhone tab view dismissed the new-thread sheet and pushed a thread onto the underlying navigation stack after creation. Those were two visible transitions. A voice-created thread now stays in the existing sheet. The underlying thread opens only after the person closes that sheet, avoiding another mounted voice panel underneath it. Text creation retains its normal navigation. The thread voice panel seeds its expanded state from the active session at initialization, rather than waiting for appearance; later user toggles remain local state.

`VoiceSheetHandoffTests` covers the exact coordinator used by the iOS tab view, including deferred dismissal navigation, ended/text sessions, and intervening navigation. The iOS XCUITest `OmniWalkTests.testIPhoneFirstVoiceTurnStaysInPresentedSheetUntilDone` drives the actual tab/sheet UI with the DEBUG-only `voice-handoff` synthetic audio fixture and a loopback development gateway. It asserts the sheet remains presented with one active voice panel and closes to the created thread without restarting capture. Simulator execution and Release binary fixture exclusion must be reported by the integrated release checks; the source exclusion check has passed.

Focused verification before integration: 13 Core tests and 5 UI policy/hosted lifecycle tests passed (`/private/tmp/voice-relisten-tests.log`); `Scripts/check-release.sh --source` passed. Two small review guards (ignore already-unavailable frames and cancel a replaced watchdog) were added afterward; integrated tests should include them. Actual iPhone output/detector behavior remains a physical-device check.

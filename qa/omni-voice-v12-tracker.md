# Voice build 12 — recovery and diagnosis

Owner feedback after build 11: Pause/Resume works and retains earlier words. New issues: transcription-to-message appears stalled then pops in; an unrecognized turn briefly leaves capture; longer reply on iPhone stops after a few words. Voice acceptance remains open.

Parallel ownership: continuity worker covers capture/submission/UI; speech worker covers playback failure/long PCM; backend worker covers bounded synthesis outcome logs; parent integrates and verifies deployment/device evidence.

## Findings

- Actual iPhone preferences confirm Automatic, four-second pause, acoustic interruption enabled. An off/on comparison was requested; no answer yet. Echo is a hypothesis, not established cause.
- No matching recent Omni crash report: available reports are from 11:00, 12:18 and 13:00. This does not prove no audio error.
- Build 11 has no persisted detailed voice lifecycle trace and disables its HTTP DiagnosticsLog in Release. Recent production logs have no synthesis markers because none were emitted. These logs cannot determine the cutoff cause.
- Confirmed UI issue: awaiting send/create was labelled Transcribing. A read-only submission phase now displays Sending your turn and Creating your conversation/Sending your message.
- Confirmed empty-capture behavior: successful empty STT always paused. Automatic mode now retries at most twice, only with current listening ownership, no draft/recovery notice and no error. Explicit Pause and failures remain paused.
- Confirmed speech cleanup reentrancy and acoustic draft-prefix fixes are integrated and independently reviewed. Do not claim either reproduces the owner's exact long-reply cutoff.

## Diagnostics contract

Native trace accepts only enum events and timestamps. It retains at most 256 entries/64KB in Library/Caches/OmniVoiceDiagnostics/events.json, prunes entries older than a day on subsequent logging, writes off the UI/audio threads with private permissions, and never records speech, message text, request/device IDs, paths, raw errors or credentials. Backend terminal synthesis events contain fixed outcome/stage/status, elapsed milliseconds, byte count and registered provider ID only. No trace uploads automatically.

## Remaining acceptance

- New voice chat transcription → visible sending → message/first reply → listening on iPhone and iPad.
- Empty Automatic turn recovery, spoken and empty Pause/Resume, no duplicate prefix after acoustic interruption.
- Long reply with acoustic interruption off and on; inspect metadata trace after reproduction.
- Focused speech/provider/diagnostic tests:24 passed; VoiceKit long-stream/queue tests:8 passed. Recovery tests:34 Core +3 hosted UI, plus10 follow-up Core passed. Backend outcome/API/smoke:21 passed and integrated typecheck passes. Full relevant integrated native tests and Release builds are next.
- Keep V03 physical echo/route checks, V04 shortcut acceptance, V05 wake lead-in/energy and local-model evaluation open in the canonical roadmap.

## Release and device evidence

PR114 merged as `d821662e`; tags `omni-client-v2026.10.10-12` and `prism-v2026.10.10-15`. Integrated native checks passed216Core+29UI; workspace/server checks and tagged iOS/universalMac Release builds pass. Both physical mobile installations succeeded. Server15 passed backup/tagged deployment and health/worker/desktop-independence checks. Synthetic speech smoke: metadata200,40320-byteMP3 in794ms, DELETE200/cancelledPOST409/cleanup200. Production terminal metadata was confirmed with no content fields.

iOS ZIP SHA256 `dfb03660a30ef8761aafc3ff8ef0b58ab329ec115dd94e1aa00543ec3d8547cc`; unsignedMac ZIP `71d699259421827a7b0ddead77ef5892f7ee3009ac304ba413b9b2bd3bc5087f`. Mac12 staged with verified hash at `~/release-artifacts/omni-client-v2026.10.10-12/omni`; desktop signing pending. Mac11 notary `b4e56e1f-dcd5-472d-bfa2-34720021eab4` remains In Progress.

Owner reconfirmed screen flash at first capture/message transition and Automatic detection stopping after the spoken reply. Actual iPhone enum trace at18:15MDT confirms accepted send, synthesis finished, playbackStarted→playbackFinished over3.7seconds, then listeningAgain/resumed/captureReady; no playback failure event in that turn. User cancellation occurred about58seconds later. This is a detector-restart issue separate from the earlier long-reply cutoff. Current trace lacks detector-start/first-tap/watchdog events; build13 investigation adds those boundaries. No claim all voice acceptance is complete.

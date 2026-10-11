# Voice build 12 — recovery and diagnosis

Owner feedback after build 11: Pause/Resume works and retains earlier words. New issues: transcription-to-message appears stalled then pops in; an unrecognized turn briefly leaves capture; longer reply on iPhone stops after a few words. Voice acceptance remains open.

Parallel ownership: continuity worker covers capture/submission/UI; speech worker covers playback failure/long PCM; backend worker covers bounded synthesis outcome logs; parent integrates and verifies deployment/device evidence.

## Findings

- Actual iPhone preferences confirm Automatic, four-second pause, acoustic interruption enabled. An off/on comparison was requested; no answer yet. Echo is a hypothesis, not established cause.
- No matching recent Omni crash report: available reports are from 11:00, 12:18 and 13:00. This does not prove no audio error.
- Build 11 has no persisted detailed voice lifecycle trace and disables its HTTP DiagnosticsLog in Release. Recent production logs have no synthesis markers because none were emitted. These logs cannot determine the cutoff cause.
- Confirmed UI issue: awaiting send/create was labelled Transcribing. A read-only submission phase now displays Sending your turn and Creating your conversation/Sending your message.
- Confirmed empty-capture behavior: successful empty STT always paused. Automatic mode now retries at most twice, only with current listening ownership, no draft/recovery notice and no error. Explicit Pause and failures remain paused.
- Confirmed speech cleanup reentrancy and acoustic draft-prefix fixes are tracked in the pending integration. Do not claim either reproduces the owner's exact long-reply cutoff.

## Diagnostics contract

Native trace accepts only enum events and timestamps. It retains at most 256 entries/64KB in Library/Caches/OmniVoiceDiagnostics/events.json, prunes entries older than a day on subsequent logging, writes off the UI/audio threads with private permissions, and never records speech, message text, request/device IDs, paths, raw errors or credentials. Backend terminal synthesis events contain fixed outcome/stage/status, elapsed milliseconds, byte count and registered provider ID only. No trace uploads automatically.

## Remaining acceptance

- New voice chat transcription → visible sending → message/first reply → listening on iPhone and iPad.
- Empty Automatic turn recovery, spoken and empty Pause/Resume, no duplicate prefix after acoustic interruption.
- Long reply with acoustic interruption off and on; inspect metadata trace after reproduction.
- Complete speech/provider/VoiceKit regressions, Release builds and rollout receipts before installation.
- Keep V03 physical echo/route checks, V04 shortcut acceptance, V05 wake lead-in/energy and local-model evaluation open in the canonical roadmap.

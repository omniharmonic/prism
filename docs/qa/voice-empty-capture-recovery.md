# Empty capture and submission progress

Build 11 feedback described a brief loss of voice capture after speech was not recognized, and a transcription indicator that appeared stuck before the message arrived. Source inspection confirmed two transitions:

- Successful empty capture always paused the microphone, including Automatic mode.
- Awaiting message acceptance or new-thread creation retained the transcription label even after recognition had completed.

Automatic mode now permits two successful-empty retries while the current owner still allows listening, with no unsent draft or transcription recovery notice. It keeps the session active and shows “Didn't catch that. Still listening.” The third empty capture pauses for explicit Resume. Explicit Resume and recognized speech reset the retry budget. Manual mode, explicit Pause, recording limits, recovery notices, capture failures, privacy/scene/ownership loss never trigger this retry.

A read-only submission flag changes the panel to “Sending your turn” and “Creating your conversation…” or “Sending your message…” after recognition finishes. Acceptance, cancellation, and pause clear the flag. The UI keeps the same session while a delayed creation finishes.

Validation: 34 focused Core tests and 3 mounted SwiftUI lifecycle tests passed. These include bounded empty recovery, manual/error/recovery/owner-loss exclusions, recognition versus delayed-send progress, late send completion after cancellation, exact draft continuation, fast first reply, delayed thread creation, and a stale old-view scene callback. The mounted delayed-creation test uses an in-memory synthetic service and fake audio; no microphone or server is opened. Log: `/private/tmp/voice-empty-recovery-tests.log`.

Coarse enum-only diagnostics record the capture/transcription/empty retry/submission/pause/cancellation transitions using the bounded device-local diagnostics utility. They contain no speech text, request IDs, paths, credentials, or raw errors. Installed-device behavior remains a release verification step.

Follow-up: acoustic promotion (`speech` and `speechEvidence`) now clears the draft prefix and captured-text bookkeeping of the already accepted turn. This prevents a resumed draft from being prepended again to a new interruption turn while preserving the retained microphone lead-in. The regression checks both promotion events, exactly one old prefix, new-turn words only, and no additional recording start. Ten focused continuity/recovery/progress tests passed; log: `/private/tmp/voice-acoustic-prefix-tests.log`. Normal playback drain and permitted listening restart emit separate coarse events.

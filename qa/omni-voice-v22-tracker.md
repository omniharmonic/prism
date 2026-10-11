# Omni Mac22: combined desktop voice pass

## Owner feedback and scope

Batch desktop padding, glass controls and synthesis/fallback observability before one signing/notarization. Preserve experimental speech interruption (explicit owner preference) and accepted mobile playback. No server changes.

Mac21 local trace shows synthesis failure then Apple fallback, successful next Kokoro playback, and final acousticInterruption rather than playbackFailed. Owner initially reported silence, then noted a possible cough while wearing headphones/earbuds. Do not conclude speaker echo or a confirmed playback failure. Existing VAD accepts 0.3 seconds of speech-like evidence; no threshold or interruption policy changes in this pass.

Bounded production outcome metadata includes one synthesis-stage Kokoro409 cancellation518ms among successful replies, but lacks correlation/time data sufficient to prove it is this Mac request. Read-only code audit found scoped cancellation and worker cleanup protections; no proven cross-device cancellation leak.

## Changes

- Mac-only compact header/action sizes and native glass/glassProminent button styles; retain Reduce Transparency fallbacks. Main panel already used glass; no claim its material was removed.
- Provider catalog shows checking state and stale concurrent results cannot overwrite a newer refresh. Warming/unavailable copy no longer tells an already configured owner to install a model.
- Fixed-enum synthesis categories distinguish remote cancellation, timeout, unavailable/busy, authorization, transport, invalid data and other errors without speech, identifiers or raw error text. Local cancellation remains silent; active remote failures still use Apple fallback. No speculative retries.

## Verification and remaining limits

35 focused tests passed:21ConversationSpeech,3VoicePanelLayout,11ReplySpeechProvider. Includes catalog loading state and existing service/cancellation guards, plus new classified remote error, local cancellation and privacy boundary checks. Universal Release and composited desktop verification pending. Real cough/ambient speech discrimination and exact prior synthesis failure root cause remain unresolved; improved diagnostics apply future events only.

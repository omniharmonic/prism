# Omni voice follow-through — build 11 working ledger

Updated 2026-10-10. The owner asked for autonomous parallel work while away. This ledger supplements the canonical product/voice roadmap; none of these items is accepted merely because a unit test or build passes.

| Item | Evidence / current state | Owner / next gate |
| --- | --- | --- |
| First reply in a new voice chat is silent; session stops | Owner reconfirmed the same failure after build 10: transcription and Hermes response succeed, first response is not narrated, and a new voice session must be engaged. **Reopened; prior binding fix insufficient.** | Continuity worker: reproduce the real new-chat → created-thread SwiftUI lifecycle, preserve submission/playback ownership, add integration coverage. Physical two-turn acceptance remains required. |
| Resume after Pause | Confirmed code defect: Pause saved speech into composer, Resume required empty composer. Repair continues exact saved prefix and preserves edits/recovery; four new regressions, 43 focused Core tests passed. Integrated, not released. | Continuity worker / parent: integrate with provider and lifecycle changes; repeat spoken Pause → Resume → Send without loss or duplication. |
| Hermes TTS quality | Mini verified Edge TTS 7.2.7, en-US-AriaNeural. User explicitly prefers it and authorizes using it; Microsoft receives synthesis text. | Backend worker: bounded authenticated synthesis/cancellation, no arbitrary cache path exposure; synthetic audio verification only during development. |
| Modular providers | User explicitly requests swapping providers and retaining excellent local models. | Native speech worker: common generation-owned output contract, Hermes selection, Apple local choice/fallback, preserve downloaded Apple voice preference; future local adapter remains explicit unfinished work. |
| Audio path spoken aloud | Owner heard a Hermes audio-cache address narrated. | Native speech worker: remove audio transport/cache markers from narration while retaining useful prose; avoid duplicate audio and preserve chat source. |
| Composer transparency | Screenshot shows transcript bleeding through message dock. Opaque adaptive system surface added behind dock/input; not released. | Parent: inspect narrow/light/dark and keyboard layout alongside existing return/dismiss behavior. |
| Calendar/Parachute bridge mismatch | Screenshot's exact conversation called skill_view, skill_manage, tool_describe, session_search; no real calendar lookup. Actual bridge rejected skill_manage and tool_describe as absent from its tool list. Read-only CLI tasks succeeds; calendar over SSH hits gog authentication failure after correcting PATH, which does not prove GUI/gateway failure. | Parent: inspect current deployed registry/bridge before changing policy; do not infer permission cause from assistant prose or weaken outbound approvals. |
| Existing roadmap | V01 Apple voice quality accepted; V02 automatic/new-chat acceptance failed; V03 interruption optional and physically unverified; V04 physical shortcut acceptance pending; V05 wake energy/lock/false-wake/lead-in unfinished. | Preserve scope in canonical roadmap. No claim that the whole roadmap is shipped. |
| Local neural models | Kokoro Mac isolated trial produced 30 valid WAVs; 213.5 MB download, 1.09 GB peak RSS; no subjective/mobile/soak acceptance. | Keep local option active; compare quality and playback latency, normalize numbers/dates, then evaluate Mac adapter before older-iPad shipment. |

## Next release gates

- Reproduce and cover new-chat navigation with the actual lifecycle callbacks; first completion must narrate once and resume listening, including fast reply during handoff.
- Spoken and empty Pause/Resume, draft edits, cancellation, End, privacy lock, navigation and delayed callbacks must preserve ownership and unsent words.
- Provider cancellation, timeout, unavailable server, authenticated MP3 bounds, fallback and no duplicate narration; no real external messages in tests.
- Confirm composer contrast and controls with keyboard and accessibility sizing.
- Native and server checks, reviewed PRs/tags, named production deploy/signing runbooks, then device installs. No new release before the reported issues have been investigated and integrated.
- The owner is away; complete independent work and stage any unavoidable desktop-signing step rather than requesting repeated input.

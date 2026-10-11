# Omni19: voice settings, recognition and transcript polish

## Owner feedback and scope

Owner accepts Kokoro speech quality and reports voice generally working perfectly. This pass preserves the accepted capture/playback/interruption lifecycle and addresses five specific issues: main Settings access; compact Pause; custom vocabulary influencing speech after deletion; missing initial transcript; abrupt panel transitions. Physical build19 acceptance remains pending.

## Changes and causes

- Main Settings now opens the same Voice & Playback sheet, including preview and custom recognition vocabulary. It reuses the session device when present or creates an inert preview device; opening settings does not request microphone access or prepare models.
- Pause uses an icon-only pill matching Mute; VoiceOver retains a descriptive action label. Panel height animates over0.2seconds unless Reduce Motion is enabled; no core state-machine change.
- Conversation preparation previously supplied hardcoded Benjamin Life/Omniharmonic/Prism/Hermes/Parachute independently of the benchmark vocabulary editor. Both now use one persisted list with an empty default. Explicit empty lists remain empty, and changed vocabulary invalidates per-engine preparation on the next capture. This fixes ignored vocabulary removal; it does not guarantee perfect recognition of every word.
- New voice thread creation previously kept the turn ID but not the accepted prompt before its first history read. The destination retains the accepted prompt until matching stored user history appears, without duplicating it or treating it as an unsent retry. Server code persists user messages; no permanent history-loss claim or new persistence layer.

## Verification

Four isolated vocabulary-store regressions passed. Thirty-nine focused thread/voice-entry/submission/handoff tests passed. Integrated iOS Release compilation and DEBUG-hook source safeguard passed. Independent Sol review found no concrete ownership, reconciliation or layout-feedback regression. Final version19 packaging/install is pending.

## Content-free diagnostics

Owner unlocked/connected iPhone; bounded event trace copied to `/private/tmp/omni-v19-audit/iphone-events.json`. It contains no transcripts or audio. No playback/synthesis failure events appear in the retained256-event window. Matched session-start to capture-ready intervals0.251–1.531seconds; matched synthesis0.699–3.851seconds. Two capture-start retries recovered; pauses on empty captures and cancellation events are not evidence of a model failure. Agent send-accepted to reply-completion intervals4.351–93.825seconds, excluding cancelled pairs. The exact initially reported wait cannot be conclusively identified from this bounded trace.

Bounded server outcome inspection found ten recent successful Kokoro deliveries0.502–1.513seconds after the synthetic rollout checks, no synthesis-error records in the inspected tail. Server success establishes audio delivery, not physical rendering. The model runs on the paired Mini, not the iPhone.

## Physical acceptance checklist

1. Open Voice & Playback from main Settings before launching voice; preview Kokoro and Apple without activating microphone capture.
2. Clear recognition vocabulary, start/resume voice and say ordinary phrases including “read me a poem”; confirm custom names are not injected. Repeat after relaunch.
3. Start a new voice thread; confirm submitted transcript precedes the reply and remains visible when reopening history, without duplication.
4. Check Pause/Mute pill balance and listening/transcribing/responding height transitions on phone and iPad, including larger text/Reduce Motion.
5. Confirm a long Kokoro reply, interruption and return to Listening still work. Existing accepted lifecycle is a regression gate.

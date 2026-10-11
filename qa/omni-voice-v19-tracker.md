# Omni19: voice settings, recognition and transcript polish

## Owner feedback and scope

Owner accepts Kokoro speech quality and reports voice generally working perfectly. This pass preserves the accepted capture/playback/interruption lifecycle and addresses five specific issues: main Settings access; compact Pause; custom vocabulary influencing speech after deletion; missing initial transcript; abrupt panel transitions. Physical build19 acceptance remains pending.

## Changes and causes

- Main Settings now opens the same Voice & Playback sheet, including preview and custom recognition vocabulary. It reuses the session device when present or creates an inert preview device; opening settings does not request microphone access or prepare models.
- Pause uses an icon-only pill matching Mute; VoiceOver retains a descriptive action label. Panel height animates over0.2seconds unless Reduce Motion is enabled; no core state-machine change.
- Conversation preparation previously supplied hardcoded Benjamin Life/Omniharmonic/Prism/Hermes/Parachute independently of the benchmark vocabulary editor. Both now use one persisted list with an empty default. Explicit empty lists remain empty, and changed vocabulary invalidates per-engine preparation on the next capture. This fixes ignored vocabulary removal; it does not guarantee perfect recognition of every word.
- New voice thread creation previously kept the turn ID but not the accepted prompt before its first history read. The destination retains the accepted prompt until matching stored user history appears, without duplicating it or treating it as an unsent retry. Server code persists user messages; no permanent history-loss claim or new persistence layer.

## Verification

Four isolated vocabulary-store regressions passed. Thirty-nine focused thread/voice-entry/submission/handoff tests passed. Integrated iOS Release compilation and DEBUG-hook source safeguard passed. Independent Sol review found no concrete ownership, reconciliation or layout-feedback regression. Final version19 packaging and both mobile installs succeeded; physical acceptance is pending. Three offscreen layout smoke tests also passed, but their desktop renderer does not establish actual iOS animation quality or Pause/Mute appearance.

## Content-free diagnostics

Owner unlocked/connected iPhone; bounded event trace copied to `/private/tmp/omni-v19-audit/iphone-events.json`. It contains no transcripts or audio. No playback/synthesis failure events appear in the retained256-event window. Matched session-start to capture-ready intervals0.251–1.531seconds; matched synthesis0.699–3.851seconds. Two capture-start retries recovered; pauses on empty captures and cancellation events are not evidence of a model failure. Agent send-accepted to reply-completion intervals4.351–93.825seconds, excluding cancelled pairs. The exact initially reported wait cannot be conclusively identified from this bounded trace.

Bounded server outcome inspection found ten recent successful Kokoro deliveries0.502–1.513seconds after the synthetic rollout checks, no synthesis-error records in the inspected tail. Server success establishes audio delivery, not physical rendering. The model runs on the paired Mini, not the iPhone.

## Physical acceptance checklist

1. Open Voice & Playback from main Settings before launching voice; preview Kokoro and Apple without activating microphone capture.
2. Clear recognition vocabulary, start/resume voice and say ordinary phrases including “read me a poem”; confirm custom names are not injected. Repeat after relaunch.
3. Start a new voice thread; confirm submitted transcript precedes the reply and remains visible when reopening history, without duplication.
4. Check Pause/Mute pill balance and listening/transcribing/responding height transitions on phone and iPad, including larger text/Reduce Motion.
5. Confirm a long Kokoro reply, interruption and return to Listening still work. Existing accepted lifecycle is a regression gate.

## Release and installation receipts

PR129 merged as `9763a45c9ed505c043c3f62feaa1120ff2327cef`, tagged `omni-client-v2026.10.10-19`. Final signed iOS Release succeeded. Verified version19/identity, strict signature, compiled icons, both device profile IDs, and absence of DEBUG fixture strings. ZIP SHA256 `63cac10381388d3006309961cb6ed74cc5534c21bbfc16ad259bf081f1d8288a`. Owner confirmed both devices clear; both devicectl installs succeeded. Receipts: `/private/tmp/omni-client-v2026.10.10-19/{iphone,ipad}-install.log`. No backend deployment is required for these native fixes.

Mac19 universal Release also succeeded with identity/version and DEBUG-hook checks; unsigned ZIP SHA256 `87f4444210c8d1b41672e2dbbaf1e2f87e4470180b8950303f6ea6ebb69b1031` matched on Mini. Staged under `~/release-artifacts/omni-client-v2026.10.10-19/omni`, with existing18 public provisioning profile and exact release entitlements. Owner signing requested through `~/release-artifacts/sign-omni-v19.sh`; Mac19 signing/notarization/install remain pending.

Separately, Apple accepted Mac18 submission `3db229f4-915b-4ca0-859e-26a020abac3e`. Stapling, validation, strict signature and Gatekeeper all passed. Stapled ZIP SHA256 `761608490e18d2435f3ded9ff4eca5fa3b563e3469c83ad13c0950c62ba194e9` matched after copying to laptop. `/Applications/Omni.app` did not exist; installed the exact verified18 artifact and revalidated signature/ticket. Launched app; native UI showed signed-in threads and a new voice window in Preparing voice state. This proves launch and account access, not microphone/wake acceptance. Mac18 does not contain19's new vocabulary/settings fixes.

## Mac settings follow-up / build20

Owner reports missing Voice & Playback and blank benchmark. Running laptop executable is `/Applications/Omni.app`, build18; native Settings inspection confirms its pre19 menu. On the installed app, opening benchmark reproduces a sheet with title and Done only; AX lists content that is not visibly laid out. An isolated SwiftUI/AppKit measurement gives the unsized NavigationStack/List0×0 versus640×640 with explicit macOS sheet dimensions. Add macOS-only min560×480/ideal640×640 to the benchmark sheet, plus visible build number in Settings on all platforms. Mobile19 remains installed; no inference that the reported symptoms occur on mobile.

Mac19 signature independently verified (Developer ID, secure timestamp, hardened runtime, required production APNs/audio entitlements, no debug). Signed ZIP SHA256 `8fa07e856691a66505791c14bf03d3c23d5528ca86d3743290d733d296f90cf5`, Apple submission `96a6bdd2-5ad4-4ae4-9e29-8fd782197736`. The already-signed19 is immutable; the newly reproduced sizing repair is version20 and requires its own artifact/signature.

## Mac20 signed and submitted

Owner confirms the missing settings/blank benchmark were on Mac; mobile19 looks good. PR131 merged as `baad0f82059a357d85db7ab3dfc146b838d9341d`, tag `omni-client-v2026.10.10-20`. Final universal Mac20 Release passed version/identity, both architectures and DEBUG-fixture exclusion. Unsigned ZIP SHA256 `e4a64b040052f6de151fe6023ee9646b3bf59ff3d7252ee1098457a14f1eb14e` matched on Mini. Actual STTBench rendering with inert data at640×640 visibly showed controls/report; no model preparation or microphone use.

Owner signed20. Independent strict verification confirmed Developer ID team83Y42N33H8, secure timestamp2026-10-11 00:01:11 MDT, hardened runtime, production APNs/audio input and expected keychain/app identifiers without debug entitlement. Signed ZIP SHA256 `b49169cf8027c5466c7224ca6c13109b68c9890dd76c48feeca41d3b42f5c9af`. Uploaded once to Apple as `cb0280f6-5a99-4989-ab27-1061f7caebfc`. Notarization acceptance/stapling/install pending; laptop still18, mobile19. Mac main window inspected before replacement: paused voice session and empty composer; no update performed while Apple approval pending.

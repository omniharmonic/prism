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

35 focused tests passed:21ConversationSpeech,3VoicePanelLayout,11ReplySpeechProvider. Includes catalog loading state and existing service/cancellation guards, plus new classified remote error, local cancellation and privacy boundary checks. Universal Release passed. Real composited synthetic desktop preview verified matching32pt header circles and inset action capsule; caught and repaired Menu-specific suppression of direct glassEffect before release. Preview was ready-state, not live microphone capture; active controls also covered by3layout tests. Real cough/ambient speech discrimination and exact prior synthesis failure root cause remain unresolved; improved diagnostics apply future events only.

## Release staging

PR137 merged as `ec4581536da7d6a372e12917a8cdc9387f202bbb`, tagged `omni-client-v2026.10.11-22`. Final tagged universal Release passed, version22/identity/architecture/DEBUG exclusion verified. Unsigned ZIP SHA256 `4a925b84295dccfb30f9d8f51b6d677e68db648c9ef954233b0ebba11b6bb758` matched on Mini. Stage `~/release-artifacts/omni-client-v2026.10.11-22/omni`; exact public profile/release entitlements carried from21. Signing helper `~/release-artifacts/sign-omni-v22.sh` syntax, app path, entitlement path and plist verified. Owner signing requested; notarization/install pending. Laptop remains21, mobile19.

## Mobile blank-settings report and build22 installation

Owner reports main Settings → Voice & Playback opens blank on iOS. Verified connected iPad was still build19; that tag has separate Bool/optional presentation state. Atomic item-driven repair already shipped in Mac21/shared22 but had not reached mobile. This is an omitted mobile rollout of a shared fix, not evidence Mac22 styling broke iOS.

Owner confirmed both devices connected and clear. Signed iOS22 Release passed bundle/version, strict signature, both device provisioning IDs and DEBUG fixture exclusion. ZIP SHA256 `82e5b9f9bdd7f6b7cbdebb4212b13484c2c65258141f2b5313855c15fabbaa75`. Both devicectl installs succeeded; fresh inventory confirms22 on iPhone and iPad. Receipts `/private/tmp/omni-client-v2026.10.11-22/{iphone,ipad}-install.log`. Owner confirms first-opening settings works on both physical devices. Dedicated first-open/reopen simulator regression passed on iPhone and iPad (one test each, zero failures). Mac22 remains staged for signing, laptop21.

## Mac22 notarized and installed

Owner initially reran an older signing helper; exact22 signature check stopped before upload. Corrected owner signing verified Developer ID team83Y42N33H8, timestamp2026-10-11 00:40:09 MDT, hardened runtime and production APNs/audio/keychain entitlements without debug. Signed ZIP SHA256 `2222991815ddcfb5a4f8e91ef1b7b0be372dfe56ceb7c1d929f7f9d7fa7f20da`. Apple accepted submission `47549517-f5b7-4bdd-9e80-30bd576bfe2f`. Stapling/ticket/Gatekeeper passed. Stapled ZIP SHA256 `24ce17bfc7f60bfef8d6e3b88d518f6ce6a959bdbadb9131e9b6b23fac74a14e` matched on laptop.

Inspected idle app with no voice panel and empty composer, quit, preserved21 at `~/release-artifacts/installed-backups/20261011-omni-v21/Omni.app`, installed exact verified22. Fresh launch signed in; Settings footer22, first Voice & Playback showed vocabulary/provider controls and Kokoro Heart ready. No live recording or test message sent. All three owner devices now22; live Mac speech/cough acceptance remains open.

Automated regression `testVoicePlaybackSettingsFirstOpeningAndReopeningShowsControls` checks first title/vocabulary/provider content, scoped sheet Done, then repeats. iPhone41.232s, iPad72.394s; logs `/private/tmp/omni-settings-regression-dd/logs/{iphone-light-default,ipad-light-portrait}.log`. Isolated fixture stopped afterward; no microphone, real agent messages or production writes.

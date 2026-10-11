# Omni18: hosted Kokoro and notification icons

Owner accepted build17 iOS voice behavior and closed the reported session/playback troubleshooting. Owner prefers retained Kokoro af_heart audition over Hermes Microsoft TTS and requests implementation. Preserve the accepted session state machine.

## Implementation

- Optional registered `kokoro-local` provider, paired-server synthesis with explicit disclosure,160 UTF16-character chunks, fixed af_heart,24kHz PCM16 WAV. Existing authentication/CSRF/scoped cancellation remain. Apple fallback only; saved explicit Apple/Edge choices preserved. New installs default Kokoro.
- Separate offline Mac Swift worker using pinned FluidAudio0.17.7 and verified public assets. Supervisor bounds request/output/time, serializes inference, terminates cancelled requests, backs off after crashes, and releases an idle process. No text/audio logs or public cache.
- Launcher verifies all57 pinned original assets before every process start. Runtime archive SHA256 `d88d6db784ab20c966a325b795498c0f0face9e3bac84ed66a07c0e213cef46f`,194,851,422bytes. Worker SHA256 `fcff7bc2c6215f971ae769b9f4682cbf9aafdf720321a4c6712cbb91f31d8e27`.
- Native WAV transport has provider-specific MIME/text/byte limits and uses existing bounded audio decoder/playback. No iOS Core ML inference (SDK documents uncatchable OS failures).
- Explicit iPhone/iPad20pt notification assets replace1024-only iOS catalog mapping; original logo retained. Standalone actool confirms40px/60px phone and20px/40px pad renditions. Owner confirms prior generic placeholders on both devices despite correct Home Screen icon. Physical next-build notification verification remains required.

## Evidence

- Laptop worker:10 synthetic passages/11 valid nonsilent WAV chunks; cold ready20.57s; render99–891ms; sampled peakRSS1.12GB; empty/oversized requests rejected; stderr0bytes; normal EOF exit. SDK original-file comparison found only intended cache seam. System-only linked libraries.
- Focused native Core/UI/provider/decoder tests38passed, then strengthened transport6passed. Includes real WAV/MP3 decoder and cancellation fixture; no synthetic Keychain tests.
- Server focused33tests passed, including auth/CSRF/cancellation/outcome smoke and worker crash/timeout/oversize handling. Workspace typecheck passed. Asset+launcher6tests passed.
- Mini isolated staged runtime verified all57 assets with zero new downloads.15-minute synthetic host soak in progress; no provider activation yet. MiniMac16,10/16GiB/macOS26.5.2 is within SDK's known Mac BNNS advisory; owner offers macOS update at safe pause point. Do not claim productionKokoro or all-device acceptance from laptop tests.

## Remaining gates

Finish Mini soak and stop test worker before owner updates macOS; recheck host after update. Merge/tag, deploy through existing runbook, configure backed-up paths, activate/health/syntheticAPIcheck, then install matching mobile release with owner readiness. Physical Kokoro long reply/interruption and notification-icon test on both devices. Mac17notarization remainsInProgress at latestcheck; no false Mac installation/wake acceptance. [Host runbook](../docs/runbook/omni-kokoro-host.md).

## Release receipts

PR125 merged as `e98c1de8`, tagged `omni-client-v2026.10.10-18` and `prism-v2026.10.10-16`. Server16 is not yet deployed; read-only deployment preflight passed with live/vault health200 and no failing-source baseline.

iOS18 Release succeeded; strict signature, identity/version, DEBUG-hook exclusions and compiled20pt phone/iPad icon renditions verified on the actual signed artifact. ZIP SHA256 `ee0a2573da84b9e5e6ccc1cab861b3c2bacf96d1f72f745dd35e3522615cb6a5`. Owner approved installation; both device installs succeeded. Existing speech choice is preserved.

The owner initially still saw generic placeholders on fresh notifications from18; tapping opened the correct native app. After an iPhone restart, a fresh notification displayed the correct logo. **iPhone notification icon accepted; iPad restart/retest pending.** Additional icon sizes alone did not resolve the physical issue. Apple acknowledges delayed notification-icon refresh after updates and recommends restart as a diagnostic: https://developer.apple.com/forums/thread/775787 . Do not infer a guaranteed general cache fix or uninstall/reset devices.

Mac18 universal Release passed identity, permissions and DEBUG-hook exclusions. Unsigned ZIP SHA256 `b245078c87a1c3445b39cd50fcd89cb4a8a7d65968a647ca8ca1399b874edaec`. The public Developer ID provisioning profile was restored from verified13 (17's artifact lacked it); it matches team/application, production APNs and expires2044-10-05. Owner signed18; strict signature/hardened runtime/secure timestamp and required entitlements/no get-task-allow verified. Signed ZIP SHA256 `0a7ba21ad00ef1d291dc55756575a42de608cb9d87332fc13638967938c393af`. Apple submission `3db229f4-915b-4ca0-859e-26a020abac3e` uploaded once; acceptance/stapling/installation remain pending. No duplicate upload.

Mini Software Update offers Tahoe26.7.1 and major27.0.1; prefer the offered26.x update for this pass and recheck host reliability afterward. No OS update has been performed by the agent.

## Mini soak completed; OS update pause

The isolated Mini worker passed171 synthetic requests over919seconds, including a full15-minute active test, exited0, and is confirmed stopped. Cold readiness14,322ms; `getrusage` child peakRSS694,501,376bytes. All responses were bounded valid nonsilent24kHz PCM WAV. No private text/microphone/agent traffic, production activation or OS mutation occurred. Receipt preserved in `tools/voice-evaluation/kokoro-worker/mini-soak-summary-20261010.json`. Owner offered a macOS update and has been asked to install Tahoe26.7.1 at this clean pause point; await signed-in readiness before rechecking services and enabling server16/Kokoro.

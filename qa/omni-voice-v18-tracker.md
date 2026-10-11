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

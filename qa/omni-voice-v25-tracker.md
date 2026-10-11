# Omni build25: post-wake polish

## Scope and owner decisions

Build24 wake is owner-accepted over headphones: closed-window activation and repeated wake both work. Preserve that implementation.

- Add playback-only Quick/Sustained interruption responsiveness. Owner chose Sustained; apply on the installed owner devices after release. Default remains Quick for other installations.
- Add per-device notification choice: generic, thread title, or thread title plus short reply preview. Owner explicitly chose title plus preview with lock-screen disclosure. Other registrations stay generic.
- Give the Mac Replied toolbar label breathing room and center Send/Stop beside the composer; preserve iOS 44pt targets and Return-to-send.

## Verification

- Interruption policy plus continuity, endpoint, mute, and callback regressions: 25 tests passed. Real pinned FluidAudio timestamps advance 4096/16000 seconds per frame.
- Composer Return tests: 4 passed.
- Actual SwiftUI off-screen renders: 320/600pt composer, single/multiline; 760/1040pt ThreadView toolbar. Text and controls fit. Native glass still needs installed-app inspection.
- Server payload/privacy/device-scope checks: 75 targeted tests passed; server typecheck passed. OmniCore: 239 passed; OmniClient: 28 passed. Three serialized registration concurrency tests passed, including delayed response, failed save, and disable with late callback.
- Repository `npm run check` passed. Full isolated server suite: 3,025 passed, zero failures, one heavy-test skip. Universal Mac and signed iOS Release builds passed; DEBUG fixture exclusion and mobile strict signature passed. Merged/tagged rebuild, Mac signing/notarization, and installations remain pending.

## Acceptance remaining

Confirm title/preview on a fresh completion notification and its thread deep link. Select Sustained and exercise intentional interruption; sustained noise can still pass the detector, so this is not a noise classifier. Check actual native glass padding and composer alignment. Do not call these hardware checks complete from unit tests.

## Rollout evidence

PR152 merged at `c47b9421ef3cdfd94194f729985ef662f697aed8`, tagged `omni-client-v2026.10.11-25` and `prism-v2026.10.11-6`. Both exact tagged release builds passed. Owner cleared mobile devices; fresh devicectl inventories confirm build25 on iPhone and iPad. Receipts: `/private/tmp/omni-client-v2026.10.11-25/{iphone,ipad}-install.log`.

Server6 deployed via dry-run then approved deploy.sh apply with backup, vault/process health, no newly failing ingest sources and desktop-independence checks passing. Matrix was already failing at baseline. Receipt `/Users/benjaminlife/deploy-state/prism-20261011T170134Z.log` on Mini. No vault content edits.

Mac25 owner signed; strict signature and hardened-runtime identity verified. Apple Accepted `56790555-71af-4c3a-8d6f-571dea1de84e`; stapler and Gatekeeper passed. SHA256:
- Unsigned ZIP: `a2cfd444e11704907dc8a6544701e2be3a39f09ceac7a8f03c2d0938f7226b05`
- Signed ZIP: `e2ce06147b2425aacc2976a2d3dd424694ca17b91c9357a00cbd2a4586414c81`
- Stapled ZIP: `ee8266162bd09f0131cdfb552a95f1984c443af456d19c2d0d7625ffec4651f6`

Installed `/Applications/Omni.app` build25; rollback24 preserved at `~/release-artifacts/installed-backups/20261011-omni-v24/Omni.app`. Actual signed UI confirms build25, signed-in server, Kokoro Heart ready, wake listening locally, Sustained selected, full Replied with padded native glass and aligned Send. Mac notification title+preview preference is saved. macOS Notifications had Omni disabled; enabling it in System Settings resolved the pending request and Omni now confirms Notifications are on. Real delivery remains under test. Mobile per-device preferences and real notification acceptance remain to be set/verified.

## Newly observed build24 crash

`Omni-2026-10-11-110407.ips` records build24 PID72827, launched10:45:35, crashing11:03:56 (EXC_BAD_ACCESS/0x220). Actual replacement began11:04:53, so the bundle copy did not cause this crash. Disassembly of the exact24 binary locates the failure in compiler-emitted MainActor executor checking at the start of Composer's HStack content closure, before draft reads or control construction. Unlike build23's background-queue assertion, the invalid executor pointer origin is unknown. No speculative code repair is claimed. Preserve the report and investigate if a fresh build25 process reproduces it.

### Final installed Mac checks

Normal quit and fresh launch of25 succeeded without a new crash report. After relaunch, Settings still shows Notifications are on with title+preview, wake Listening locally, and Voice & Playback still shows Sustained. Kokoro Heart reports ready after catalog refresh. A harmless no-tools notification test chat returned the expected reply in the installed app; system banner contents were not independently observed. The mobile notification and responsiveness choices are per-device; owner was given the exact Settings paths to select them. No acoustic or notification-delivery acceptance is inferred from this text test.

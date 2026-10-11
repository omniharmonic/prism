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
- Release builds, merged/tagged source, signature/notarization, installations: pending.

## Acceptance remaining

Confirm title/preview on a fresh completion notification and its thread deep link. Select Sustained and exercise intentional interruption; sustained noise can still pass the detector, so this is not a noise classifier. Check actual native glass padding and composer alignment. Do not call these hardware checks complete from unit tests.

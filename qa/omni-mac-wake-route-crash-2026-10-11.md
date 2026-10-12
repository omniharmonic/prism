# Omni Mac wake-listener route-change crash

## Evidence

Installed build25, UUID `cbcc782d-7085-3d8d-8910-dc644a88ed98`, crashed on the main thread at 22:12:27 and 22:35:30 MDT on October11. Both reports end in Swift concurrency executor checking inside TodayView’s List builder. Disassembly shows the check precedes Today model reads; changing that view would address the detector rather than the original failure.

Filtered macOS unified logs identify earlier AVAudioEngine Objective-C exceptions in the same processes:

- PID96418:21:38:41 hardware48000Hz versus client44100Hz, configuration change pending;21:38:46 hardware24000Hz versus client44100Hz, failed tap creation.
- PID53730:22:21:38 input-device disappearance/change;22:21:40 hardware44100Hz versus client24000Hz, failed tap creation. Exception stack enters `MacWakeListener.start` from its authorization/reconcile task.

The wake listener reuses one AVAudioEngine and supplies its cached output format when reinstalling its input tap. The device can have changed while that engine still reports the old format. Swift `do/catch` does not catch Objective-C exceptions from installTap. The resulting delayed executor failure is consistent with [Swift runtime maintainer guidance](https://github.com/swiftlang/swift/issues/89197). Both crash reports also contain the maintainer’s diagnostic breadcrumb, `SOME_OTHER_THREAD_SWALLOWED_AT_LEAST_ONE_EXCEPTION`, on a background thread. This identifies the observed initiating exception; the exact runtime corruption mechanism has not been reproduced in isolation here.

Apple documents that a non-nil [tap format](https://developer.apple.com/documentation/avfaudio/avaudionode/installtap(onbus:buffersize:format:block:)) applies that format to the bus. Recovery must avoid stale formats and rebuild audio state across device changes.

## Verification and release status

The repair creates a fresh engine for every wake-recognition cycle, follows the native tap format, and rejects queued configuration notifications from retired engines. A narrowly scoped Objective-C boundary converts tap/prepare/start exceptions into recoverable errors before they can unwind through Swift concurrency; recovery still uses the existing bounded policy. No Today or composer refactor is needed.

Regression tests cover engine replacement, stale configuration tokens, native tap format, synthetic tap/prepare exceptions, preserved normal startup errors and a successful retry. The final patch passes 10 focused Debug tests, universal arm64/x86_64 Mac Release compilation and iOS Release compilation. Release source checks pass; the actual Mac executable contains neither UI-test launch markers nor synthetic audio test classes. The same 10 focused tests also pass with Release optimization. No replacement app has been installed. Hardware acceptance must include changing/disconnecting the input route with wake listening active, then waking again; ordinary wake activation alone does not cover this failure.

## Build26 packaging — October12

PR158 merged at `60fa2cbab40ec3fce7d0538a5ffa9fb58670ff32`, tagged `omni-client-v2026.10.12-26`. Both exact-tag Release builds succeeded: universal Mac arm64/x86_64 and development-signed iOS. Mobile strict signature passed; both Info.plists report26. Source release checks passed, and the actual Mac executable excludes UI-test markers and synthetic audio helpers.

Unsigned Mac ZIP SHA256 `e5e717b16abfb68588bb98e9f697fcc6f7e93dc75e1927c721a4d0232738875b`, matched after transfer to `~/release-artifacts/omni-client-v2026.10.12-26/omni` on the Mini. Signing helper `~/release-artifacts/sign-omni-v26.sh` verifies the build number and strict signature. Owner signing and app-idle confirmation requested; notarization and installation pending. No production backend restart is part of this native release.

### Installed and verified

Owner cleared laptop/iPhone/iPad and signed Mac26. Both mobile installation receipts and fresh device inventories confirm build26. The first notarized Mac package omitted `embedded.provisionprofile`: AMFI rejected launch (-413, no matching profile), despite successful Gatekeeper/notarization checks. Working Mac25 was restored temporarily. No security protections were disabled.

A fresh unsigned packaging revision included the existing matching Developer ID profile (expiry2044-10-05), then the owner signed again. Apple Accepted submission `b60f37a3-bf61-45fc-9859-a2d9b6dd981e`; staple/strict signature/Gatekeeper passed. Final ZIP SHA256 `7ea73a0e45827aa12e558bcec6fe39237e23a21ba1e3852ca5a5d17916fc6c98`, matched on Mini/laptop. Complete Mini artifact: `~/release-artifacts/omni-client-v2026.10.12-26-profile/omni`. Laptop `/Applications/Omni.app` now26; rollback25: `~/release-artifacts/installed-backups/20261012-omni-v25/Omni.app`.

Actual laptop launch succeeds and loads signed-in Today data. Settings shows build26, wake Listening locally (experimental), Notifications are on, and title plus short preview preserved. iPhone/iPad installation is verified; acoustic route-switch/disconnect recovery remains a hardware acceptance check, not inferred from installation. The signing runbook now explicitly requires the push provisioning profile before signing.

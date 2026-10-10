# Sign laptop-built Mac apps on the Mini

The laptop builds release apps from a merged, tagged source commit. The Mini keeps
its existing Developer ID private key and App Store Connect API key. Neither key
is exported. This runbook moves a packaged app artifact, not a source checkout;
server and agent code still move exclusively through tagged `deploy.sh` releases.

## Prerequisites

- Read `HANDOFF-LAPTOP.md` section 2 in the agent repository.
- Record the source tag, source commit, and unsigned artifact SHA-256.
- Build on the laptop in Release. Run the native bundle checks and app tests.
- Check the Mini's existing identity with `security find-identity -v -p codesigning`.
  Use **Developer ID Application**, not Apple Development or Distribution.
- Verify the existing notary credential using `xcrun notarytool history --key
  "$HOME/.appstoreconnect/private_keys/AuthKey_AB84HRLBUA.p8" --key-id AB84HRLBUA
  --issuer 7c2856fc-0bdf-4d41-b95d-a2ffab2ba726`. Never print or export the key.

Apple requires a secure timestamp, hardened runtime, and no `get-task-allow=true`.
See [Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Do not weaken Gatekeeper, Keychain permissions, or hardened-runtime protections.
If codesign requires a Keychain prompt, the owner approves it on the Mini.

## Stage and sign

1. Package the laptop's `.app` with `ditto -c -k --sequesterRsrc --keepParent`.
   Use a private local staging directory. Record `shasum -a 256` of the zip.
2. Create a unique `~/release-artifacts/<source-tag>/<app-name>/` on the Mini,
   mode 0700. Transfer the zip over the established Tailscale SSH host and compare
   SHA-256 before extraction. Do not overwrite a prior release directory.
3. Extract with `ditto -x -k` in that staging directory. Inspect bundle identifier,
   version, entitlements, and nested executable inventory before signing. The
   simple Prism Client bundle should contain one main executable. If a bundle has
   additional frameworks/helpers, sign each nested code item from the inside out
   with its appropriate entitlements before signing the enclosing app.
4. Sign the app with `codesign --force --timestamp --options runtime --sign
   'Developer ID Application: BENJAMIN GLEASON ROSS (83Y42N33H8)' '<app>.app'`.
   Preserve only required release entitlements. Never carry Debug
   `com.apple.security.get-task-allow` into this signature.
5. Run `codesign --verify --deep --strict --verbose=2 '<app>.app'` and inspect
   `codesign -dv --verbose=4` plus `codesign -d --entitlements -`.

## Notarize and install

1. Zip the signed app with `ditto` as above. Submit with `xcrun notarytool submit
   '<signed>.zip' --key "$HOME/.appstoreconnect/private_keys/AuthKey_AB84HRLBUA.p8"
   --key-id AB84HRLBUA --issuer 7c2856fc-0bdf-4d41-b95d-a2ffab2ba726
   --output-format json`. Record the submission ID. Poll `notarytool info` with
   the same key arguments; inspect `notarytool log` if rejected. A submission ID
   alone is not success.
2. After **Accepted**, run `xcrun stapler staple '<app>.app'`,
   `xcrun stapler validate '<app>.app'`, and
   `spctl --assess --type execute --verbose=2 '<app>.app'`.
3. Repackage the stapled app, record its SHA-256, and copy that artifact back to
   the laptop. Verify its checksum, signature, and stapled ticket there too.
4. Before replacing an installed copy, verify the app has no unsaved draft and
   close only that application's process. Preserve the previous `.app` in a
   dated private backup. Install the exact verified artifact into Applications
   on each requested Mac. Do not alter preferences, device credentials, or vault
   data, and do not restart any production backend as part of an app install.
5. Launch the installed app and verify sign-in, opening a note, navigation, and
   server connectivity. Owner approves any normal Keychain prompt. Do not claim
   these interactive checks from build or signature success alone.

Rollback restores the backed-up application bundle and leaves server/vault data
unchanged. Keep both the old bundle and release evidence until device acceptance.
No TestFlight upload is part of this workflow; it still requires owner parity
sign-off under the existing device-pass runbook.

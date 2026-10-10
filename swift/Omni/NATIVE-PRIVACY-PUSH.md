# Native push and local privacy lock

Notifications stay off until Settings → Enable Notifications. Permission is requested
only from that action. Reconnect uses existing permission and the current native session;
it never prompts on launch. Payloads contain generic wording and ids, never thread text.
Turning notifications off removes the server registration before clearing local opt-in;
sign-out revokes the device credential and its registration. Notification taps and
`omni://thread/<id>` links navigate after sign-in and after an enabled lock is opened;
approval links open Needs you. No link approves or sends an action.

Settings → Require Unlock first authenticates the device owner. An enabled lock begins
closed on launch, covers inactive screens, and locks on background. Unlock and disabling
the lock require LocalAuthentication's device-owner policy (biometrics or passcode/password).
Cancellation leaves the lock closed. This is a screen privacy feature; it does not encrypt
server content or replace sign-in and send confirmation.

## Signing gates before delivery

The build adds SDK-specific entitlements. `APS_ENVIRONMENT=development` supports ordinary
Apple Development signing, including Release-config development builds. Distribution
exports may rewrite the signed value; runtime reads the executable's actual signed
entitlement, never DEBUG/Release. Unsigned simulator builds cannot register with APNs.
The entitlement parser accepts signed thin 64-bit executables and universal Mac slices;
missing or malformed entitlements fail closed.

- iOS debug: enable Push Notifications for `com.benjaminlife.omni`, use an Apple
  Development provisioning profile for the connected devices, and verify the embedded
  profile's `Entitlements.aps-environment` is `development`. Inspect the actual signed
  app using `codesign -d --entitlements - Omni.app`; its `aps-environment` must agree.
- Mac delivery: build with `APS_ENVIRONMENT=production`, create a Developer ID
  provisioning profile for the Omni App ID with Push Notifications, embed it in the app,
  and preserve `com.apple.developer.aps-environment=production` when signing on the Mini.
  Verify both the profile and final signature before notarization. Do not replace
  entitlements with an empty dictionary during re-signing. The profile and certificates
  are private release artifacts and must not be committed.
- After signing, use Settings to opt in on each physical device, confirm its application
  and APNs environment in the server's registration row (do not print the token), then
  send a generic, content-free test update and check navigation while unlocked and locked.

The local APNs tests fake all transport; build success alone does not prove Apple delivery.
Biometric/passcode UI and real notification delivery need the signed physical apps.

# Prism onboarding and distribution — proposed first release

The first-time experience should ask where the knowledge lives, create an owner, and pair devices. It should not require Xcode, Terminal, API route knowledge, copying tokens, or editing Keychain access lists.

## Product flow

1. Install Prism from the iPhone/iPad App Store or the signed Mac download. Choose “Join a workspace” or “Create my workspace.” Joining uses an expiring invitation that names the server, vault and offered role before acceptance.
2. For a new workspace, choose a host: “This Mac,” “Another computer,” or “Existing server.” The Mac host setup is a separate signed and notarized Prism Server application. On an iPhone, display a short setup link/QR to open on the intended host. Do not imply the phone can silently install software on another machine.
3. The host app bundles supported runtimes and database/service dependencies, chooses a data folder, creates its local owner identity, and checks restart/recovery before displaying “Ready.” It records install and data locations, can stop/start the service, and offers an explicit uninstall that preserves data by default.
4. Pair the phone by scanning a one-use, short-lived invitation. The phone displays the host name and identity; the host confirms the device. Use the existing device credential model with least privilege, revocation and no permanent bearer token in the QR or URLs.
5. Create a private vault or a collaborative vault. Explain owner versus vault administrator in ordinary language. Invite people only after showing exactly which vault and role they receive. Each person gets separate credentials; never share the owner's agent identity.
6. Offer “Add Omni” as an optional host component. Explain model account/cost, which vaults the agent can access, local speech model download size, and exact outbound approval. Configure one provider through an authenticated setup flow. Default to a short internal trial before connecting email/calendar/Matrix. Each integration connects the person's account and verifies read access without sending a message.
7. Finish with a real acceptance checklist performed by the installer: create a private starter page, sync to a paired device, verify backup location, and run an internal agent check if selected. A user-initiated notification test can verify device permissions. No outward message, invitation or post is used as a hidden test.

## Packaging decision

Keep the client and server-host responsibilities separate. Apple requires App Store apps to stay within their container and restricts downloading executable code that changes app functionality; a full agent/server installer should not be assumed eligible as an embedded iOS or sandboxed Mac App Store installer. Apple separately supports direct Developer ID-signed and notarized Mac software. This is a proposed architecture based on the platform constraints, not a promise of App Review acceptance.

Sources: [App Review Guidelines, 2.5.2](https://developer.apple.com/app-store/review/guidelines/), [Distributing software on macOS](https://developer.apple.com/macos/distribution/), [Preparing your app for distribution](https://developer.apple.com/documentation/Xcode/preparing-your-app-for-distribution).

Initial supported host should be macOS Apple silicon, matching the environment we can test. Linux can follow with a versioned package/container and equivalent health/update/backup contract. “Any machine” must become a tested support matrix, not a label hiding Python/Homebrew/Keychain instructions. Windows should be a deliberate subsequent support decision.

## Work required before public distribution

- Bundle and license-review pinned runtime dependencies; no reliance on a developer checkout, globally installed CLIs or an existing SSH setup.
- Replace owner-specific paths, email, API keys, hostname and team assumptions with installation identity and account setup. Scan release bundles for development configuration and secrets.
- Provide secure remote access with a clear supported option. Existing Tailscale deployment is acceptable for Benjamin's setup; public onboarding must not silently expose an unauthenticated port or require every collaborator to administer a private network.
- Implement resumable setup, idempotent migrations, signed updates, backup before upgrade, health-based rollback and diagnostic export with redaction.
- Exercise owner/admin/member/viewer on two vaults and two users, including invitation expiry/revocation, switching, offline caches, files/search/graph/realtime, and agent access boundaries. Include a negative test in every path: another vault's content must not become visible through an identifier collision.
- New per-user Omni support is a separate feature: the current owner-only server agent must not be exposed to workspace members merely because collaborative Prism is enabled.
- Complete physical iPhone/iPad/Mac acceptance, accessible contrast/reduced motion, notification cold launch, source links, voice interruption, and reconnect behavior. Validate App Store privacy disclosures and review account/demo setup.
- Maintain separate distribution states: development-device installation, TestFlight beta, App Store submission, and notarized direct Mac release. Success in one does not imply the others.

This document designs the follow-on. No installer or App Store submission has been created in this pass.

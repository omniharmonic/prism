# Production rollout — 2026-10-10

Checkpoint at 06:45 UTC; this is a progress record, not final acceptance.

## Verified production

- Mini Prism: `prism-v2026.10.10-2`, commit `7500b293`; deployed through the tagged dry-run/apply workflow. Process, vault reachability, ingest health and desktop independence passed.
- Backup: `~/parachute-backups/20261010T064101Z-pre-deploy-prism-v2026.10.10-2`; deployment log: `~/deploy-state/prism-20261010T064100Z.log`.
- Mini agent: `agent-v2026.10.10-1`, commit `266e338`. Narrow code-only deployment passed Mini policy, bridge and generator checks. Hermes restarted and passed its 53-tool self-test.
- Actual Hermes calendar read succeeded after the narrowly scoped Keychain sandbox repair. Google authorization was already valid; no reconnect was required. No OAuth token bytes were inspected.
- Separate Telegram and Buzz services remain in place. No outward test message or email was sent.

## Client artifacts

Source tag `prism-client-v2026.10.10-1` points to `038c0311` (Apple polish, live project sections and Mac signing runbook). Later server-only migrations do not change the client artifact.

- Mac release built and passed native bundle verification. Unsigned zip SHA-256: `fca75c66d94ffe106e21205d0d7982157c947fbc26bc0b3c0570e345e918b78d`.
- Staged on Mini: `~/release-artifacts/prism-client-v2026.10.10-1/prism-client/Prism Client.app`. Signing over SSH returned `errSecInternalComponent`; the owner has the exact GUI Terminal signing command. Existing keys remain on the Mini. Notarization and installation are still pending.
- iOS IPA built, signature verified, iPhone installed. The phone was locked when launch was attempted; workspace verification remains pending.
- The profile includes the iPhone but not the iPad. Automatic iPad provisioning found no signed-in Xcode account. Owner sign-in is required before rebuilding/exporting and installing.

## Reviewed vault preview

`m-project-repair` preview against 15,206 live notes plans 12 writes: ten missing PROJECT pages, one preserved Herd of God background page, and its PROJECT body cleanup. No deletion is in this pass. No writes have been applied. Explicit owner approval is pending after automatic approval review required a separate yes.

PR58 prevents apply from discovering unpreviewed merges after creating canonical pages. Any newly eligible duplicates require a second preview before approval/application. Use the Mini's `apply-all.sh`, verified backup and undo log; never write the live vault from the laptop.

## Still being implemented or verified

- Omni adaptive UI matrix and release guards (PR57), native push and app lock, M3 nudges, and the V0 voice comparison kit.
- Final integrated suites and final tagged deployment after those changes land.
- Developer ID signing/notarization, both Mac installations, and iPhone/iPad app checks.
- Proton sender activation remains off until the email-only executor allowlist is deployed. Keep Prism `ACTIONS_EMAIL_ENABLED=false`; the selected `proton-send` executor has its own gate. A real self-send requires approval of its exact draft.

## Owner and elapsed-time acceptance

- `qa/device-pass-script.md` parity sign-off before TestFlight.
- Owner voice recordings and comparison sign-off; implementation alone does not establish recognition quality.
- One-week nudge comparison and link-health observation before the planned follow-on flags. Do not accelerate those gates or remove Telegram fallback.
- Owner narrows the Claude connector from admin to write scope; account sign-in is pending.

Eighteen merged, clean, inactive laptop worktrees were removed after dependency checks. Active branches, local data, environment files and build caches were retained.

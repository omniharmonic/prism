# Prism Apple surface polish

A small presentation pass over the existing shared UI; no editor, data, server, or authentication refactor.

- Inset phone navigation with restrained translucent material and solid fallback. Existing keyboard hiding, safe-area layout, and 44px targets remain.
- Quieter formatting controls, softer shared button corners, and consistent rounded action/confirmation sheets.
- Reduced blank space before document titles, with cover alignment adjusted to match.
- Neutral light sidebar; all reading/content canvases remain white and opaque. Dark mode keeps existing accessible text and action colors.
- System UI font on new installations; saved font choices are preserved and still apply immediately.
- Reduced transparency and motion respected.

Design reference: https://developer.apple.com/design/human-interface-guidelines/materials

Validation: server suite 2,888 passed, 0 failed, 1 skipped; mobile navigation 7 passed. Required npm run check, native web bundle build, and verify:native passed. Full Chromium fixture run: 2,562 passed, 7 failed, 1 interrupted, 13 intentionally skipped. After restoring the white content canvas, all 7 failures passed on a focused rerun; the interrupted serial test also passed (2,570 passing cases across the run and reruns). The connection-reset and sidebar-expansion failures did not reproduce. Focused WebKit navigation/control checks: 11 passed. Coordinator inspected phone (390x844), tablet (834x1194/1024x768), and desktop (1440x900), including light/dark and the More sheet. These are fixture browser checks, not physical-device certification.

Production update (2026-10-10): PR53 and the live project sections in PR55 are merged. The Mini serves `prism-v2026.10.10-2` (`7500b293`), including the guarded project migration tooling. Tagged deploy backup, process, vault reachability, ingest, and desktop-independence checks passed. Migration tooling deployment does not mean vault migrations have been applied; the reviewed first pass remains pending explicit owner approval.

Client source is tagged `prism-client-v2026.10.10-1` (`038c0311`). The Mac release build and native verification passed; its artifact is staged on the Mini awaiting Developer ID signing through the owner's normal Keychain prompt. The iOS build passed signature validation and was installed on the iPhone. First launch awaits an unlocked phone. The iPad needs registration and an updated development profile; Xcode account sign-in is pending. No TestFlight release or physical-device acceptance is claimed.

The original local-only/push-blocked status is superseded: Benjamin authorized pushes and production rollout. See `qa/production-rollout-2026-10-10.md` for release evidence and remaining acceptance steps.

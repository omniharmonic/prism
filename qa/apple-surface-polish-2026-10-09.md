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

Production is unchanged. A release requires the approved tagged deploy process and rebuilt native clients.

Branch: `polish/apple-surfaces` in `~/dev/prism-apple-polish`. Four implementation commits are saved locally. GitHub push was blocked by automatic approval review, which requires explicit permission under the handoff’s outward-action rule. No production, live-vault, Omni, or device installation changes were made.

# Messaging frontend verification — 2026-10-02

Implementation: `dfb60f4` on `feat/messages-polish`.

All images in this directory are isolated **fictional fixtures**. Names, addresses, conversations, and room IDs were authored for testing. No live user data or credentials appear here.

- Chromium: 25 messages/inbox journeys passed.
- WebKit: the same 25 journeys passed.
- Web application TypeScript check passed.
- Captured and inspected desktop 1440 × 960, phone 390 × 844, and narrow phone 320 × 844 in light/dark themes. Screenshot animation is disabled to capture settled theme colors.
- Covered desktop list/detail and Open as page; phone Back retaining filters, list scroll and scoped draft; account switch clearing selection; fresh detail read failure/recovery; keyboard navigation and long title; sender/newline rendering; incoming/prepend scroll preservation; failed/lost acknowledgement draft and retry identity; read-only email and missing legacy sending account.

The Chromium images cover all six viewport/theme combinations. The three selected WebKit images retain representative desktop/light, phone/light and narrow-phone/dark evidence. The full fixture runs generated all six combinations in each engine.

This is fixture-browser verification, not deployed production or installed-native acceptance. Native keyboard/IME and live owner journeys remain separate release gates. Canonical identity popovers, server-paginated summaries/archive reads, rich relations/media, agent reply drafting, automatic Reply all, and attachment send controls are not demonstrated by these images.

## Reproduce

Run `inbox.spec.ts` and `messages.spec.ts` with the project's fixture Playwright config. These tests use mocked vault/action clients, not production services. The run in this branch used an ignored config on port 5192, with a second project using Playwright's Desktop Safari/WebKit profile.

# C10 composer growth — 2026-10-02

Source checkpoint: `2e91fb2`, branch `feat/composer-growth`, based on `284ddbf`.

The existing MessageComposer textarea now grows from 44 px to its existing 160 px cap, then scrolls internally. It shrinks after deletion or confirmed send. The same DOM node, controlled scoped draft, caret and focus survive width changes. Measurement responds to text and width without a ResizeObserver height feedback loop. No send, receipt, reply-draft, IME or permission handler changed.

Verification: **46 Chromium and 46 WebKit checks passed**, comprising `composer-growth.spec.ts`, `messages.spec.ts`, `agent-reply.spec.ts`, and `email-collaboration.spec.ts`. Aggregate fixture TypeScript and `git diff --check` passed. Browser checks and TypeScript were run sequentially to avoid compounding host CPU contention.

New focused checks cover 1440/390/320 px growth/cap/shrink, width reflow on the same focused node with selection retained, reload/account/room draft isolation, failed versus confirmed send, IME composition Enter and Shift+Enter. Existing email and agent drafting checks pass with the new composer size.

Reviewed fictional screenshots:

- [Desktop capped draft](composer-grown-1440-chromium.png)
- [Narrow phone capped draft](composer-grown-320-chromium.png)

This completes the bounded auto-growth part of C10 only. Attachment contracts and accepted-event reconciliation remain separate roadmap work. C09 persisted reading positions and viewport/composer resize anchoring are the next approved slice; these screenshots do not establish restored reading-position behavior. No backend, production, native or outbound messaging operations were performed.

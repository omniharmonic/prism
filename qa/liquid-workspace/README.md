# Liquid workspace — Concept 02 implementation

Approved direction: lighter navigation, the faceted Prism logo, an open conversation reading surface, a floating-style composer and natural, restrained motion. Branch `design/liquid-workspace`, based on `f509c7d3`.

## Implemented

- Canonical faceted logo in shared React UI; generated SVG/PWA, macOS/Windows, and iPhone/iPad catalog assets from that same geometry. iOS catalog exports are opaque RGB, checked against every declared size.
- Neutral shell frame, softer corners and 224px default sidebar; existing saved sidebar sizes remain respected.
- Focus mode hides the side panels without remounting the editor or changing saved sidebar preferences. Opening a panel exits focus mode.
- Conversation history becomes a keyboard-accessible native dialog on desktop, rather than a permanent second sidebar. Existing mobile session navigation remains.
- Quieter message presentation, a shared reading measure, circular composer actions and visible permissions inside the composer. Status, budget, queue, errors, tool activity, source previews and review behavior remain.
- A gently decelerating history-drawer entrance, sidebar-preview fade and subtle control press response. Existing menu/sheet motion uses the shared 120–180ms system. Both OS and in-app reduced motion are honored. Reduced transparency and forced-colors use solid surfaces.

This is the shared React implementation, not a SwiftUI rewrite. Existing document tabs remain; the concept's two-mode sample was not substituted for multi-document navigation. The real document renderer, metadata controls and context panel retain their functionality. No voice capability was invented or permission behavior changed.

## Verification

- First focused Chromium pass: 78 passed (agent lifecycle, permissions, queue, draft resizing, sources, selection handoff, page agent, control sizing and logo).
- WebKit pass: 44 passed; the additional CDP touch-injection case cannot execute outside Chromium. That existing test uses `newCDPSession`; not a product failure. Chromium shell pass includes that case.
- Chromium shell pass: 38 passed; the new focus test initially used an incorrect exact accessible heading name (the title is “Rename A living workspace”). Correcting the locator produced passing focus tests in Chromium and WebKit.
- New drawer tests verify focus restoration, input DOM identity, unsent draft preservation, visible permissions, reduced motion and iPad hit areas.
- `npm run check` passed: all workspace/e2e typechecks, browser-dialog/worker checks, lazy-import guard.
- Web production and native web builds plus `verify:native` passed during implementation; final build status recorded in the change summary.
- Actual fixture captures: workspace, agent, history drawer, phone light/dark. Fictional data only. The unavailable companion is truthful fixture behavior.

No deployment, signed installer, simulator run or physical-device certification is claimed. Release gate: review web preview, check iPhone/iPad keyboard/safe areas and Mac drag regions, then use the existing tagged signing/deploy process for all clients. Web updates alone do not update installed native bundles. The separate Omni notification-icon defect is not changed by these Prism assets.

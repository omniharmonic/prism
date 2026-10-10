# Physical-device UI follow-up

The outer 14 CSS pixels on phones consistently open navigation across renderers. This coordinate region adds no overlay that blocks taps. Capture-phase touch/pointer start keeps graph and drag handlers from initializing there, without cancelling default taps or vertical scrolling. Only a clearly horizontal gesture is claimed and consumed. Between 14 and 32 pixels, existing selection/editor/form/graph/horizontal-scroll exclusions apply; unambiguous content can go back, while navigation header space opens the sidebar. A bounded leftward swipe closes the drawer; forms, selections, vertical, multi-touch and cancelled gestures remain untouched. Visible Back, Browse and Close controls remain alternatives.

Properties distinguish “Show N more fields” / “Hide extra fields” from “Property options.” “Choose visible fields” explains personal display choices; the full panel action says “Open property panel.” There is no expansion control when all fields already stay visible. Shared schema behavior and scoped personal persistence are unchanged.

Phone settings use a single horizontally scrolling section row and consistent label-above-control spacing. Modal content stays inside status/home safe insets, using native environment values by default; test overrides emulate iPhone 59/34px and iPad 24/20px. Workspace settings retain their existing section layout with calmer aligned gutters. Appearance, integrations, AI, advanced and workspace Publish/Members/Vaults fit the tested widths without horizontal content overflow.

Validation: web typecheck passed; 34 focused property/editing/mobile-navigation regressions passed; 22 final edge/settings cases passed, including real Chromium touch input proving a horizontal edge gesture neither initializes an underlying pointer drag nor clicks, while an ordinary edge tap still clicks. Reduced-motion fixtures and screenshot review covered 320/390/1024/1440px, with saved phone/iPad/desktop examples in `qa/screenshots/mobile-followup/`.

No production calls, server/Swift changes, sends, or data writes. Browser fixtures cannot replace the coordinator's physical WKWebView smoke check after rebuilding.

# Connected knowledge visual follow-up

2026-10-02 · source `a3e7ece` · D03 / R10 · isolated fixtures only.

Board19 supplies the visual direction. The implemented graph now has a quieter hierarchy, underlined2D/List/3D navigation, loaded-neighborhood search, legible document glyphs, explicit directional relationship labels in sparse desktop graphs, and readable tag/path/direction rows in List. Search uses returned title/path/tags and does not fetch or claim whole-vault search. Current focus remains visible.

Dense maps deliberately show at most9 nodes on wide surfaces and5 on narrow ones, with a visible count and List access to all loaded nodes. The32-document fixture caught overlapping320px labels during visual review; the final narrow layout uses an elliptical arrangement and word-aware two-line labels. The full accessible label remains available to keyboard/screen-reader interaction. Generic document glyphs avoid inferring content types the neighborhood contract does not return.

Verification:18 final Chromium/WebKit graph journeys passed, including keyboard focus, pan/zoom/reset, relationship and search intersection, scope change and late read isolation, fresh document authorization, bounded maps with all32 notes in List,320/390/1440 widths, dark narrow view, and lazy3D error fallback. The preceding32-check combined run also covered authoritative agent stop/activity states. Core and fixture TypeScript passed.

Fictional screenshots: [desktop](graph-1440-chromium.png), [390px](graph-390-chromium.png), [320px dark WebKit](graph-320-webkit.png). Viewed during review, not generated mockups.

Limits: no deployment, installed-client or physical phone proof in this slice. Saved graph explorations and large-vault performance remain open. No new graph sidebar snippet inspector or inferred type filter is claimed. Existing3D renderer is retained, not redesigned. Canvas presentation is a separate coordinated D03 slice.

# D06 — Publishing studio visual pass

Source checkpoint: `01b5030`. References: FRONTEND-ACCEPTANCE D06 / R13.1–4 and fictional board `assets/24-publishing-studio.png`.

## Implemented

- A quiet publication identity row and underline settings tabs retain the existing keyboard navigation and mounted unsaved settings. Publishing alone uses the wider 1180px workspace-settings area; other settings tabs keep their existing width.
- Site studio separates its settings column from its reader-preview area on desktop, with stacked controls on narrow screens. Save, explicit publish, local dirty state, saved draft revision, live revision, and appearance history remain distinct.
- **Show preview in studio** explicitly opens the saved draft through the existing authenticated preview request and actual reader template. Nothing is fetched merely to decorate the empty preview area. Unsaved edits explicitly remain outside the saved preview.
- **Expand preview** moves that same frontend preview state into the existing modal and returns to the inline view on close. It preserves the reader data, local settings and revision without another preview request. Resizing the workspace preserves draft and preview state. Publishing closes the consumed private draft preview.
- Existing wiki/documentation/landing templates, logo/cover URLs, colors, reading width, font and feature controls remain. Content/access remain immediate when saved; appearance remains a separate private draft and explicit publishing action. Legacy appearance reset, version restore, conflict reload, password and private-note exclusion behavior is unchanged.
- Corrected an existing typography mismatch: a sanitized explicit publication font now applies to article prose and headings, in both public reader and private preview. Code remains monospace; absent/invalid font choices preserve legacy defaults. The scoped rule travels with the rendered reader into its iframe, avoiding the lazy-stylesheet timing mismatch discovered by computed-style tests. No global editor typography changed.

## Verification

All **34 Chromium** and **34 WebKit** journeys pass. Aggregate `tsconfig.e2e.json` typecheck passes.

The suite covers existing private draft save/reload, actual-reader preview, independent publishing/restore, conflict and failed-write draft retention, password protection, content exclusions, scoped late responses, legacy reset, clipboard failure, public access recovery and narrow long-content rendering. Added journeys verify explicit inline preview activation, saved-vs-unsaved fidelity, expand/return without another read, consumed-draft closure, 1440/390/320 light/dark layouts, and actual computed Serif article/heading fonts across wiki/docs/landing at desktop and phone widths while code stays monospace.

Reviewed fictional screenshots are stored beside this note:

- `publishing-studio-1440-light-chromium.png`
- `publishing-studio-390-light-webkit.png`
- `publishing-studio-320-dark-webkit.png`
- `publishing-expanded-phone-preview-webkit.png`

## Boundaries

The board's Blog/Portfolio labels, decorative article photo, slogan, and navigation are illustrative. This implementation uses existing wiki/docs/landing capabilities and actual eligible fixture content. The held mixed backend navigation branch `51ec5bc` is not included; no navigation editor or server feature is implied by these images.

The inline adapter adds optional frontend presentation props to the existing preview context. It does not change server endpoints, manifests, sanitization, publication membership or access policy. No real publishing, production/native operation, or backend change was performed. Integrated production/native verification remains with the coordinated release pass.

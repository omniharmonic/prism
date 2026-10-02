# Narrow publication reader typography — D06 / E01

Source checkpoint: `89279ed`. All captures use fictional fixture content.

## Observed issue and correction

At an actual 220px reader viewport (including the private preview iframe inside the phone studio), the 28px article heading split the ordinary word “understanding” across two lines. Both baseline public-reader and nested-preview reproduction tests failed the word-rectangle assertion before the correction.

WikiTemplate now gives headings a reader-local fluid scale only at viewport widths up to 390px. Article H1 and the mobile page title use `clamp(22px, 7vw, 28px)`; article H2 uses `clamp(20px, 6vw, 22px)`. Existing desktop styles and selected publication fonts remain intact. Body text stays 16px with a 27.2px line height. Long unbroken tokens still wrap; code remains monospace and horizontally scrollable.

| Actual reader viewport | Article H1 after correction |
| --- | --- |
| 220px | 22px |
| 320px | 22.4px |
| 390px | 27.3px |
| 1280px | Existing 28px |

The tests cover both Georgia/serif and system-ui/sans in standalone public readers and nested private previews. They measure the iframe’s own `innerWidth`, not the outer studio width or scrollbar-reduced document client width. The word “understanding” occupies one text rectangle at every tested narrow width; body and long-token content do not produce horizontal overflow.

## Verification

- Chromium: 33 publication, typography and studio tests passed (28.6s).
- WebKit: the same 33 tests passed (22.3s).
- Existing wiki/docs/landing selected-font tests and unspecified-font fallback tests retained.
- Aggregate web fixture TypeScript check passed: `tsc --noEmit -p tsconfig.e2e.json`.
- `git diff --check` passed.
- Runs were serialized with two workers per browser.

The new typography coverage adds six standalone viewport/font cases and two nested-preview cases covering three widths each. Existing studio tests continue to verify draft preservation, inline preview, compact phone view switching, selected font rendering and reader navigation.

## Visual evidence

- [Nested preview before](preview-heading-220-before-webkit.png) and [after](preview-heading-220-after-webkit.png).
- [Public reader before](reader-heading-220-before-webkit.png) and [after](reader-heading-220-after-webkit.png).

These are actual WebKit fixture captures at the same 220px reader width; vertical capture positions differ, so they are visual evidence of word wrapping and scale rather than a pixel-diff baseline. The corrected heading keeps the ordinary word intact and leaves paragraph sizing unchanged.

This checkpoint verifies local fixture readers and the existing authenticated-preview presentation component. Production web and installed native checks remain part of the parent release verification.

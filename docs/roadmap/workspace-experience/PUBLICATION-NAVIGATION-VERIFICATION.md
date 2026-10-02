# D06 navigation frontend checkpoint

Source: `c17d357` on isolated `feat/publishing-navigation-ui`, based on `373d1fd`. This is frontend-ready, **not release-ready**. Do not integrate/deploy it against the currently inspected `a98c9af` backend: that snapshot rejects `theme.navigation` and lacks the required public/preview projection. Ship only atomically with an acknowledged compatible server and verify the installed native preview before accepting the release.

## Contract boundary

The shared helper is copied exactly from held `51ec5bc`. It defines `theme.navigation = {version: 1, sections: [{title, noteIds}]}` with at most 8 sections, named section titles of at most 80 characters, at most 64 unique page IDs across all sections, and the held ID syntax. The server's existing 4 KB bound applies to the entire theme, including navigation and image URLs.

The compatible server must preserve owner draft/history navigation, validate writes, honor existing optimistic revisions, and project public and private-preview manifests against the currently eligible page set. It must remove excluded/private/missing IDs and empty section labels, including a locked site's labels. Client filtering is defense in depth, not a replacement for that server projection. Ordinary presentation/preview support does not advertise navigation support; the release is gated on the exact contract, not on an invented runtime capability or probing write.

## Frontend implementation

- A compact Site navigation editor fits the existing studio settings column and board24 visual language. Eligible-page choices come from `previewPublication`; stale IDs remain anonymously removable. Candidate errors keep local section edits. Audience/scope changes and unmounts reject late candidate results.
- Keyboard-operable section/page ordering, named sections, counts, reset to path tree, and a phone-sized picker. Local section keys survive reordering; none are persisted in the contract.
- Private save/preview/publish/history flows remain unchanged. Navigation changes preserve all other appearance fields. Empty titles/unsupported formats/oversized themes do not silently save or discard edits.
- Wiki/docs/landing render sections only from the manifest theme and eligible manifest notes. Unassigned pages remain available; malformed/unknown navigation falls back to the path tree. No stored navigation ID triggers an extra page fetch.

## Private-preview correction

The baseline WebKit fixture rendered ordered sections but a click inside the `allow-same-origin` iframe did not invoke the trusted React navigation listener. This reproduced before changing the iframe; 5 of 6 initial navigation cases passed, and the private-preview navigation case failed.

The fixed literal `srcDoc` now places `script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'` before its body, and the sandbox permits same-origin/scripts so listeners installed by the trusted parent React tree work in WebKit. `sanitizeHtml` remains unchanged and forbids scripts, iframes, objects, embeds, forms, event attributes and executable URLs. Reader templates have no supported iframe embeds, so `frame-src 'none'` does not remove a reader feature.

This does **not** treat the two sandbox flags as a script isolation boundary. MDN warns that same-origin scripted frames can remove their sandbox; this design relies on fixed source construction, sanitization and the early document CSP, while trusting the parent application. [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe). The CSP `script-src` rule covers loaded scripts and inline handlers; `'none'` allows no script resources. [MDN script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src).

Both-engine fixtures append an inline script, an external script, an inline event handler and a `javascript:` link directly to the preview document. None executes; the external script is not requested. In the same frame, trusted parent navigation and the phone drawer work. This evidence does not claim arbitrary remote iframe content would be safe, or substitute for installed native verification.

## Verification

Fixture port 5192, two workers maximum, serialized browser and type runs, no production account/API. The suites were publication-navigation, presentation, publication and publishing-studio; the filename filter also included the three existing settings-presentation cases.

- Chromium: **35 passed**, 25.2 seconds.
- WebKit: **35 passed**, 33.4 seconds.
- After correcting the picker’s native WebKit sizing, its desktop/320px journeys passed again in both engines.
- Aggregate e2e TypeScript passed; `git diff --check` clean.

Coverage includes rejected-save draft retention, complete-theme preservation, exact section ordering, candidate recovery, excluded/unavailable reference labels, explicit reset, size/count constraints, invalid version fallback, all three public templates, private preview navigation and adversarial script probes. One early assertion incorrectly inspected the entire owner studio for an excluded title (the existing hidden Content panel legitimately lists it); it now asserts that the navigation editor does not expose that label.

Reviewed fictional desktop/320px captures: [desktop navigation](verification/frontend-20261002/publishing-navigation-1440-webkit.png), [320px navigation](verification/frontend-20261002/publishing-navigation-320-webkit.png). A separate approved presentation checkpoint will reduce studio header density and add a state-preserving phone Settings/Preview switch.

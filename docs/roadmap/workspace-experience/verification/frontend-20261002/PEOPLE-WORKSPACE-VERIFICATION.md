# C06 — Canonical People workspace

Source checkpoint: `44f631d`. Reference: FRONTEND-ACCEPTANCE C06 (R04.1/5 and R05.1), approved fictional board `assets/21-people-profile.png`.

## Implemented

- Responsive directory/profile layout with a quiet selected row, name-derived initials, returned roles, a clear profile heading and Properties disclosure. The layout responds to its available container width, including a narrow desktop document area.
- Directory selection opens the exact canonical ID inline. Existing `people:<id>` entry remains supported. Mobile Back to People preserves search, list scroll and keyboard return focus. A workspace/account scope change resets the local selection and isolates queries.
- Linked identities display the exact returned kind and value. Existing identity-management capability checks, revision guards, scoped drafts and add/remove operations remain. No matching or repair behavior changed.
- Underline category navigation retains All records, Conversations, Meetings, Tasks and Notes; the narrow layout scrolls this strip horizontally. Related records use their actual category, relationship labels and path. Existing pagination remains available separately for directory and profile records.
- Opening a person note or related record still calls `getNote` before opening a normal document tab. Refreshing/failed profile queries hide prior identity controls and related records; late responses from another scope cannot restore them.

## Verification

All 14 focused journeys pass in **Chromium** and all 14 pass in **WebKit**. Aggregate `tsconfig.e2e.json` typecheck passes. Existing five People workflows remain covered alongside nine new dedicated fixture journeys.

Coverage: equal-name identity separation; deep-link entry; fresh denied note/profile access and recovery; late response after scope change; read-only identity controls; failed identity draft/revision retention across layout changes; mobile filter/focus/scroll return; all-category navigation; long canonical names/accounts; no horizontal page overflow at 1440, 390 and 320 pixels. The existing mutation test now checks disclosure visibility before opening it: a fast refresh can preserve its open state, especially in WebKit.

Reviewed fictional screenshots are stored beside this document:

- `people-profile-1440-light-chromium.png`
- `people-profile-390-light-webkit.png`
- `people-profile-320-dark-webkit.png`

## Contract limits and integration boundary

`PersonPage.related` currently returns ID, title, path, category and relationships. It does not provide message excerpts, transport branding, dates or transcript availability. Those details from board21 are deliberately absent rather than invented. No photos, unknown-participant counts, identity-review queue or repair API are supplied by this slice.

This verification uses mocked authorized data and transport in isolated fixtures. It does not certify production/native behavior or a backend identity-reconciliation service. No production operations, backend/API changes or real messages were performed.

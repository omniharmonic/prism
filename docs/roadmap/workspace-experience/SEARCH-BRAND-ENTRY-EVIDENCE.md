# Search, small-size brand, and connections entry

Local frontend checkpoints, 2026-10-02. No production writes, server changes, native install, or complete-roadmap claim.

| Acceptance / reference | Implemented source | Verification and remaining boundary |
| --- | --- | --- |
| D01 / R09.2, R09.5 / board 11 | `68bdb28`: SearchPanel and CommandBar use quieter result rows, readable title/path/excerpt, Notes/Messages/Commands filters, current-workspace scope, explicit Open affordance, and all returned matches instead of a silent eight-result slice. Matching notes precede commands. Open Agent Panel no longer closes an open panel. | Nine browser journeys per engine. Messages means existing email/thread notes within returned vault results; no invented external inbox query, sender metadata, pagination, or recall guarantee. Add context remains in the existing agent picker: the palette still needs an atomic saved-note handoff that coordinates with sends. |
| A01 / board 17; board 18 confirms surrounding agent context | `ef3d967`: shared SVG retains five incoming colored rays, prism, and one outgoing ray. Small marks omit faint facets and use heavier strokes. Tiny app icons have more room; larger PWA/maskable exports retain the established safe inset. SVG favicon and native 32px/ICNS exports regenerated. | Actual 16/24/32/48/64/96 CSS-pixel atlas, light/dark and monochrome; 200% zoom/reduced-motion screenshot in Chromium/WebKit. Export script completed and native 32px raster dimensions checked. Bundle/auth IDs unchanged. Standalone dark-ink mark exports remain for compatibility; no actual dark consumer needs a new light asset. Installed/native OS icon caches and physical-device appearance remain release checks. |
| D07 / board 25 / connections follow-up | `8101b3b`: actual Workspace settings exposes Connections for confirmed owner/admin with the integration-status seam. Owner host controls still require successful server-info confirmation inside ServerPanel. Device Settings points to the authority-gated workspace surface with accurate copy. | Sixteen connection journeys plus four settings/navigation journeys per engine. Non-owner admin tested through the actual outer renderer. Member, unknown viewer, missing viewer, missing integration seam, demotion while selected, and permitted-tab fallback covered. Legacy local Server entry remains when there is no scoped integration seam. No API or backend authority change. |

## Checks

- Chromium and WebKit: nine search, sixteen connections, four settings/navigation, one brand journey in each engine (60 distinct passing engine journeys; targeted artifact reruns excluded from this count).
- Core TypeScript and a focused fixture TypeScript project passed. `git diff --check` passed.
- Search preserves access-safe revalidation, explicit ranked-to-keyword degradation, inert excerpts, canonical `note.id` opens, delayed-result selection, and explicit-only Ask execution. Escape does not close a parent native dialog. Phone filter/close targets are at least 44px.
- Existing connection payloads, write-only secrets, Proton certificate trust, sync/remove confirmations, scope reset, and owner operations were rerun against isolated fixtures. Configured credentials still do not imply a successful sync.
- Browser checks used fixture mode on localhost:5193 with the backend destination disabled. No real credentials or production destinations were used.

## Retained visual evidence

- [Desktop search](assets/evidence/search/search-command-desktop.png)
- [Dark phone search](assets/evidence/search/search-command-phone-dark.png)
- [Phone ranked/keyword result surface](assets/evidence/search/search-results-mobile.png)
- [Brand at actual sizes](assets/evidence/brand/brand-real-sizes.png)
- [Brand at 200%](assets/evidence/brand/brand-200-percent.png)
- [Actual non-owner admin Connections entry](assets/evidence/connections-entry/connections-admin-entry.png)

These are real fixture screenshots inspected after rendering. Search follows board 11 hierarchy without adding its illustrative unsupported attachment action. The brand preserves board 17 geometry; no replacement visual direction was introduced.

## Separate canonical-ID finding

Read-only audit reported to the integrating agent: SearchPanel/CommandBar and normal Canvas opening use returned canonical IDs. Direct `/collab/...` route input was passed through CollabPage to CollabDoc's socket name even after REST fetched a note. The backend's strict-ID socket contract therefore requires canonicalizing this route before connection. That fix is outside these commits and belongs to the integrating agent; this document does not claim it verified.

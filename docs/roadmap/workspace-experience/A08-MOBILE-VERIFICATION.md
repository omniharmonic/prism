# A08 mobile navigation and action sheets

2026-10-02 · source `13dfd9d` · base `bb8d708` · isolated frontend fixtures, no deployment.

## Approved requirement and interpretation

FRONTEND-ACCEPTANCE A08 / R03.1, R03.5 and R15.1 requires one mobile task surface, stable document/session state, reachable creation and specialist tools, and safe keyboard/focus behavior. Board [14](assets/14-mobile-navigation-create.png) and DESIGN's Mobile web and PWA section establish labeled navigation, open documents and creation within Browse/More, with deliberate sheets instead of stacked floating controls.

This slice uses five labeled actions: Notes, Messages, Search, Agent and More. This reconciles board14's four labeled controls with the later plan's direct Inbox requirement while preserving the high-priority Agent shortcut. **Notes opens the existing navigation drawer; it is not a new route or note hierarchy.** Messages uses the sidebar's exact `vault-messages` destination. No new backend or navigation ontology is introduced.

## Old-to-new entry map

| Previous entry | Current entry and preserved behavior |
| --- | --- |
| Files icon | Notes label → existing navigation drawer, workspace/vault switching, Favorites/Recent/Pages and all configured Tools |
| Agent icon | Agent label → existing document companion, same session/context implementation |
| Search icon | Search label → existing command/search dialog |
| Sidebar Messages | Also directly available as Messages in the dock; opens the same tab without duplication |
| Plus icon | More → New page, and existing New page in the navigation drawer; same title-first creation, formats and email compose |
| Tabs icon | More → Open documents with count; explicit keyboard-open and separate close buttons, current-page and unsaved markers |
| Details, Ask about note, full agent chat, history, graph, favorites, reading font, Settings | Retained in More with the same capability gates and actions |

The dock fits the existing76px reserved mobile inset. Its five controls and sheet close/document-close/reading-font controls meet44px minimum touch height. Styling is scoped in `mobile-workspace.css`; the global glass styles, Shell, editor identity, tab authority, routes and content serialization are unchanged.

## Sheets and keyboard

The two existing BottomSheet consumers are both in MobileActionBar. They now use a named native dialog with an explicit close button, keyboard cycling, Escape, backdrop dismissal and focus return. More → Open documents, creation, Settings and Details preserve a meaningful return target. Creation uses NewContentMenu's existing `returnFocus` prop. Open-document rows are real buttons next to separate close controls, preserving existing `closeTab` semantics.

Only dragging the sheet handle can dismiss it. Scrolling the list body cannot accidentally become a dismiss gesture. The sheet scroll area is bounded to the visual viewport, including a software-keyboard offset. Navigation hides only during detected editable focus plus an unzoomed, substantially reduced visual viewport; pinch zoom alone does not hide it. This changes neither the editor mount nor the reserved inset.

## Verification

- **82 distinct Chromium/WebKit journeys passed** across mobile-navigation, workspace, navigation, creation-entrypoints and shortcuts. The combined run initially passed80/82; the two failures were an existing shortcut assertion hard-coded to port5188. Deriving the actual page origin fixed the test on isolated port5191, and both targeted cases passed. No product workaround was needed.
- The dedicated14 engine journeys cover visible labels and44px targets, direct Messages deduplication, real editor DOM/draft preservation through navigation/agent/action sheets, desktop breakpoint removal, old actions, creation/Settings/Details focus transitions, keyboard document selection, close and unsaved labels with20 long-titled tabs, and handle-only dismissal.
- Existing regressions retain live-thread/editor identity across breakpoints, message composer clearance, canvas focus/inertness, workspace sharing, shortcut audience isolation, title-first creation and autosave behavior.
- Core TypeScript, aggregate fixture TypeScript and `git diff --check` passed. Tests used two workers and ran separately from typechecks to avoid competing with other agents.
- The visualViewport check is a **deterministic mock**, not a physical mobile keyboard test. It proves navigation visibility decisions, retained editable content and sheet bounds under the supplied viewport changes. Physical Safari/PWA keyboard, IME, dictation and device safe-area acceptance remain E03 release gates.

## Reviewed fictional screenshots

All names/content are fictional. Tests write to `testInfo.outputPath`; the selected captures below were explicitly copied after inspection.

- [390px writing and navigation](evidence/a08-mobile/mobile-390-light.png)
- [390px More](evidence/a08-mobile/mobile-more-390-light.png)
- [320px dark writing, WebKit](evidence/a08-mobile/mobile-320-dark.png)
- [320px dark More, WebKit](evidence/a08-mobile/mobile-more-320-dark.png)
- [Landscape writing](evidence/a08-mobile/mobile-landscape.png)
- [Landscape scrollable More](evidence/a08-mobile/mobile-more-landscape.png)
- [Twenty open documents, WebKit](evidence/a08-mobile/mobile-open-documents.png)

No production data, external send, server mutation, native installation or physical device was used. Root owns the coordinated integration/release checks and the broader completion matrix.

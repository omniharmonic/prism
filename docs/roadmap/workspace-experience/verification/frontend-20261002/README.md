# Actual frontend screenshots — fictional fixtures

These are rendered application captures, not generated concepts or production user data. Compare them to the original [mockups](../../MOCKUPS.md). Each entry below certifies only its named slice; other parts of a screenshot may still show earlier UI.

## Navigation slice — A02

Actual captures: [desktop light](navigation-desktop-light.png), [desktop dark](navigation-desktop-dark.png), [phone light](navigation-phone-light.png).

Compared with mockups01/14: vault identity now sits below Prism at the top, Messages is a primary destination, Recents is compact, the page tree is central, specialist tools are disclosed, and the primary New page action is labeled. The screenshot fixture has no AgentClient, so the companion truthfully says unavailable; this is not an agent experience acceptance image. The larger document/companion redesign is being tested separately.

Entry-point mapping: Inbox → Messages (same vault-messages tab); Conversations → Agent conversations (same agent-chat action); Calendar/People/Automations/Map → Tools with unchanged tab actions; Workspace settings → footer (same network tab); vault selector → header; New note → New page; New folder/Collapse all/Refresh → Pages heading. Existing favorites, tree, search and tabs remain.

Verification: 27 Chromium workspace/navigation/shortcut journeys passed, then three focused navigation checks passed after adding actual dark rendering. Web and e2e types passed. Inspected desktop light/dark and phone screenshots. The first run exposed locator ambiguity with a user folder named Messages and expected expanded Recents; assertions now use the semantic primary-navigation landmark and explicitly expand Recents, preserving the original behavior checks.

Not claimed: whole R03 completion, browser 200% zoom, actual phone keyboard, specialist pin/reorder preferences, final document typography, production rollout or installed-native verification of these new changes. A04 and the remaining acceptance matrix rows stay open.

## Sidebar personalization — A04 / R03.4 / F02.3

[Desktop preferences](sidebar-preferences.png), [320px WebKit preferences](sidebar-preferences-phone.png). Calendar, People, Automations and Map can be pinned, kept in Tools, hidden and reordered without dragging. Navigation spacing is a device preference; coarse pointers retain 44px targets. Restore defaults always recovers hidden tools. Only static tool IDs/preferences are saved, never note titles or permissions.

Ten focused Chromium/WebKit journeys passed, including reload persistence, no document writes, and nested mobile-dialog Escape/focus restoration. Review found native cancel bubbling and cleanup timing could close the parent drawer or lose focus; cancellation is scoped and native cleanup precedes DOM removal. Types passed before the final focus-only correction; combined release types will run after integration. This slice does not claim the remaining tab-overflow, tablet-width or broader settings work.

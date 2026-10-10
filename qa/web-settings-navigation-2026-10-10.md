# Web workspace polish: settings, property chrome, mobile edges

The page keeps its visible typed fields and tag editing. One Properties disclosure now holds personal display choices, Add property, shared schema customization, and read-only page details. Updated no longer consumes a separate row. The same layout is used by normal and live collaborative editors; the public read-only fallback is unchanged. Personal visibility still uses the user/vault/page audience from PR75, remains device-local, and never changes the shared schema unless the owner explicitly uses Customize.

Workspace settings use a 200px section list on iPad/desktop and scrolling horizontal tabs on phones. Arrow Up/Down work in the vertical list; Left/Right work in the horizontal list. Navigation alone uses the existing floating material, with solid fallback and reduced transparency support; content stays opaque. Global vault create/link/remove and federation require `isServerOwner`, while delegated vault admins retain member and publication management. A viewer refresh clears the operator flag while loading.

On phones, rightward swipes starting within 20px of the left edge open navigation over header space. Over noninteractive content they go back through Prism history, or open navigation when there is no history. The 64px threshold, directional check, and 900ms bound reject incidental touches. Editor/form/control targets, selections, horizontal scroll containers, canvases, graphs, modal dialogs, and explicit opt-out regions retain their own gestures. Multi-touch, vertical, cancelled, and mid-screen gestures do not navigate. The implementation uses passive listeners and does not suppress platform gestures. Back and Notes buttons remain keyboard/accessibility alternatives.

## Verification

- Web TypeScript check passed.
- 29 focused property/phone/settings cases passed after final layout updates, including 320px reflow, account/vault scoping, cross-tab preferences, Trash audience isolation, role changes, dark/light settings, vertical keyboard navigation, and one resting configuration row.
- 13 existing property editing/schema/CAS cases passed; body and schema-write assertions retained.
- 3 focused mobile edge cases passed, including draft preservation and gesture conflict cancellation.
- 7 existing mobile navigation cases passed, including editor retention, sheet focus, keyboard viewport behavior, and responsive navigation.
- Reduced motion uses the existing global near-zero fallback (at most 1ms) and explicit transition suppression in the new navigation/edge styling.
- Fictional fixture screenshots reviewed at phone, iPad, and desktop sizes; settings light/dark screenshots are in `qa/screenshots/web-settings-navigation/`.

No production calls, server changes, data migrations, native builds, or full test suites were performed in this phase. Physical iOS/browser gesture behavior remains a device smoke check for the coordinator; the browser fixtures exercise the actual shell handler with bounded touch events.

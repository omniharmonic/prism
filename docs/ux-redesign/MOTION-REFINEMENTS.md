# Interactive surfaces — local preview

This pass changes mobile drawers, search, shared bottom sheets, and row alignment. It is not deployed.

- Sidebar opening updates its transform directly after mounting, avoiding a Shell render on every touchmove.
- Drawer gestures take over an in-flight entrance animation. Navigation closes left; document panels close right. Slow deliberate navigation swipes are allowed.
- Search dismisses down from its handle or surrounding chrome. Text fields and results retain selection and scrolling.
- Bottom sheets follow handle/heading drags, return on cancellation, and animate explicit dismissal. Action selections retain immediate handoff.
- More-to-document-panel handoff finishes sheet cleanup before the drawer captures its focus-return target.
- Attach notes and Capture text share 44px controls and matching icon/text metrics. Expanding Capture text does not vertically recenter Attach notes.
- Tab-bar label leading is explicit.

Validation: npm run check; Chromium and WebKit navigation, responsive chrome, alignment, cancellation, editor identity, focus return, and reduced-motion checks. Chromium CDP also exercises real touch sidebar opening/cancellation and search dismissal. CDP cases intentionally skip WebKit.

Preview: http://127.0.0.1:5198/e2e-fixtures/workspace.html?navigation&agent
Attachment row: http://127.0.0.1:5198/e2e-fixtures/agent.html?history&permissions&visual&snapshots

Physical iOS/iPad acceptance remains: interrupt/reverse transitions, scroll long lists, select editor text, and repeat with the keyboard visible. Fixture tests establish behavior, not measured device frame rate. Persistent desktop/iPad sidebar layout and desktop search presentation remain unchanged.

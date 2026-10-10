# Workspace controls — first UI phase, 2026-10-10

The sidebar fade meets the footer tray, page drags can target Trash with confirmation and Undo, graph close remains within320–1440px viewports with a44px target, and email details now expose the same guarded classification operation as chats. No delivery-status, sending, server or Swift changes.

Page properties have a personal display checklist and remembered collapse state. Storage is device-local, keyed by authenticated user/vault audience and page ID (`prism:property-view:`). No values or bodies are stored. Missing personal visibility uses live shared tag defaults; an explicit empty selection hides all metadata fields until expansion. Reset returns to shared defaults. It does not sync across devices or change shared schema pins. An unknown audience exposes no persistent personal control. Storage failure retains the scoped session choice.

Validation: web typecheck;21 focused controls/message-status cases and13 existing property cases passed in separate bounded runs. Owner/member email edits are one tag operation, refused edits roll back and view-only edits are disabled. No real sends or production data writes. Reduced-motion chevron duration is at most1ms; Trash does not animate under reduced motion. No full suite or simulator run.

Fictional fixture screenshots: [phone](screenshots/workspace-controls/properties-phone.png), [iPad](screenshots/workspace-controls/properties-ipad.png), [desktop](screenshots/workspace-controls/properties-desktop.png), [Trash](screenshots/workspace-controls/trash-desktop.png), [graph](screenshots/workspace-controls/graph-390.png).

Workspace settings and conflict-safe mobile edge gestures are the next separate UI phase.

# C05/C07 — Email recipients and agent reply drafts

All evidence uses fictional `example.test` identities and fixture-only clients. No real email, Matrix message, agent execution, or production account was used.

## Implemented

- Explicit To, optional Cc, source, and honest sending-account copy. Cc is scoped and survives closing; changing Cc changes retry identity without changing the body draft. Invalid Cc blocks sending while the body remains editable. This is not automatic Reply all.
- Draft with agent creates or recovers a dedicated read-only, note-bound session on explicit click. Generation uses the existing `useAgentConversation` controller, existing session APIs, and persisted idempotent receipts.
- Durable server final text is previewed before explicit insertion. Append preserves existing text; replacement requires confirmation and checks for intervening draft changes. No insertion sends a message.
- Closing the drawer preserves instructions, session reference, pending request, and human reply. Reopening does not create a new run or cancel one. Scope and recipient changes isolate sessions; a fresh session read checks note and permission mode before generation or insertion.
- A lifecycle guard in the shared frontend controller prevents a late send continuation from attaching a stream after unmount or a session change. StrictMode fixture exercises both cases.

## Verification

- Chromium: all 39 focused inbox, messages, and agent-reply journeys pass.
- WebKit: all 39 focused journeys pass.
- Web TypeScript check: pass.
- Visual review: 1440px desktop, 390px and 320px phone widths; light and dark draft drawer. Screenshots are fictional fixtures. Browser viewports do not substitute for physical keyboard/IME or installed native validation.

The 13 new agent journeys cover explicit insertion without outbound sends; append/confirmed replacement; close and reload recovery; unknown create/turn acknowledgement reuse; no duplicate run/cancel on close; recipient and audience separation; late resolution cleanup; deliberately revised request identity; changed permissions; and keyboard Escape/focus return.

## Still distinct from completion

The right drawer is a comms-local adapter, not the permanently docked three-column layout in mockup 10. Source-context cards, attachments, quoted email history, and automatic Reply all remain separate requirements. The two backend-boundary request documents describe authoritative email envelopes and an atomic agent policy-version precondition. No backend/API/transport source changed in this slice. Production and installed native acceptance belong to the coordinated integration pass.

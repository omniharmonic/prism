# C07 summary and task intent — proposed boundary

This is a follow-up contract outline for FRONTEND-ACCEPTANCE C07 / WORKPLAN F08.6. It is not an implementation or a completion claim. The email drafting checkpoint already uses a dedicated read-only session, durable receipts and explicit insertion into the human reply. Summary and task actions should reuse those existing agent/context mechanisms.

## Summarize

An explicit action starts or resumes a separate read-only, note-bound summary intent. The handoff identifies the current scope, source note and actual captured context; when only a loaded message window is available, the result must say so. It must not imply that unprovided history was summarized. Generation uses the existing session/controller/request-receipt paths and their uncertain-outcome handling. The durable output is labelled a summary; closing the panel neither sends a message nor implicitly cancels a run. It must not retarget an existing unrelated session.

## Draft a task list versus create tasks

A read-only action may generate an editable proposed task list, carrying source note/context identifiers. Titles are editable; dates and assignees may appear only when explicitly evidenced or entered by the user. This may truthfully be called “Draft a task list.” Copying that text is not task creation and does not fulfill the original extraction-to-task workflow by itself.

Actual creation requires all of the following:

- An explicit destination vault/project/list selected by the user, plus fresh create authorization.
- A documented task schema and metadata mapping supported by the current client/server contract.
- Human selection and confirmation of the individual proposed tasks.
- Per-item idempotency and durable recovery/readback for uncertain writes. An unconfirmed response must not lead to blind retries or a success count.
- A clear partial-result state: confirmed tasks link to actual created notes; failed or uncertain proposals stay available for review without duplicating confirmed tasks.
- Source attribution linking actual created tasks back to the conversation where supported.

The existing generic `createNote` call does not establish this action's per-item idempotency/recovery contract. That boundary needs agreement with the backend owner before implementing a “Create tasks” action. No new API, write-enabled agent session, outbound send, or task creation was added in this preservation checkpoint.

# C07 saved-conversation summary verification

Source checkpoint: `2ffdd82`, isolated `feat/composer-growth`. This completes the bounded summary action from C07; task extraction/creation remains an explicit backend contract gate described in `C07-SUMMARY-TASK-INTENT-CONTRACT.md`.

## Implemented behavior

- Message and email readers expose **Summarize** through the existing confirmed agent capability, read-only profile, permission mode and scoped-client gates. Reading a conversation can permit summary even when its outbound reply is unavailable.
- Opening creates or reopens a separate note-bound read-only session. Only **Generate summary** starts a turn. The existing `useAgentConversation` controller owns durable output, streams, terminal states and reloads; no second runtime or new API was added.
- Summary session, instructions, creation, pending and turn receipts use `agent-summary-*` namespaces. Reply namespaces, request keys and prompt bytes remain unchanged. The summary path never mounts the human message-draft hook, never inserts into a reply, and never sends or creates tasks.
- Fresh same-note/read-only/not-archived checks precede generation and copying. Unknown acknowledgements retain the request identity and instructions. Output uses the existing controller's durable final text; live deltas and tool narration are excluded.
- **Copy summary** is deliberate and reports clipboard failure. The panel describes the saved-note context limitation and warns that newer source messages may need to sync.
- Email reply and summary panels switch within the existing companion dock, preserving mounted controllers and unsent instructions. The dock hides only when no visible panel remains. Message readers retain the existing modal presentation.

## Checks

Port 5192, isolated fixture mode, no production environment, two workers maximum, browser suites serialized. The five suites were `agent-summary.spec.ts`, `agent-reply.spec.ts`, `email-collaboration.spec.ts`, `messages.spec.ts`, and `live-thread.spec.ts`.

- Chromium: **51 passed**, 44.0 seconds.
- WebKit: **51 passed**, 56.1 seconds.
- Aggregate fixture TypeScript: **passed** — `npm exec -w @prism/web -- tsc --noEmit -p tsconfig.e2e.json`.
- `git diff --check`: clean.

The nine summary cases cover explicit generation/copy at 1440/390/320px; distinct reply/summary sessions and receipts; unsent instructions through close/reopen and switching; unchanged human reply; lost creation and generation acknowledgements; closing a running summary without duplicate generation or cancellation; fresh note/mode checks; clipboard failure; account isolation; and actual MessageRenderer entry without an outbound client. Existing reply, sending, Cc, native-fallback, read-only, multiline-history and delayed-height tests all remain green.

## Visual evidence and limits

Reviewed fictional Chromium desktop/320px and WebKit desktop/320px screenshots. Checked readable controls, wrapped title/text and no horizontal overflow. The preserved WebKit captures are:

- [Desktop email companion](verification/frontend-20261002/agent-summary-1440-webkit.png)
- [320px summary](verification/frontend-20261002/agent-summary-320-webkit.png)

These use fictional email content and a fake AgentClient. They demonstrate presentation, scope/receipt behavior and explicit clipboard success/failure handling; they do not claim production inference, a live clipboard permission grant, connector delivery, native installation, task creation or complete remote message history. No backend or native changes were made in this checkpoint.

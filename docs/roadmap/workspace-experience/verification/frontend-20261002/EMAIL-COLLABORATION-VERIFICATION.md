# Email collaboration verification — 2026-10-02

Source checkpoint: `c77e583` on `feat/email-collaboration`, based on `75bf7e9`.

## Scope and acceptance

This checkpoint addresses C05 email reading and C07 existing agent-assisted reply presentation from FRONTEND-ACCEPTANCE.md, guided by approved board 10 and the messaging plan. It also verifies the C03 delayed-content anchor without changing MessageThread.

| Requirement | Implemented or verified |
| --- | --- |
| C05 readable email | Quiet subject/source header, readable sender/recipient rhythm, exact imported To/Cc, and plaintext content. Existing reply, archive, read status, labels, authorization and send behavior remain in place. |
| C05 quoted history | Conservative native disclosures for recognized trailing quoted text, `On … wrote:` history, or a standard signature delimiter. Reopening reveals the original text. Visible and folded segments concatenate to the exact source; quote-only, uncertain and code-containing bodies stay visible. |
| C05 attachments | The exact imported attachment label appears under “Attachments listed in source.” The interface explicitly says downloads are unavailable on this connection; it invents neither attachment counts nor file links. |
| C07 email plus agent | Explicit Draft with agent opens the existing read-only, note-bound drafting session alongside the email on wide layouts. Narrow layouts stack the same mounted session below the email and reply. Closing, reopening and resizing preserve instructions, durable output, human draft and existing receipt identity. |
| C07 insertion and safety | Existing explicit append/replace actions, destination and scope checks, unknown-outcome receipts, session reuse, errors and send separation remain covered. Closing the view starts or cancels no run. Escape closes from within the agent panel and restores launcher focus; Escape while editing the human reply keeps the panel open. |
| C03 asynchronous content | A deterministic fixture increases an earlier message’s height after scrolling. The same visible event remains at its previous offset within 2 px in both browser engines. No MessageThread code change was necessary. |

## Checks

- Chromium: **39 passed**, comprising `email-collaboration.spec.ts`, `agent-reply.spec.ts`, and `messages.spec.ts`.
- WebKit: **39 passed**, the same suites on the final source.
- Aggregate fixture TypeScript: `npm exec -w @prism/web -- tsc --noEmit -p tsconfig.e2e.json` passed.
- `git diff --check` passed before source commit.
- Tested 1440 px light, 390 px light and 320 px dark, keyboard close/focus, nonmodal simultaneous editing, resize/close draft continuity, explicit insertion, unknown receipts, audience changes and email reply behavior.
- Isolated local fixture server on port 5192. No production data, actual agent generation, outbound email, native app, or production deployment was exercised.

## Reviewed fictional screenshots

- [Desktop email and agent dock](email-agent-docked-1440-light-chromium.png)
- [Phone email reader](email-reader-390-light-webkit.png)
- [Narrow dark agent drafting panel](email-agent-docked-320-dark-webkit.png)

All names, messages and attachment labels in these fixtures are fictional. These screenshots are visual evidence for this checkpoint, not a claim that all roadmap functionality or production integrations are complete.

## Remaining named work and contract boundaries

- Actual authenticated attachment download/upload requires an available supported contract; imported labels alone do not establish a usable attachment.
- Automatic Reply all remains unsupported. The current explicit To/Cc contract is preserved and is not relabelled Reply all.
- Summarize and task extraction are a separate follow-up requiring reusable actual context handoff and truthful task-list intent. A copy-only result would not count as task creation.
- No context-source cards or claims about sources actually used were inferred from the visual mockup. The existing agent context/session/receipt semantics are unchanged.

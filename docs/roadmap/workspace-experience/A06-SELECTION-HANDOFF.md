# A06: selected text enters the existing conversation

2026-10-02. Follow-on to [A05/A06 document presentation](A05-A06-VERIFICATION.md), implementing the bounded frontend portion of DESIGN Document editing and WORKPLAN F03.4–5. Source commits: `3c8483b` plus `1e0c891`. B01 presentation commit `f628dc8` was integrated locally as `9810325` for combined testing; do not cherry-pick that duplicate if B01 is already integrated.

## Behavior

- Plain and live collaborative selection menus expose **Ask agent** and existing bold/italic/code commands. Formatting follows the same editable/comment-only restrictions as the existing toolbar. The collaborative Comment callback and suggestion-review menu remain intact.
- Ask copies the selected unsaved text into an attachment in the **existing** agent composer. It does not send, change the session's permission mode, apply text, create a server session, or replace a prompt draft.
- If the current conversation belongs to a different document (or the vault generally), the user chooses **Attach to current conversation** or **New conversation about this page**. Arrival of a selection alone never switches sessions. Existing drafts remain stored under their existing keys.
- Context stays a typed snapshot, separate from the user's instruction. Existing preview/removal, access checks, send limits and server admission remain authoritative. Captured text does not drift when the source subsequently changes.
- Cmd/Ctrl+J while an AgentClient-backed editor is focused uses this same unsent flow. Legacy shells without AgentClient retain the existing InlinePrompt path. Slash **Ask agent** uses a document snapshot and removes only the explicitly selected slash trigger; it appears only when the editable document has meaningful text outside the trigger and the server advertises snapshot support.
- Repeated activation does not duplicate the same snapshot. Full attachment slots retain a dismissible pending capture until the user removes an attachment. Unsupported snapshot capability disables the selection entry rather than routing it through a different backend.

## Identity and ownership

The existing scoped, memory-only `documentSnapshots` store now carries an editor reference beside its snapshot. There is no second global active-editor registry. Lookup requires exact editor identity, a live editor and the current agent audience. Effect cleanup clears the editor reference only if that instance is still registered; copied text can remain available to the existing capture flow. Editor objects are never serialized.

The pending handoff is memory-only and explicitly bound to scope, destination session/draft and a unique token. A Conversation claims it synchronously once. Changing session or audience invalidates a stale destination; an explicit new-document choice redirects it atomically. Accepted attachment drafts use the existing scoped draft mechanism and its storage-failure warning. This does not add an API field or another chat implementation.

`AgentChat.tsx` changes are restricted to the helper import, a `useSelectionHandoff` call next to resolved conversation state, and a notice immediately before `AgentSnapshotAttachments`. B01–B03 presentation remains owned by the separate frontend stream.

## Exact CollabEditor boundary for backend integration

The A06 selection commit makes this presentation-only change to the existing comment bubble:

1. Import `SelectionActions`.
2. Broaden the existing `editor && canComment` BubbleMenu mount to `editor`.
3. Inside its existing `.cd-bubble`, insert `<SelectionActions editor={editor} allowFormatting={editable && !commentOnly} />`.
4. Wrap the original Comment button in `canComment && …` without changing its callback, range capture, composer state, or command invocation.

Its plugin key, selection predicate, exclusion when the cursor is in a suggestion, and separate suggestion-review bubble are unchanged. Empty action bubbles are hidden by scoped CSS. The earlier outline commit `cbcf46b` separately adds an import and read-only/comment-mode outline immediately before `SuggestionReview`.

**Do not replace CollabEditor wholesale when integrating backend command props.** Apply these small presentation hunks around the backend-owned command/composer wiring. There are no CollabDoc, humanCommands, server, transport, API-type or schema changes here.

## Verification

- **28/28 Chromium/WebKit** combined document, existing snapshot and new selection cases passed.
- **14/14** dedicated selection cases passed again after fixture type corrections; then the two actual collaborative cases passed at **390×844** in Chromium/WebKit.
- Actual `DocumentRenderer` and actual Hocuspocus-backed `CollabDoc`/`CollabEditor` are exercised. View-only collaboration exposes Ask without formatting and leaves body HTML unchanged.
- The new cases verify untouched prompt/mode/session, explicit cross-document choice, preserved old draft, no sends before human Send, captured text remaining unchanged after source edits, scope cancellation, unsupported capability, repeat shortcut deduplication, attachment-capacity recovery, slash behavior and panel remount at phone width.
- Core/web typechecks and a fixture typecheck covering the changed `agent.tsx` and `selection-agent.spec.ts` passed. `git diff --check` passed.
- Broader session/queue regression produced **60/64 passes**. Four WebKit failures concerned existing launcher focus after preview/selection; they were handed to the B01–B03 owner (session row, NoteChip, Attach notes, queued snapshot preview). They are not reported as a green whole-agent suite here; root must integrate and verify those fixes.

Fixtures: [selection-agent.spec.ts](../../../apps/web/e2e-fixtures/selection-agent.spec.ts), optional `?selection` / `?selection&collab` branches in [agent.tsx](../../../apps/web/e2e-fixtures/agent.tsx). Runs used isolated port5191, two workers, no owner credentials or live destinations. Logs are under ignored `apps/server/data/workspace-experience/checks/`: `selection-agent-browser.log`, `selection-handoff-final.log`, `selection-collab-phone.log`, `selection-agent-session-regression.log`, `selection-handoff-types.log`, `selection-fixture-types.log`.

## Fictional screenshots

- [Captured context and preserved composer draft](evidence/a06-selection-handoff/plain-captured-context-phone.png).
- [Actual collaborative selection actions at phone width](evidence/a06-selection-handoff/collaborative-selection-phone.png).

These WebKit captures use390×844 at device scale2. The fixture intentionally stacks a document and composer with test controls; it is **component evidence, not the final mobile Shell design**. Integrated document/companion navigation, real keyboard/PWA behavior and installed-client verification remain release gates.

## Still separate

This slice does not complete the general editor adapter, rich-content schema parity, backend enforcement of human suggestions/comments, or proposal application. It preserves per-session permissions and exposes supported actions; it does not claim the pending backend command enforcement is deployed. No production deployment or native rebuild occurred.

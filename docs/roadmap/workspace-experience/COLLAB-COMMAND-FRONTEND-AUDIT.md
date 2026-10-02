# Collaborative command frontend audit

2026-10-02. Read-only follow-up to the backend handoff at `80295ad`, inspecting its command implementation at `f3abf85`, then re-reading the revised contract and coordination file at `c2bb328`. The canonicalization/hash implementation is unchanged between those tips. No backend changes, command transport integration, deployment or native rebuild. Frontend A06 checkpoint: `1e0c891` plus evidence `388e9a8`.

## Results

Four isolated cases passed: actual `CollabDoc` / `CollabEditor`, Chromium and WebKit, each at desktop and 390×844. These are desktop browser engines with a narrow viewport, not real iOS touch or keyboard tests. The fixture uses Hocuspocus sockets and fictional notes; it does not call the new command HTTP endpoint.

The browser's `editor.state.doc.toJSON()` matched `initProseMirrorDoc(ydoc.getXmlFragment("default"), getSchema(collabExtensions())).doc.toJSON()` for every seeded case. The copied, unmodified backend revision helper produced identical hashes for both representations, including the comments map:

- Empty paragraph after a valid shared fragment exists.
- Heading, Unicode, bold/italic/underline combinations, link defaults and colored highlight.
- Task, ordered and bullet lists.
- Block quote, code block, horizontal rule, hard break and literal wikilink syntax.
- Insertion, deletion and comment marks with their normalized provenance attributes.

There are no client-only nodes. There is one client-only mark type, `wikilink`: its extension adds decorations rather than applying stored marks. Normal wikilink text therefore matched. This does not prove parity for unsupported schema content, manually injected wikilink marks or every future extension; retain a regression check as the shared schema changes.

A fresh **unseeded fixture** exposed a boundary: browser JSON contains an empty paragraph while the shared projection is `{ "type": "doc" }`. Production `contentToYUpdate` already normalizes blank note content through `<p></p>`, so this is not evidence of a production empty-note failure. The command composer should still fail closed before initial sync/seeding, and a production-like empty-note command test is necessary during integration. Do not silently hash a different projection while using browser positions without checking that the coordinate spaces agree.

## Read-only positions

Selecting the displayed paragraph yielded the same ProseMirror range `1..17` and exact quote `Alpha beta gamma` in all four cases. WebKit's native selection string sometimes included trailing newlines; the command must use ProseMirror `textBetween(from, to, "\n", "\ufffc")`, not `window.getSelection().toString()`.

Clicking a character after selecting the passage did **not** reliably collapse the ProseMirror range. Chromium at both sizes and narrow WebKit retained the old `1..17` range even when the DOM selection collapsed. Desktop WebKit moved to `7..7`. ArrowRight did not repair the stale range. Code must not treat the last read-only selection as a current caret merely because the user clicked.

An explicit `editor.commands.setTextSelection(7)` produced `7..7` in every case while `editor.isEditable` remained false. Subsequent typing did not change the document. This establishes a safe selection-only primitive; it is not a recommendation to enable content editing on a read-only socket.

## Bounded frontend proposal for review

1. Derive body editability from the granted level **and** the socket's authorized scope. Keep live reading, presence, outline and selected-text Ask available. A suggest-only user sees an explicit suggestion action, not a text surface whose keystrokes are discarded.
2. Open a suggestion composer from a captured nonempty range. Show the exact selected passage and explicit Replace, Delete, Insert before and Insert after choices. For an empty page expose insertion at the valid first textblock position; provide an explicit page-boundary action if no text is selected. Never infer an insertion caret from stale read-only editor state. Under the revised contract, allow only one fully markable textblock range and single-line suggestion text; show an explanation for inline code, hard breaks, embedded content, cross-block ranges or overlapping review marks. Inspect actual schema mark support as well as node types. Do not silently split one draft into multiple independently committing commands.
3. Capture range, exact quote, body JSON and comments together synchronously while connected and synced, then hash that captured state. Preserve that immutable command body and UUID for outcome-unknown retries. Do not re-read the range after a composer button steals focus.
4. Keep draft text and anchor visible if collaborators change the document. A stale-revision or quote conflict offers explicit re-selection and a fresh command; it must not silently move the draft. Connection or access loss disables submission while retaining the draft.
5. Route new comment, reply, resolve/reopen and permitted deletion through the same command adapter. Use the backend's proposed actor identity endpoint for thread deletion affordances; never derive authorization from email or a client-supplied actor field. Preserve the existing Comment callback until the command integration is deliberately applied. Enforce the separate 4,000-character comment/reply limit; suggestion text and quote each have a 10,000-character limit. Always use the loaded note's real ID, never its title/path alias.
6. Keep success distinct from uncertain durability. Only a confirmed result clears the draft. Retryable errors reuse the exact request. Only trust result IDs from a 200 response: a retry after loss may be a fresh successful application with different IDs and no replay header. After an uncertain resolve/delete followed by 409, refresh thread state because the effect may have persisted. Server-derived messages may be shown, but outcome-unknown, quota and stale-anchor states require different actions.

## Revised contract readiness

At `c2bb328`, the backend's independent security **re-review is still running**; the handoff expressly forbids integration until it says ready. It lists transcript and suggestion branches separately and says a combined branch has not been produced. No reviewed combined tip is available from this handoff. `GET /commands/me` remains an unanswered question there; root has already requested it in main coordination. Do not invent an identity response contract.

The revised errors also require explicit handling for `actor_request_limit`, `too_many_pending_suggestions`, `too_many_threads`, `thread_full` and `document_too_large`. Keep drafts; explain the required review/cleanup or new-thread action rather than displaying an indiscriminate retry button. The rate-limit middleware may return `{ error, retryAfter }` without `message`; the transport needs a safe fallback and Retry-After handling. Refresh authorization on every provider authentication event, key access-change handling on the close reason, and never permit local raw typing while a suggest socket is read-only (those queued edits could otherwise sync after an upgrade).

The evidence here validates representation and selection primitives, not server acceptance of every rich range. The tested code blocks/hard breaks/review marks are hash-parity cases; the revised server deliberately rejects some as suggestion targets. Composer integration must include those negative cases.

Integration ownership must be agreed before editing `CollabDoc`, access rules, command types/transport, `CollabEditor` composer wiring or `CommentsSidebar`. The A06 selection bubble's minimal presentation hunk is documented in [A06-SELECTION-HANDOFF.md](A06-SELECTION-HANDOFF.md). No such integration changes are included here.

## Integration acceptance still required

- Real server command round trips for empty/seeded prose, rich selections, comment-map changes, link guests and signed-in users.
- View cannot submit; suggest uses read-only socket plus commands; edit retains normal editing. Server rejects forged actor fields/raw updates independently of the UI.
- Replace/delete and explicit insertion preserve the original page; stale revision, overlap, access revocation and reconnect retain drafts with accurate recovery actions.
- Dropped responses and uncertain persistence reuse one immutable request; no duplicate suggestions/comments. The backend's orphan-comment retry finding remains owned by the backend stream.
- Keyboard, touch selection, viewport scrolling and focus return in an actual phone/PWA plus desktop browser. Installed-client command transport and capability credentials require separate verification.

## Evidence and reproduction

[Fictional audit results](evidence/collab-command-audit/results.json) include normalized JSON, both hashes and observed read-only positions for every browser/viewport. The probe imports the real editor capture and shared schema, and an exact copy of the backend command hash helper. The unseeded mismatch is recorded rather than hidden; passing assertions concern seeded states, usable ranges and explicit selection-only positioning.

Local ignored scripts and logs are in `apps/server/data/workspace-experience/checks/`: `collab-parity-audit.spec.ts`, `collab-audit-probe.ts`, `backend-command-contract.ts`, `collab-audit.config.mts`, and `collab-audit.log`. Run from the isolated worktree with `npm exec -w @prism/web -- playwright test --config ../server/data/workspace-experience/checks/collab-audit.config.mts --workers=2`. The Vite fixture runs only on port5191. These exploratory scripts are not a shipped command test suite.

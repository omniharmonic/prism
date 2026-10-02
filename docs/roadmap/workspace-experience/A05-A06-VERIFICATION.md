# A05/A06 document presentation verification

2026-10-02. Isolated frontend evidence for the named slices below; **not a production release or complete A05/A06 acceptance claim**. Requirements come from [FRONTEND-ACCEPTANCE](FRONTEND-ACCEPTANCE.md), [DESIGN — Document editing](DESIGN.md#document-editing), [WORKPLAN F03](WORKPLAN.md#f03-document-workbench-and-editor-adapter) and [R03](POST-MIGRATION-PLAN.md).

## Scope and source

| Commit | Delivered slice |
| --- | --- |
| `fd2209a` | Shared breadcrumb/title rhythm, contained writing measure, companion Agent/Details/Activity chrome. Initial visual checkpoint; subsequent commits fix and verify behavior. |
| `5d57c93` | Shared properties disclosure; plain title rename waits for persistence and retains failed draft for retry; Safari mobile launcher restores drawer focus. |
| `5f34ae9` | Shared accessible Formatting entry and browser-local full-toolbar preference; mode/review controls stay visible independently. |
| `2acf081` | Shared optional headings popover, live heading updates, same-editor navigation, plain read-only mount. |
| `cbcf46b` | Read-only/comment-mode collaborative outline mount and focused verification. |

Apply in the order shown. `f4764d3` only merges reconciliation documentation; it is not a source dependency. `CollabEditor.tsx` changes in the last commit are limited to one import and a conditional presentation wrapper immediately before `SuggestionReview`. Its props, effects, command/composer/review wiring and serialization remain unchanged. No server, transport, CollabDoc host, shared API or schema changes belong to this slice.

## Requirement and evidence

| Requirement | Evidence | Limit |
| --- | --- | --- |
| A05: quiet, shared page hierarchy and useful properties | Both actual plain and live collaborative hosts render the shared header. Location expands in place; plain host also shows tags/updated time and links to its existing complete properties panel. Desktop and 390px captures below. | CollabDoc currently supplies only location to shared chrome. Tags/date parity requires a coordinated host change. |
| A05: recoverable title edits | Fixture rejects plain rename; draft remains visible/focused, previous path remains authoritative, retry succeeds. Existing keyboard cancel/rename test remains green. | CollabDoc still returns void and optimistically updates its path while swallowing persistence failure. This slice does not establish successful/error-safe collab rename. |
| A05: preserve writing and specialist layouts | Property expansion and breakpoint transitions keep the same editor DOM. Existing workspace cases retain unsaved text, autosave timing, live threads and focused canvas ownership. | No new spreadsheet/code engine parity claim; only document chrome measure is constrained. |
| A06: quiet formatting with explicit full-toolbar preference | Default collapsed Formatting button exposes existing commands. Selected-text bold works in both editors. Preference persists through reload and is shared between live and plain hosts; temporary collapse does not erase it. | Local appearance preference, not a server/account setting. Selection Ask/Comment work remains below. |
| A06: permissions and review remain visible | Actual collaborative host keeps Editing and bulk review available with formatting collapsed. Switching host response to view-only removes formatting/rename controls while retaining readable properties and outline. | Server enforcement and human suggestion command ownership remain backend work. |
| A06: optional outline, preserved selection/scroll | Opening does not move selection or scroll; Escape works with editor focus and returns focus to launcher. Choosing a heading scrolls the existing DOM without a document transaction. Heading edits update labels; no-heading text gets an honest empty state. | No persistent side pane is added; DESIGN explicitly permits a popover. |
| A06: read-only heading navigation | Real Hocuspocus-backed host is reloaded as view-only; outline navigation leaves body HTML unchanged. | The isolated server supplies test authorization only; this is frontend behavior evidence. |

## Test record

- Chromium + WebKit: **38/38** combined `workspace.spec.ts` / initial `document-polish.spec.ts` cases after toolbar integration.
- Chromium + WebKit: **8/8** final expanded `document-polish.spec.ts` cases after outline, empty-state, Escape and read-only assertions.
- Final `npm run typecheck -w @prism/core -w @prism/web`: passed.
- `git diff --check`: passed before commit.
- Actual collaborative fixture uses a local Hocuspocus server and real `CollabDoc`/`CollabEditor`, not a static PageHeader substitute.
- No owner credentials, production provider sends, native rebuild, deployment or production-state writes were used.

The isolated run used fixture port **5191**, two workers, Chromium Desktop Chrome and WebKit Desktop Safari. Its ignored config is `apps/server/data/workspace-experience/checks/document-polish.config.mts`; it imports the normal web Playwright config, substitutes baseURL/server port5191, and adds the WebKit project. Final browser output is `document-polish-outline-browser.log`; final type output is `document-polish-outline-types.log` beside that config. The committed scenario source is [document-polish.spec.ts](../../../../apps/web/e2e-fixtures/document-polish.spec.ts).

```sh
npm exec -w @prism/web -- playwright test \
  --config ../server/data/workspace-experience/checks/document-polish.config.mts \
  document-polish.spec.ts --workers=2
npm run typecheck -w @prism/core -w @prism/web
```

## Fictional visual evidence

Captured from the final isolated source at `cbcf46b`. Desktop viewport1280×720, phone390×844; WebKit exports at device scale2. Dark screenshot disables CSS animation during capture. These are fixture captures, not mockups or private production data. The surrounding navigation is this branch's older shell, so its Inbox label/arrangement is **not** evidence for the parallel navigation redesign. Agent unavailable in the plain fixture is deliberate: this fixture does not supply an agent service.

| Capture | What to inspect |
| --- | --- |
| [Plain desktop](evidence/a05-a06-document-polish/plain-desktop-chromium.png) | Calm title, breadcrumb, expanded metadata and quiet formatting entry; existing companion tabs remain accessible. |
| [Plain phone](evidence/a05-a06-document-polish/plain-phone-webkit.png) | Full-width title and wrapping property values without horizontal page overflow. |
| [Collaborative desktop](evidence/a05-a06-document-polish/collaborative-desktop-chromium.png) | Shared title/location treatment with real presence/status/comment and separate mode/review controls. |
| [Collaborative phone](evidence/a05-a06-document-polish/collaborative-phone-webkit.png) | Long title wraps; controls form coherent rows instead of squeezing the title or hiding review behind formatting. |
| [Outline desktop](evidence/a05-a06-document-polish/outline-desktop-chromium.png) | Optional heading hierarchy over the same writing surface. |
| [Outline phone, dark](evidence/a05-a06-document-polish/outline-phone-dark-webkit.png) | Touch-sized heading targets, constrained popover and readable dark surface. |

Against boards01/12 and the desktop-collaboration reference: the page has a clear title/metadata/body hierarchy and less permanent formatting noise. Board01's heading navigation is implemented as the explicitly permitted popover. Companion chrome is quieter, but this slice does not claim fidelity of the conversation body, source picker or proposal review screens.

## Remaining acceptance, explicitly open

- A05: coordinated collab rename error handling and richer metadata; production web/installed-client verification belongs to root's integrated release.
- A06: selection Ask agent and relevant formatting, capability-aware Comment, and slash/shortcut entry into the same durable session flow remain separate work. Existing one-shot InlinePrompt behavior is not equivalent to that requirement.
- F03 editor adapter/schema parity, guest/governed mutation restrictions and backend human-suggestion enforcement are not completed by these presentation changes.

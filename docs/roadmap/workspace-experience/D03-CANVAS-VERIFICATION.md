# D03 canvas presentation checkpoint

2026-10-02. Source commit `6ac160a`. Implements the bounded canvas portion of FRONTEND-ACCEPTANCE D03 / R10.1, R10.4–5 against the approved `assets/19-canvas-graph.png` board. GraphExplorer remains a separate frontend stream; saved exploration, backend relationship cleanup and large-graph performance are not included.

## Changes

- Grouped canvas controls with a quiet heading in the plain renderer. The embedded collaborative renderer uses its existing outer `CollabDoc` PageHeader; it only adds a Canvas heading in focused fullscreen mode. Host inspection confirmed the PageHeader immediately precedes the canvas container. No CollabDoc changes were needed.
- The drawer launcher is now **Add notes**, matching the board and distinguishing it from **Browse cards**. Expanded/pressed states are exposed to assistive technology. Copy preview remains explicit, with its existing explanation of copied content and canvas visibility.
- Note picker and touch-friendly card list use clearer rows, note icons, search focus, quieter borders and grouped actions. Phone buttons and the custom-styled native tag select have at least 44px targets. Drawer scrolling retains native vertical touch behavior.
- New cards have neutral backgrounds, restrained category borders and 14px text instead of 12px. Canonical scene colors let Excalidraw perform its own dark-theme mapping; pre-darkening them caused a second inversion. **Previously saved element colors, text, layout and identities are not migrated or restyled.**
- A scoped fix prevents the global `.interactive:hover/:active` row style from giving Excalidraw's transparent overlay canvas an opaque background. This was masking intact drawings when the pointer entered the canvas, including after closing a drawer. Regression cases now assert transparency on hover and press.
- Scoped Excalidraw theme variables align drawing-tool accents with Prism and restore dark toolbar icon contrast. Every new CSS selector is rooted in canvas-specific classes; there are no global stylesheet changes.

The card remains Excalidraw's existing rectangle with bound text. It does not become a DOM document editor with independent title typography or rich property chips. The board's separate Connect notes action is not fabricated: the existing arrow tool and selected-arrow **Link this arrow to notes / Decorative arrow** control retain their actual semantics.

## Preserved behavior

No changes to scene/Yjs reconciliation, save callbacks, access checks, relation synchronization, provider/presence behavior or backend commands. Focus mode expands the existing mounted editor. Showing stored relationships still produces decorative preview elements excluded from authored scene serialization; toggling an authored arrow to decorative retains its drawing. Picker and card-open actions still perform fresh access checks, and late responses from a changed audience are discarded. Read-only canvas retains Browse cards and Focus canvas without mutation controls.

## Verification

- **40/40 Chromium/WebKit** existing canvas plus new visual journeys passed across plain CanvasRenderer and actual CollabCanvas/Excalidraw backed by a fixture Y.Doc.
- **12/12 visual journeys** re-run after the final palette, drawing-tool and filter refinements cover desktop, 390×844 phone and dark appearance in both implementations.
- Existing checks cover failed selection retention, denied previews, audience changes, fresh read-only source access, scene identity through focus mode, relationship acknowledgement/retry, and authored/decorative arrow preservation.
- New checks cover toolbar state, embedded title suppression, phone hit targets and page width, note search/add, card-list navigation and focus restoration. WebKit fullscreen height is checked within one pixel: its `100dvh` result was 843.984375 for an 844px viewport, not a layout overflow.
- Core and web typechecks, changed canvas fixture typecheck and `git diff --check` passed. React review found no new lifecycle effects, subscriptions, editor recreation or data-fetching paths.

These are isolated component/browser fixtures, not production or installed-client verification. The collaborative fixture mounts the real CollabCanvas with a local Y.Doc; it does not exercise multi-peer network convergence or full CollabDoc authentication. The outer host was inspected to prevent duplicate title chrome. Root still owns integrated shell, real phone/PWA touch/keyboard and release checks.

## Fictional visual evidence

WebKit captures are in [evidence/d03-canvas](evidence/d03-canvas): plain and collaborative variants each include desktop, phone and dark drawer/scene images. Representative captures:

- [Plain desktop drawer](evidence/d03-canvas/plain-desktop-drawer.png)
- [Plain phone drawer](evidence/d03-canvas/plain-phone-drawer.png)
- [Collaborative dark drawer](evidence/d03-canvas/collab-dark-drawer.png)
- [Plain desktop scene](evidence/d03-canvas/plain-desktop-scene.png)

The screenshots show real fictional fixture content. The scene capture follows card navigation, drawer closing, and hover/press transparency checks. Existing preview-arrow routing can overlap tightly adjacent card text; this is a remaining canvas layout/readability issue, not a new relation behavior change or a claim of full board fidelity.

Run the focused suites with `npm exec -w @prism/web -- playwright test canvas.spec.ts canvas-visual.spec.ts --config ../server/data/workspace-experience/checks/document-polish.config.mts --workers=2` from the isolated worktree. Local ignored logs: `canvas-polish-final.log`, `canvas-polish-visual-final.log`, `canvas-polish-types.log`, `canvas-web-types.log`, `canvas-fixture-types.log`. Fixture server uses port5191 only. Nothing was deployed or installed.

# A03: contextual page creation

Date: 2026-10-02. Isolated implementation on `feat/page-creation`; no production changes. The creation component is tested and ready for integration. **A03 is not fully accepted/released:** the current shell, command, and tree entry points still need integration verification; physical mobile keyboard, browser text zoom, and installed-client checks remain.

## Requirement traceability

| Source | Requirement | This slice |
| --- | --- | --- |
| DESIGN mobile navigation; WORKPLAN F02.7; board 14 | New and open documents stay easily reachable on mobile. | Creation defaults to Page and works at phone width. Root owns navigation entry placement. |
| DESIGN controls / accessibility; WORKPLAN F01 acceptance and F02 | Quiet hierarchy, 44px touch targets, keyboard focus, light/dark parity. | Title-led card, explicit format/location rows, native modal, controlled Tab traversal, Escape/close/focus return, full-width mobile primary action. Reviewed screenshots below. |
| DESIGN feature preservation; F03; POST-MIGRATION R03 | Preserve specialist formats and document serialization. | All nine choices remain; existing CONTENT_DEFAULTS, TaskCreateDialog and ComposeMessage are reused. Created document edits survive fixture reload. |
| WORKPLAN client seams; POST-MIGRATION architecture | Work through the injected vault client in web and native hosts. | Location discovery uses `client.listTree()`, replacing desktop-only `useVaultPaths`; no optional HostServices or agent provider required. |
| Latest user clarification; FRONTEND-ACCEPTANCE A03 | Title first, current location inferred, no required raw path entry. | Optional title, readable location, searchable existing folders, caller-supplied tree context. This is a refinement, not a previously explicit requirement. |

Board 14 shows an already-open Untitled document, not a creation dialog. This card is an implementation interpretation of that workflow. A blank title requires only Create page and yields Untitled; typing a title is optional.

## Behavior and integration contract

`packages/core/src/components/navigation/NewContentMenu.tsx` exports:

```ts
interface NewContentMenuProps {
  onClose: () => void;
  initialFolder?: string;
  initialType?: ContentType;
  returnFocus?: HTMLElement | null;
}
```

- Without overrides, default Page in the active real note's parent folder. Virtual tabs or unavailable tree metadata use Vault home with an explicit folder-load warning/retry when appropriate.
- `initialFolder` is a raw vault-relative folder, including a literal `vault/` prefix when present. An empty string explicitly means root. Tree callers must pass a folder, not a leaf note path.
- `initialType` preserves direct specialist entry. Task/Message continue their dedicated workflows. Page, Canvas, Spreadsheet, Presentation, Code file, Dashboard and Website use existing content defaults.
- `returnFocus` restores the actual opener, including Safari pointer activation. Alternatively focus the opener explicitly before mounting. Escape propagation stops inside creation so a containing mobile navigation dialog stays open.
- QueryClient and VaultClient providers are required. No desktop command or optional agent/host provider is introduced. Changing audience/vault closes the form; a late response cannot open a tab in the new audience.
- Pending creation resists repeated activation and accidental dismissal; failed creation retains the title and location. Folder search Enter cannot submit the page. Resizing preserves the current draft.
- Titles cannot contain path separators or traversal names. Existing names get readable `(2)`, `(3)` suffixes after a fresh metadata read. This avoids known duplicates; it is **not** a server-level atomic uniqueness or unknown-outcome/idempotency guarantee.

`packages/core/src/components/navigation/newContent.ts` exports pure helpers for other creation entry points:

```ts
newContentFolder(entries, activeNoteId): string
newContentFolders(entries): string[]
newContentParams(type, title, folder, entries): { title, params: CreateNoteParams }
folderLabel(folder): string
validFolder(folder): boolean
```

The helpers never write. `newContentParams` preserves CONTENT_DEFAULTS and sets the confirmed display title in metadata. Reuse it where appropriate, but keep Task/Compose routing and server permission enforcement intact. Navigation, CommandBar and ProjectTree are intentionally unchanged by this branch.

## Verification evidence

`apps/web/e2e-fixtures/page-creation.spec.ts`: **13 Chromium + 13 WebKit journeys passed** against an isolated in-memory VaultClient on port 5193, with fictional notes and persistence in the fixture browser's localStorage. No production account, vault or service was used.

Covered: contextual create → real DocumentRenderer edit → autosave → reload; blank title and known duplicate; folder search; pending/double activation; failed-create draft retention; audience switch and late response; virtual/legacy/no optional provider hosts; explicit folder and invalid title; tree discovery failure/retry; all nine entry types and specialized defaults; light/dark desktop/phone and resize preservation; keyboard loop; harmless folder-search Enter; 640×360 CSS viewport reflow; nested-dialog Escape and focus restoration.

Passed: core typecheck, web typecheck, e2e typecheck, `git diff --check`.

Reproduce using the existing fixture Playwright config with `page-creation.spec.ts`; use one isolated Vite fixture server and run Chromium/WebKit sequentially. Local full logs/configs are in ignored `apps/server/data/workspace-experience/checks/page-creation*`. The tracked spec contains behavioral assertions and screenshot generation.

Reviewed actual screenshots, not only test assertions:

- [Desktop light](assets/evidence/a03-page-creation/creation-desktop-light.png)
- [Desktop dark](assets/evidence/a03-page-creation/creation-desktop-dark.png)
- [Phone light](assets/evidence/a03-page-creation/creation-phone-light.png)
- [Phone dark](assets/evidence/a03-page-creation/creation-phone-dark.png)
- [Small viewport, scrolled primary action](assets/evidence/a03-page-creation/creation-reflow.png)

Visual review corrected the global input-font override, dark primary-button contrast and mobile footer alignment. The normal phone and desktop frames have readable hierarchy and unobstructed controls. The short viewport scrolls inside the dialog; the screenshot intentionally shows the primary action after scrolling, not every control simultaneously.

## Remaining acceptance gates

1. Root integrates and tests actual Shell mobile/desktop New, tree-folder entry and CommandBar paths, including nested navigation Escape and specialist preservation. The isolated nested-dialog fixture does not prove current Shell wiring.
2. Verify on production web and installed Prism Client after integration. This branch does not claim either was deployed or tested.
3. Verify actual mobile software keyboard/IME, safe areas and OS/browser text zoom. A CSS `zoom:2` experiment clipped the native dialog and is not a valid browser-zoom acceptance result; it was replaced by accurately labelled reduced-CSS-viewport coverage. Do not infer physical device or 200% browser text-zoom acceptance from Playwright viewport emulation.
4. Preserve honest server errors and existing access policy. Atomic path uniqueness and reconciliation after an unknown create outcome belong to the backend contract; no new guarantee was added here.

Rollback: revert this source commit; no schema, migration or stored-format change is required.

# Frontend-first delivery pass

**Execution detail:** [FRONTEND-ACCEPTANCE.md](FRONTEND-ACCEPTANCE.md) now maps each screen to the original approved requirement, existing code, remaining gaps and acceptance. This short priority note is not a replacement roadmap.

The owner's 2026-10-02 correction sets the immediate priority: implement the approved visual direction, not more backend scope. `MOCKUPS.md` and its images remain the visual references; current contracts remain the functional boundaries. Backend follow-up has its own `BACKEND-HANDOFF.md`.

## Visible work, in order

1. **Writing shell:** workspace/vault identity at the top; Search, Messages and Agent as primary destinations; Favorites and Pages as the center of navigation; Recent and specialist Tools disclosed; labeled New page; quiet settings entry. Keep tabs, keyboard access, all existing tools and vault authority intact.
2. **Creation:** title first, sensible parent location from the active page, optional searchable location picker, no mandatory raw path entry or timestamp-filled visible title. Retain specialist content types and their existing workflows. Errors preserve the form; repeated clicks do not create duplicates.
3. **Messages:** master/detail hierarchy, readable sender names and avatars, comfortable multiline bubbles, one coherent thread header, subdued filters/tags, stable history and composer. Mobile gets one primary surface with no horizontal overflow or overlaid compose controls.
4. **Documents and agent:** deliberate title/body measure, quieter breadcrumb and properties row, fewer competing borders/actions, polished companion tabs. Preserve editor mounting, live collaboration, pinned sessions, permissions and unsaved drafts. Keep specialist renderers wide.
5. **Workspace definition:** explain the workspace/vault relationship in plain language; name-first setup and progressive disclosure of hosting details; easy access from the selector. Do not invent a new access model or expose a disabled backend feature as working.

## Acceptance

For each surface capture the real fixture UI on desktop and 390px mobile in light and dark modes as relevant; compare directly with mockups 01, 07–10, 14, 15 and the document/agent overview. A typecheck alone cannot close a design task. Exercise preserved actions, focus, long names, empty/error states and responsive editor/draft continuity.

Merge reviewable, tested frontend commits in a batch, then build web/native once. Verify private production writing/creation and messaging display in web and the installed desktop app. Do not repeatedly redeploy the backend or make the owner reapprove Keychain for each small aesthetic change. The full roadmap remains in progress, with backend ownership explicitly handed off.

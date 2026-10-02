# Workspace setup and invitation evidence

Date: 2026-10-02. Frontend slices `40df2f5` (D09 workspace setup) and `5ca070a` (D05 access/invitations), developed on `feat/workspace-settings` from `f495ee8`. These checks used fictional data through the real sharing seam and NetworkRenderer; no production accounts or invitations were used.

## Scope and original-plan mapping

D09 in FRONTEND-ACCEPTANCE maps to R03.1/R14 plus the user's later clarification that workspaces should be easy to define. Name-first setup and optional address disclosure implement that refinement using existing workspace entities and vault assignment. They do not add a new workspace/folder model or change membership permissions.

D05 maps to R12.1–5: distinguish invitations, document access and management roles; show accurate mutation outcomes. This slice improves the existing access and members panels, including their known partial-success and clipboard failures. It does not complete the entire sharing/governance roadmap, add effective-access preview, or enforce the human suggest-only ceiling.

Board 15 was inspected as a reference for readable settings grouping, familiar labels, spacing and mobile layout. It shows Appearance settings, **not** workspace creation or an invitation flow. These screenshots are implemented frontend evidence, not a claim of literal parity with an absent invitation/governance board.

## Implemented and preserved

- **Workspace setup:** labelled name-first form; custom address under an optional disclosure; loading/error/retry; readable workspace/vault cards; selected source/destination preview and explicit Move button. Choosing a vault alone does not mutate anything. Address, move and delete payloads retain the existing seam. Default-workspace protection and deliberate deletion remain.
- **Invitations:** a returned private invitation stays visible in a selectable field. Copy success is shown only after the Clipboard API confirms it; failure gives manual-copy guidance. The UI never claims email delivery.
- **Access:** human-readable levels; accurate active-vault vs cross-vault terminology; unchanged role/tag/vault/revoke methods. Can suggest and comment limitations are disclosed. No server permission guarantee was added.
- **Partial outcomes:** a confirmed vault grant is preserved before the optional management-role call. A failed role update retains the invitation and offers role-only retry. A confirmed grant removal followed by role-removal failure likewise retries only the role stage. The UI does not present these separate requests as an atomic transaction.
- **State safety:** mutation locks prevent duplicate activation, failures retain relevant form drafts, and actor/vault changes reset drafts/receipts. Late responses are ignored and the next management-role call is not sent after scope changes. Existing server-owner/admin gates are exercised through the actual NetworkRenderer.

## Test evidence

| Slice | Chromium | WebKit | Coverage |
| --- | --- | --- | --- |
| D09 `workspace-setup.spec.ts` | 6 passing | 6 passing | Name-only payload; explicit move; failure/draft retention; pending double activation; address save; deliberate delete/default protection; read retry; late actor result; guest/absent seam; 390px dark layout. |
| D05 `workspace-access.spec.ts` | 7 passing | 7 passing | Clipboard denial/manual selection/confirmed copy; grant+role partial success; role-only add/remove retry; pending actor switch suppresses role follow-up; member invitation error/draft/duplicate handling; existing role/tag/vault/revoke payloads and failures; guest/absent capability; late member invitation scope switch. |

Core typecheck, scoped types for both new fixture sets, and `git diff --check` passed. Aggregate e2e typecheck on base `f495ee8` had unrelated errors in `agent-lifecycle.tsx` (incomplete AgentClient assertion) and `messages.tsx` (nullable metadata); these were reported to the owning agent rather than silently changed here. The successful scoped check does not claim the aggregate check passed.

The tracked fixture specs reproduce the journeys using an isolated fixture server; local configs/logs were retained in ignored `apps/server/data/workspace-experience/checks/workspace-{setup,access}*`. Screenshot review used real rendered output and corrected the desktop capture to show the form rather than the lower scrolled move card.

## Reviewed screenshots

- [Workspace setup, desktop light](assets/evidence/workspace-settings/workspace-setup-desktop.png)
- [Workspace setup, phone dark](assets/evidence/workspace-settings/workspace-setup-phone-dark.png) — WebKit at 390 CSS px; image has device pixel scaling.
- [Invitation and access, desktop light](assets/evidence/workspace-settings/workspace-access-desktop.png)
- [Member invitation, phone dark with blocked clipboard](assets/evidence/workspace-settings/workspace-members-phone-dark.png)

The dark phone invitation retains a visible manual-copy route without horizontal page overflow. The desktop view separates the confirmed outcome, invitation and next form. These are viewport captures of scrollable settings; not every section is simultaneously visible.

## Remaining gates

Root integration, production web, installed desktop and physical mobile keyboard/IME verification remain separate acceptance steps. The complete D05 roadmap also requires its promised sharing/governance boards and backend authorization/preview work. No schema, API contract, server, provider or production data changed in these commits. Rollback is a source revert.

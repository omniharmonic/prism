# Prism collaborative workspace redesign

**Status: approved and in progress. Frontend execution is being reconciled screen by screen against the approved plan; see [FRONTEND-ACCEPTANCE.md](FRONTEND-ACCEPTANCE.md). [CURRENT-RELEASE.md](CURRENT-RELEASE.md) records deployed artifacts; [BACKEND-HANDOFF.md](BACKEND-HANDOFF.md) separates unfinished backend work for another agent.**

The current plan follows the rebuilt server/client architecture and the expanded vision: a minimalist workspace for documents, human and agent collaboration, canonical people and conversations, meetings, semantic knowledge, tasks, canvas/graph, governance, publishing, and integrations. Web/mobile PWA and the new thin `apps/client` desktop app are the primary clients.

The agent is a collaborator whose permissions you control. Every chat session will independently support **Read-only**, **Suggested edits only**, and **Read/write**, with persistent settings and server-enforced transitions. The brand direction is **many colored beams entering a prism and one unified ray leaving it**.

## Current reading order

| Document | Purpose |
| --- | --- |
| [POST-MIGRATION-PLAN.md](POST-MIGRATION-PLAN.md) | Authoritative R00–R16 implementation plan: exact changes, code areas, dependencies, acceptance and rollback |
| [ARCHITECTURE-AUDIT.md](ARCHITECTURE-AUDIT.md) | Source-backed findings, delivered capabilities to reuse, and remaining risks |
| [DOMAIN-CONTRACTS.md](DOMAIN-CONTRACTS.md) | Additive contracts for scope, identity, messages, agent permissions/context, collaborative review, relationships and views |
| [BRAND.md](BRAND.md) | Prism identity, icon variants, asset inventory and interface application |
| [RELEASE-GATES.md](RELEASE-GATES.md) | Actual audit test results, feature ledger and required production web/PWA/desktop verification |
| [MOCKUPS.md](MOCKUPS.md) · [Visual gallery](mockups.html) | Nineteen existing concept images; additional expanded-scope boards are scheduled in R02 |

## Audit baseline

Prepared 2026-10-01 against `29d18b3`, incorporating and retesting the host verification fix at `55de600`. All 1,329 isolated server tests, application typechecks, 18 host-service checks, 15 agent checks, and event/media checks pass. These are baseline results, not production verification or evidence that the redesign has been implemented.

The migration now supplies durable sessions, live agent suggestions through the existing Yjs document, server-side sync/calendar/skill services, and native media/map proxies. The plan reuses those foundations. Remaining priorities include scoped offline writes and conflict recovery, complete message rendering, reliable canonical-person matching, per-session agent permissions, transcript linking, and durable canvas relationship reconciliation.

The migration documentation reports live actions enabled in production; the audit did not independently exercise deployed provider actions. Final deployment configuration and any later migration changes are reconciled in R00.

## Execution boundary

The user approved implementation on 2026-10-01. The original audit and concept images were planning deliverables; implementation and controlled releases have since occurred. On 2026-10-02 the user requested frontend priority, backend handoff and systematic execution of the original scope. The acceptance matrix maps that scope to current code and remaining work.

Implementation proceeds in tested vertical slices with regular focused commits. Completion requires the feature ledger and real production web/PWA/desktop evidence in RELEASE-GATES.md; screenshots and passing unit tests alone are insufficient.

## Earlier design work retained for reference

The following documents were authored against pre-migration snapshot `c191b52`. Their detailed interaction cases remain useful, but **the current plan above supersedes their sequencing, runtime assumptions, authority boundaries, and agent-mode terminology**. In particular, earlier Ask/Suggest examples do not restrict the newly requested three per-session permission modes. No duplicate backend implementation should be inferred from an old F package.

| Earlier document/package | Current home |
| --- | --- |
| [WORKPLAN.md](WORKPLAN.md), F00 | R00–R01 handoff, baseline and integrity |
| [DESIGN.md](DESIGN.md), F01–F03 | R02–R03 brand, shell and document UX |
| F04–F05 document agent/review | R06–R07 with all three permission modes; R12 governance |
| [MESSAGES.md](MESSAGES.md), F06–F08 | R04–R05 identity, history, rendering and sends |
| F09 related context/search | R09–R11 connected knowledge, graph/canvas and views |
| F10–F11 mobile/release | R15–R16 cross-client completion and production validation |
| [CONTRACTS.md](CONTRACTS.md) | DOMAIN-CONTRACTS.md and actual migrated services |
| [VALIDATION.md](VALIDATION.md) | RELEASE-GATES.md; retain useful detailed UI scenarios |
| Expanded product scope | R08 calendar/transcripts, R12 guests/governance, R13 publishing, R14 integrations |

The existing images use fictional content and are concepts, not current app screenshots. Their generated prism marks are placeholders. The corrected brand and missing expanded-scope screen boards will precede their implementation slices.

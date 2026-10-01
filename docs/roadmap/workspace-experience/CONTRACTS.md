# Backend contracts for the workspace experience

> **Historical design reference (2026-09-30, pre-migration `c191b52`).** The [post-migration plan](POST-MIGRATION-PLAN.md), [current contracts](DOMAIN-CONTRACTS.md), and [release gates](RELEASE-GATES.md) supersede runtime assumptions, sequencing, and authority statements below. Retain applicable interaction details. Each agent session now supports **Read-only, Suggested edits only, and Read/write**; earlier Ask/Suggest examples are not a restriction. Concept logos are placeholders pending [BRAND.md](BRAND.md).

Status: proposed additive contracts. Names are illustrative until F00 maps them to the completed architecture v2 APIs. This document does not authorize a new runtime, second auth system, direct browser vault access, or a replacement ingest pipeline.

## Ownership and handoff

| Capability | Architecture v2 owner | What this plan adds |
| --- | --- | --- |
| Process isolation, model admission, queue, budgets | WP0.1, WP3.1, WP3.4 | User-visible states and actionable errors, using the existing semantics |
| Sessions, turns, events, replay, transcript mirror | WP3.1 | Document binding, context provenance, composer drafts, per-session visibility rules |
| AgentClient and full/panel chat | WP3.2 | One shared controller for panel, mobile sheet, full session view, and inline requests |
| Push and notification routes | WP3.3, WP5.3 | Correct deep-link landing and restoration of the working document |
| Native origin/auth/cache/SSE transport | WP2.1–2.2 | Capability-driven UI, account/vault cache isolation, draft/reconnect polish |
| Permission-aware notes and tools | WP6.1–6.2 | Server-validated context references and truthful source display |
| Collab-safe updates, comments, suggestions | WP6.3 | Shared browser review endpoints or adapters over the same domain services |
| Governance and sharing | WP0.2–0.3, WP6.4–6.5 | Preserve capability distinctions and avoid inheriting transcript access from document sharing |
| Gmail/Matrix ingest, people links, send/react routes | WP1.2, WP1.5 | Paginated read model, archive traversal, delivery identity, normalized sender/body records |
| Tree projection and invalidations | WP7.1–7.2 | Conversation summaries and precise refresh behavior; no new high-frequency polling |

If a feature already ships upstream, extend it in place and add acceptance coverage. If it is deferred, record the dependency and disabled UI behavior. The documentation status of an upstream work package is not a runtime capability signal.

## Capability discovery

Extend the existing server/client capability mechanism where available. If none exists, add a small authenticated capability response under `/api` rather than scattering `useIsWeb()` checks or probing privileged actions.

It should distinguish actor authorization, service configuration, source connectivity, and version support. Required concepts include agent availability/modes, suggestion review, message reading/replying/media, version history, and offline support. Include a stable reason code for unavailable actions. Permissions remain enforced at action time regardless of what the response advertises.

Derive the UI from capabilities, not from “web” versus “desktop”: architecture v2 makes both clients of the same server. An anonymous publication cannot obtain owner runtime or integration capability details. Re-fetch after auth/vault changes and when a forbidden response invalidates a previously available action.

## Document conversations

Extend upstream session metadata or its binding model with:

| Field or concept | Semantics |
| --- | --- |
| Session owner and visibility | Owner-private by default; document access alone does not grant transcript access |
| Server and vault identity | Explicit stable identity, validated server-side; all lookups and caches use it |
| Working document | Stable note ID plus optional title for display; rename never changes binding |
| Context references | Explicit note/message/selection references supplied for a particular turn |
| Mode | Ask or Suggest; maps to enforced tool permissions, not just prompt wording |
| Client turn ID | Idempotency key for double-clicks, retries, and reconnects |
| Last event sequence | Upstream replay cursor; duplicate delivery is harmless |
| Proposal references | IDs for reviewable changes returned by the shared proposal service |

One document can have several sessions; opening Agent resumes the user's last accessible session by default. Store per-user selection separately from canonical document content. A session bound to a deleted or inaccessible note stays navigable only if the actor can still access the session, with a clear unavailable-target state.

The existing `agent_sessions/agent_turns/agent_events` are authoritative for execution and committed conversation state. The upstream vault mirror is a searchable/auditable projection. Do not independently edit both. Mirror updates need idempotency and version/order handling; a delayed mirror cannot roll back the runtime transcript. Keep transcript mirrors private by default and out of dynamically shared tag collections unless intentionally granted.

Drafts are a separate concern: persist the composer draft locally immediately, scoped by origin/actor/vault/session. Add a small authenticated draft record to the upstream session store if cross-device unsent-draft continuity is required. Use revision checks; concurrent device drafts surface a recoverable conflict instead of last-write-wins text loss. Do not broadcast unsent drafts through shared Yjs awareness or the vault transcript mirror.

## Context envelope

Each turn carries a bounded context envelope alongside the prompt:

- Working-document ID, content kind, and known server/collab baseline.
- Current-draft snapshot or selection snapshot when relevant, marked as unsaved where applicable.
- Selection anchor with selected-text digest and surrounding context; use the editor's supported stable positions for live documents.
- Explicit source references, plus retrieval scope within the active permitted vault.
- Mode, requested target, and context limits.

The server validates every reference, bounds payload sizes, and resolves source content through the same authorization layer as human reads. A supplied note ID does not authorize access. Treat source text as data rather than executable instructions. The actor and writable target are server-derived, not accepted from model output.

The returned provenance records what was actually read: source ID/kind, accessible title, revision/time, relevant range or excerpt, and completeness. A preview can be omitted when it would leak inaccessible content. Do not include entire unrelated documents in events just to produce a source chip. Recheck source access when opening citations and define revocation behavior for stored snapshots.

For this release, owner-private sessions avoid accidental disclosure from mixing sources with different grants. Broadly shared conversations require a separate explicit policy for derived content; do not assume access to the working document authorizes everything retrieved during its conversation.

Live drafts deserve special handling. The agent may discuss a supplied unsaved draft, but accepting an edit against that draft requires a corresponding synchronized baseline or an explicit reconciliation step. Do not use the vault's older `updatedAt` as proof that the live Yjs text still matches the supplied snapshot.

## Events and reconnection

Consume the upstream AgentEvent format. Add variants only when information cannot be represented already. UI needs concepts equivalent to session/turn state, text deltas, tool start/result, source use, proposal availability, usage/limits, and terminal error/completion.

Every event has stable session, turn, and sequence identity. Normalize transport events once in AgentClient; the sheet and full view cannot maintain independent transcripts. Retain a contiguous cursor, ignore duplicates, and detect gaps. If replay retention has expired, fetch a current snapshot and restart from its cursor.

Disconnect means “reconnecting”, not “task cancelled”. Cancellation is an acknowledged server transition and may race with completion. The view must accept the authoritative terminal outcome. A stopped turn can leave completed external actions or accepted proposals; cancellation does not roll them back.

Serialize mutating turns per conversation and reuse upstream queue/admission controls globally. A follow-up has a new client turn ID and fixed context envelope. If editable queued turns are supported, update/cancel them conditionally against queue state so an already-started request cannot be rewritten. For Stop and refine, wait for a terminal result and reconcile completed actions before starting the next turn. When queue support is absent, the UI retains an unsent draft instead of reporting it as submitted.

Use the upstream fetch-based stream helper so device-token clients and browsers share behavior. Coalesce text updates to avoid rerendering the entire editor per token. Subscribe to general vault invalidations through WP7.2, not one new poller per document/message view. SSE payloads and logs must retain upstream redaction and size bounds.

## Proposal and editor service

Reuse WP6.3's suggestion and collab-safe mutation services. Browser HTTP handlers and Prism MCP tools must call the same domain operations, permission checks, and idempotency logic. If upstream only exposes MCP wrappers, extract the underlying service and add a browser wrapper; never have the browser call vault MCP with an owner token.

A proposal needs these concepts:

| Field | Purpose |
| --- | --- |
| Proposal and operation IDs | Idempotent review, stable links, and audit correlation |
| Vault, note, actor, session, turn | Attribution and scope |
| Content kind | Prose, code, sheet, canvas, or unsupported; no guessing from generated text |
| Baseline | Saved revision and/or live-document baseline as appropriate |
| Target anchor | Stable selection/range reference plus original-text digest |
| Structured changes | Localized operations; preserve marks, comments, links, and unrelated content |
| Explanation and source refs | Human review and traceability |
| Status per change | Pending, accepted, dismissed, conflicted, or unavailable |

First implement prose selection edits and inserted blocks. Expose other content kinds only after their specific adapter/tests exist. Unsupported requests may return a draft artifact or explanation without an Apply button. Do not coerce JSON, CSV, HTML, or code into a document replacement.

Acceptance flow:

1. Authorize the actor's access to the proposal and current target.
2. Recheck mode, effective capabilities, and governance requirements.
3. Validate baseline and anchor against the current document, including concurrent edits.
4. Apply through the live Yjs service with an attributed origin, or the conditional vault mutation path for a non-live supported document.
5. Persist acceptance/audit state and publish invalidation events with retry-safe operation identity.
6. Return authoritative changed-note/proposal state. If persistence crosses stores, use an operation journal/recovery mechanism; a process crash cannot turn a retry into duplicate insertion.

When anchors are stale or ambiguous, return a typed conflict with permitted current context. Reproposal is preferable to guessed offsets. Preserve intentional repeated text. Acceptance of an already accepted proposal returns its existing result. Batch acceptance must specify all-or-nothing or per-change outcomes; the UI reflects that exact contract.

Keep proposal state separate from historical restore and raw editor undo. A safe revert checks whether the accepted change can be inverted without overwriting subsequent work; otherwise it becomes a new reviewed change. Do not implement Undo by blindly restoring a previous full-note version.

## Conversation summaries and timeline

Reuse or extend WP1.5's server integration routes. A proposed high-level `MessageClient` covers reading and composing across Matrix/email while preserving provider-specific fields; it may wrap delivered clients rather than adding another transport stack.

Required read operations:

| Operation | Request | Response |
| --- | --- | --- |
| List conversations | Cursor, search, platform/person/triage filters | Lean summaries, next cursor, accurate or explicitly unknown totals, freshness |
| Read timeline | Authorized conversation ID, before/after or anchor cursor, bounded page size | Normalized messages, next cursors, coverage/limitations, source state |
| Read around message | Conversation and stable message reference | A bounded contextual window for citations/deep links |
| Resolve participants | Conversation or explicit permitted identities | Display identities without hidden person-record leakage |
| Search messages | Query and permitted scope | Matching message references/snippets and pagination |

A summary includes canonical conversation ID, backing note reference, kind/platform, human title, participant preview, last actual message, triage, known unread state, capability flags, and data freshness. It must not require downloading complete thread bodies or the full graph. Source disconnection is not an empty conversation.

A normalized message includes a stable source event ID when available, source provenance/quality, conversation ID, sender identity/display name, direction or unknown, timestamp or unknown, body format/content, supported media/relations, and revision/delivery state. Legacy records use an explicitly snapshot-scoped reference; they are not fabricated Matrix event IDs.

Define `conversation ID` as an opaque server identity scoped to vault and source account/room/thread. A bare Matrix room ID, slug, or email subject is insufficient across accounts/vaults. Preserve existing note links by resolving them to this identity rather than rewriting the notes.

See [MESSAGES.md](MESSAGES.md) for archive authorization, cursor invalidation, conservative reconciliation, structured event storage, and legacy fallback. All projection/cache keys include actor authorization scope or store permission-neutral data that is filtered before response. Do not reuse an owner's cached summary response for a collaborator.

## Message mutations

Sending extends WP1.5, preserving admin-only policy unless upstream explicitly changes it. The browser cannot gain send permission merely because it can read a thread.

- **Send/reply:** server-resolved destination/account, client operation ID, body/attachment limits, reply target when supported, and authoritative accepted/delivery result. Persist dispatch identity before retrying an external side effect.
- **Delivery lookup:** resolves a pending operation after a timeout/reconnect. Return unknown when the provider cannot prove delivery.
- **Triage:** replace only the mutually exclusive triage tag set atomically or with conditional revision and recovery. Preserve unrelated tags; report conflicts. Do not embed a blind remove-then-add sequence in UI components.
- **Read position:** actor-scoped acknowledgement when supported. Reading a preview is not automatically marking an entire room read. Distinguish local read state from synchronized provider receipts.
- **Media:** authenticated, scoped delivery of allowed source media; bounded types/sizes, safe content disposition, and no leaked access tokens in URLs.

A status vocabulary may include draft, submitting, accepted, failed, unknown, and source-confirmed. Do not call “accepted by Prism” delivered/read unless the source proves it. Map provider states once in the adapter.

## Cache and subscription rules

Build on WP7 projections and invalidations. Query keys include server, actor/authorization epoch, vault, resource identity, filters, and cursor where relevant. Reset subscriptions and sensitive caches on logout, revocation, server change, and vault change according to the upstream transport's policy.

For cached offline content, authorization has a limit: disconnected clients cannot learn about a remote revocation until they reconnect. Adopt and document the upstream cache policy, segregate data locally, clear access immediately on reconnect/revocation, and never claim offline revocation is instantaneous. Agents and external sends require connection; locally editing supported documents follows the existing outbox/collab design.

A single message event invalidates the corresponding summary/timeline and affected aggregates; it must not force every open client to download the entire vault or restart its agent session. Burst events may coalesce. Missed event windows trigger bounded revalidation, using projection revisions/ETags from architecture v2.

## Compatibility and server errors

Additive migrations precede new UI consumers. Version structured message/proposal payloads and capability responses. Keep old clients working during staged deployment; feature flags select new experiences only when the server supports their contracts.

Normalize at least unauthorized, forbidden, unsupported, source offline, queued/capacity, rate-limited, revision conflict, target removed, delivery unknown, and retryable server failure. The user-facing message says what happened and which action is available. Log technical details with request IDs, without including private bodies or credentials by default.

Rollback disables new consumers and structured-write flags, while retaining additive records and compatibility transcripts. It must not revert the secure auth/runtime restrictions, re-enable legacy ingest, restore whole-vault member credentials, or discard accepted edits.

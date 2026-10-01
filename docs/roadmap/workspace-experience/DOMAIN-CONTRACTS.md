# Additive contracts for the redesigned workspace

Companion to the [final plan](POST-MIGRATION-PLAN.md), based on source cutoff `29d18b3`. These are proposed semantic contracts, not claims that exact endpoint/type names already exist. Implementation first maps each contract to delivered clients and services. Add fields/routes only where a real gap remains; do not build a parallel API family.

## 1. Scope and offline operation identity

Every persisted draft, outbox entry, selected session, and derived index needs a stable scope. Model server origin, workspace ID, vault ID, and actor/access audience explicitly. An access-audience identifier is not a stored bearer/capability secret. Revalidate authorization at replay; do not use an old credential embedded in an operation to bypass current revocation.

An outbox operation needs a schema version, operation ID, scope, creation time, method/resource, typed payload, original revision/precondition, dependency IDs, and state. States include queued, sending, confirmed, conflict, blocked by access, missing target, and unknown outcome. The UI derives status from these states; a network timeout is not proof a write failed.

- Legacy records lacking scope are quarantined with readable recovery/export, never automatically assigned to the active vault.
- Confirm IndexedDB transaction completion before announcing a draft safely stored; handle quota and storage failures explicitly.
- Snapshot scope per operation, including during a multi-item flush; switching accounts mid-flush stops unauthorized replay.
- Preserve optimistic preconditions. Conflicts retain both the local intent and the current server version; user-directed reconciliation creates a new guarded operation.
- Use idempotency keys or readback reconciliation for repeat-sensitive creates. Dependent temporary note IDs resolve before relation/task writes replay.
- Yjs updates remain Yjs updates. Do not place a flattened duplicate body in the REST outbox for the same collaborative edit.

## 2. Canonical identities and relationship evidence

Canonical person = a vault person note ID. External identity = namespace plus normalized stable identifier, optionally account/bridge namespace, linked to that person with provenance and status. Examples include normalized email and a Matrix user ID with its server; Telegram identifiers need explicit bridge/provider mapping. A display name is descriptive evidence, never a unique key.

Resolution returns a verified match, one or more candidates, or no match. It includes evidence sufficient for review without exposing private unrelated notes. Exact identity collisions are conflicts; insertion order must not decide. Manual decisions outrank weak automatic name evidence and survive refresh. Alias/merge actions retain provenance and support correction; no destructive duplicate-person deletion is automatic.

Relationship evidence identifies subject, predicate/type, object, scope, and one or more sources: manual assertion, canvas+arrow, ingestion event, transcript match, or derived wikilink. The vault's actual relation remains the canonical relationship; evidence explains why automated maintenance may add/remove it. A server projection may index evidence but must be recoverable from authoritative records or a documented durable log.

Removing one source removes only that source's assertion. Delete the resulting relation only when no remaining evidence or manual ownership requires it, and the actor is authorized. Both endpoint access and source mutation rights are checked server-side. Avoid generic elevated graph writes for a scoped guest.

## 3. Message timelines and send reconciliation

A normalized timeline event contains a stable source/event key, conversation/account/provider identity, sender external identity and optional person note ID, original timestamp and known timezone precision, body parts, attachments, reply target, and edit/redaction state where the provider supplies them. Preserve source provenance and raw content references. Cache/projection rows are scoped and rebuildable.

Legacy adapters preserve all lines. Unknown sender IDs, timestamp offsets, or delivery states remain unknown; never invent source IDs that imply provider certainty. Synthetic legacy keys can be stable within a versioned record, but must be labeled as adapter identity. Preserve the current portable note representation during rollout.

Timeline paging uses an opaque stable cursor across rollover notes, with deterministic event ordering/deduplication and an anchor for restored scroll position. Summary APIs return enough for an inbox row without fetching every body. Search and person timelines respect authorization before returning snippets/counts.

Compose requests retain draft ID, recipients, account, body/attachments, reply context, and a client operation ID. Server acceptance returns an action/source correlation identifier. The UI reconciles that with delayed ingestion. Supported states: draft, submitting, accepted, confirmed in source, failed, unknown outcome. Do not equate accepted with delivered/read. Retry an unknown outcome only after reconciliation or an explicit supported idempotency path. Use the existing live-action service and its CSRF/actor protections.

## 4. Agent turn context and execution modes

Extend existing durable sessions and event sequence semantics. A conversation retains actor/vault scope and an explicit working document independent of which reference the UI is previewing. Context contains typed references, selected text/anchor, optional unsaved document snapshot, revision/Yjs state information, and bounded truncation metadata. Do not store authentication secrets in session context.

Distinguish user-attached context, available search scope, and sources actually retrieved by the agent. Citations identify the note/version/passage used where known; a UI chip saying “vault” is not evidence the whole vault was read. Recheck access before source hydration and execution, including queued turns after role changes.

Follow-up intents have stable IDs, ordering, status, and editable/cancellable queued content. Scheduling consumes each once and obeys the existing single-active-turn lock. Cancellation has requested and acknowledged states; a disconnected stream alone does not indicate cancellation.

Execution modes are persistent, user-selectable **per-session collaborator permissions**, enforced by the server. No session is permanently restricted to suggestions. Effective powers are the intersection of the selected mode, the actor's current access, document/vault governance, and separately configured non-document capabilities:

| Mode | Allowed behavior |
| --- | --- |
| Read-only | Authorized read/search/context and response; no note mutations or outward actions |
| Suggested edits only | Authorized reads plus guarded live-document suggestions and supported comments; no direct content replacement, restore/delete, governance voting, or external send |
| Read/write | Authorized reads and direct collaborative note edits/creation and other explicitly granted document operations through Prism's guarded services; effective access and governance still apply |

Persist mode, policy version, and change history on the session; each turn records its effective policy version. Changing one session must not alter another. The UI always shows the current effective mode and any pending transition. Outward sending, integration administration, destructive operations, and governance votes are not automatically granted by a document Read/write label; they remain governed by their own existing permissions and explicit tool grants.

Serialize policy transitions with tool authorization. A downgrade revokes forbidden tool authority and stops/reconfigures the active runner before the UI confirms the new mode; an already dispatched operation may finish and must be shown honestly. Recheck policy at each server tool invocation, including resumed/queued work. Escalation never broadens an in-flight turn silently: apply it at a clear next-turn boundary, or stop and restart under the new mode. Do not rely on prompt instructions, a static CLI allowlist, or cancellation alone as the enforcement boundary. Scope short-lived MCP authority to session/turn/policy version if needed to make revocation enforceable. Completed authorized writes remain in document history.

The existing `prism-rw` profile is a useful Read/write foundation, not equivalent to Suggested edits only. Prism MCP/profile availability is configuration-dependent. Old sessions must preserve or explicitly transition their recorded policy, with unavailable states when the corresponding guarded tools are disabled. Hosted multi-user execution, if later enabled, requires actor-bound credentials, budgets, session isolation, and revocation tests; the current owner-only gate stays until those conditions are met.

## 5. Collaborative suggestions and governed review

Extend current Yjs marks with optional stable suggestion ID, author identity/type, originating turn, and anchor/revision evidence. Continue rendering legacy user/color-only marks. Grouping and accepted/rejected status must derive consistently from actual collaborative transactions and any necessary audit records, not a disconnected second proposal copy.

Anchor resolution must detect duplicate text, concurrent replacements, missing passages, and stale versions. Server-side operations are idempotent by suggestion/action identity and apply against the live Y.Doc. Large/unsupported renderer changes require an explicit supported review representation; do not promise live tracked edits for every binary/specialized format.

Accept/reject permissions follow effective grants and governance. A tracked edit may need a governed proposal before application; show that transition explicitly. A content proposal's quorum/author restrictions cannot be bypassed by accepting a suggestion through another route. Existing direct-write three-way merge remains for authorized operations. Comment-only anchored collaboration requires a separately enforceable channel if added; broad Yjs write access is not an acceptable implementation shortcut.

## 6. Event/transcript linking

An event occurrence uses provider/account/calendar/event identity plus recurrence occurrence identity where available. Preserve start/end/timezone, meeting URL, participants, and cancellation state. Transcripts preserve provider recording IDs and actual timing/participants when supplied; legacy date-only records remain valid but less certain.

A match proposal records candidates, evidence, confidence, algorithm version, decision state, and manual override history. Exact provider/meeting identity outranks fuzzy title/name overlap. Automatic acceptance requires a unique high-confidence result; otherwise present candidates. Never choose the first qualifying note from listing order.

Relations allow multiple recordings per event. Link/unlink is resumable and idempotent across both note updates; use operation identity/preconditions and a reconciliation job if Parachute offers no atomic multi-note write. Maintain old singular fields through a compatibility adapter, then migrate deliberately. A source deletion gate is independent of matching and must remain intact.

## 7. Scoped retrieval and link resolution

Embedding identity includes vault, note, model/dimensions, chunker version, chunk index, and content/revision hash. Index jobs have bounded batches, resume position, error state, and deletion/access invalidation. Existing primary rows can be assigned known primary provenance in a versioned migration; ambiguous legacy rows require quarantine/rebuild, not guessing.

Keep the primary-only API guard until migration and cross-vault collision tests pass. Filter accessible candidates before exposing snippets/counts and retain enough authorized candidates for useful recall. Make fallback/degradation explicit. Avoid cross-vault search until scope and access semantics are intentionally supported.

Wikilink resolution policy is shared across editor, imports, per-note repair, and batch job: stable identifier/exact path first, then explicit alias, then unique name; ambiguous matches require choice. Derived reference refresh removes only edges it owns. Portable source text remains readable even when richer stable-ID metadata accompanies it.

## 8. Board, publication, and integration configuration

Board configuration is versioned metadata on a board/view note: filter scope, grouping field, column definitions/order, displayed properties, sorting/manual ranking, and presentation. Task data remains task-note metadata. Unknown status values remain visible. Use field-aware updates and preconditions so a drag does not replace unrelated properties. Reuse existing dashboard filter/schema validation.

Publication presentation has draft and published revisions, a template identifier/version, validated theme/layout/navigation options, and scoped asset references. Scope/password/access remain explicit and server-enforced. Live content updates and appearance publication are different operations; restoring appearance does not restore note history. Templates consume the existing publication-authorized data contract.

Integration configuration uses delivered server stores/services. Present connection/account, scope, mapping, direction, schedule, visibility, conflicts, and history; never copy credentials into shared note metadata or browser state. Imported auto-sync remains off until deliberately enabled. Preserve immutable evidence of attempted operations and distinguish dry-run from actual remote writes. Unsupported providers/actions get truthful availability, not inert controls.

## Compatibility and rollout

Each contract change includes schema/version notes, reader/writer compatibility, fixture migration, a failure-injection test where writes span systems, and a rollback procedure that retains user data. Deploy tolerant readers before new writers when rolling releases overlap. Preserve recorded historical identities and policy decisions; backfills are bounded, resumable, auditable, and previewable when they can change relationships. No contract in this document authorizes bulk mutation before implementation approval.

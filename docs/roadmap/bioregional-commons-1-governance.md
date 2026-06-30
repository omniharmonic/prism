# Bioregional Knowledge Commons — Plan 1: Governance & Commons Infrastructure

> Status: research/design (v0). Branch `claude/bioregional-commons-research-imkw2y`.
> Companion: **Plan 2 — The Bioregional Graph** (schema/ontology). Read this first.
>
> **Premise / what we assume already shipped.** This plan is written on top of the
> in-flight **Network** sprint (`docs/roadmap/network-vision.md`): publish (public
> Wiki), federation (peer CRDT sync, pairing, spaces, mirrors), multi-vault, and
> the Network UX surface. Where this plan says "reuses X," X is either already in
> `apps/server` today or is being built by that sprint. This plan adds the layer
> that sprint does **not** cover: **turning a single-owner vault into a
> multi-actor knowledge commons with legible governance.**

---

## 0. The reframe — from PKM to a governed commons

Prism + Parachute were built for **personal** knowledge management. The entire
trust model in `apps/server` is a **binary**: there is exactly one `OWNER_EMAIL`
who short-circuits to `own` (full passthrough to the vault), and everyone else is
a grant-holder filtered by `effectiveLevel` (`permissions.ts:43`, `actor.ts:28`).
That binary is the thing that has to change.

A **commons** is not "an owner who shares." It is a *membership* with:
- **plural roles** that carry powers (gardeners who curate, stewards/admins who
  certify gardeners, an arbitration tier that can remove an admin),
- **configurable collective-choice rules** (how many sign-offs, from whom, over
  what window, before a change becomes real),
- **two distinct lifecycles** — *approval* (is this change endorsed?) and
  *publishing* (is this version the live/canonical one?) — which are **not the
  same event**,
- **memory**: an append-only history so any change can be attributed and rolled
  back, and the commons can be forked and re-merged.

Crucially, the user's instinct is right: **most of this can be expressed as
tag-state changes governed by thresholds, on top of the existing grant model.**
The `effectiveLevel(grants, note, isOwner)` guard stays authoritative; governance
only *narrows* and *gates* — exactly the invariant the gateway already holds
(CLAUDE.md: "effectiveLevel is the authoritative guard — tag queries only
narrow"). We are not replacing the permission core; we are adding three new,
orthogonal concerns around it.

### The three axes (keep them separate — this is the whole design)

Every governance system surveyed (Wikipedia pending-changes, GitHub branch
protection, multisig, DAO/Snapshot, Discourse trust levels) reduces to the same
three independent axes. Conflating them is the classic mistake. We model each as
its own SQLite concern:

1. **WHO** — roles & trust. *Grants + roles tables.* (Who is a gardener? an admin?)
2. **HOW MANY** — thresholds & quorum. *A policy/threshold-config table.* (How many
   sign-offs, from which role, distinct, within what window?)
3. **WHAT STATE** — the revision lifecycle. *A revision state machine + an
   append-only log.* (draft → pending → approved → published, with rollback.)

Plan 1 builds all three, plus the **history/fork/canonical** substrate that the
"GitHub-style commons" vision needs. The existing code already gives us clean
seams for each.

---

## 1. What exists today (grounding — verified against the code)

A four-agent codebase sweep established the baseline. Summary of load-bearing
facts (file:line references are exact as of this branch):

**Permission core — solid, reusable, binary.**
- `Level = view < comment < suggest < edit < own` (`permissions.ts:10`).
- `effectiveLevel(grants, note, isOwner)` = max over grants matching note id /
  tag / space; owner → `own` (`permissions.ts:43-56`). **Pure, well-factored —
  the ideal place to layer policy.**
- Actors are `user | link | anon | peer`; owner is a single `email ===
  config.ownerEmail` string check (`actor.ts:28,44`). **No role concept beyond
  this binary.**
- Grants table: `(subject_type: user|link|anyone|peer, subject, resource_type:
  note|tag|space, resource, level, created_by, created_at)` (`db.ts:47-56`).
  `created_by` **is stored but never queried** — there is no audit surface.
- Invite-only accounts already exist (`invite.ts`, `password.ts`): owner issues a
  single-use invite → recipient registers a password account. This is our
  **member-onboarding** primitive — Ostrom principle #1 (defined boundaries) is
  half-built.

**Suggestion / PR machinery — half-built, the most important gap.**
- Inline track-changes (Google-Docs style) are **complete**: `insertion` /
  `deletion` marks with author+color (`editor/suggestionMarks.ts`), suggest-mode
  behavior (`editor/suggestions.ts`), comment threads (`editor/comments.ts`), and
  local accept/reject in the toolbar.
- The durable queue table `pending_suggestions (id, space_note_key, note_id,
  author, author_kind, summary, payload, status, created_at, resolved_at)` exists
  (`db.ts:170-182`) with full CRUD (`db.ts:926-947`) and owner endpoints
  `GET/POST /acl/suggestions/:id/{accept,reject}` (`acl.ts:589-628`) — **but
  `createSuggestion()` is never called in production, and accept/reject only
  flips `status`; it does not apply the change to the doc.** The queue is a
  wired-up shell with no producer and no consumer.
- Collab authorizes per `effectiveLevel`: below `suggest` → `readOnly=true`
  (`collab.ts:459`). Edits persist via `storeDocumentState()` →
  `vault.updateNote()` (`collab.ts:522-571`). **This is the single interception
  point** where a suggest-level write should be diverted into the queue instead
  of the canonical note.

**Federation — plumbing-complete, transport-pending.**
- Ed25519 pairing, spaces, content-independent `space_note_key`, one-doc CRDT
  bridge, durable offline outbox, kind-pinning, mirror-request approval, and the
  suggest-level inbox are all built (`federation-manager.ts`, `routes/federation.ts`).
- Deferred (the manager's own header is honest about it): peer-URL self-discovery,
  clients opening federated notes by `space_note_key`, and live two-hub
  convergence. These are the Network sprint's job, not ours — but our governance
  layer must be **federation-aware** (a sign-off can come from a peer).

**Versioning / history / fork — does not exist.**
- No note-level version history anywhere. `HistoryPanel.tsx` shows only
  `createdAt/updatedAt` and literally says "Full version history requires
  Parachute versioning support (future)." Yjs binary in `collab_docs` is CRDT
  *continuity*, not snapshots.
- GitHub sync (`src-tauri/.../adapters/github.rs`) is effectively **one-way push**
  (commit-per-save / batched), with a local-wins/remote-wins conflict matrix; the
  git history exists in the repo but Prism never surfaces log/blame/checkout. It
  is a backup, not a rollback backbone.
- **No fork primitive** and **no canonical-vs-derivative concept.** Federated
  peers are equal collaborators on one shared doc, not parent/child copies.

The gap, stated plainly: we have a great *permission* core and a great *editing*
surface, a *stubbed* review queue, a *capable* federation transport, and *nothing*
for roles, thresholds, lifecycle state, history, or forking.

---

## 2. Design — the governance layer

### 2.1 WHO: roles & two-track trust

Add **roles** as a thin layer over grants — a role is a named bundle of *powers*
plus the *grant scope* it can act within. We deliberately keep roles separate
from `Level`: `Level` is "how much can you change this note's content"; a **role**
is "what governance actions can you take" (review, certify, publish, arbitrate).

New tables (`db.ts`):
- `roles (id, name, powers_json, scope_type: global|tag, scope, created_at)` —
  powers ∈ `{review, publish, certify_gardener, manage_thresholds, arbitrate,
  invite, revoke}`. A role can be **global** or **tag-scoped** (gardener of
  `#species`, not of the whole commons — Ostrom #8, nested enterprises; mirrors
  GitHub CODEOWNERS where the owner of a path must approve changes to it).
- `role_members (role_id, subject_type, subject, granted_by, granted_at,
  expires_at)` — `expires_at` gives **term limits / periodic recall** for free.

**Two-track trust** (the survey's strongest cross-cutting lesson):
- **Auto-earned tiers** for the long tail — Discourse/StackOverflow model. A
  computed `trust_score` per actor (edits accepted, tenure, clean record) auto-
  issues/auto-revokes *low/mid* grants when crossing configured thresholds. Cheap,
  reversible, sock-puppet-resistant. (v1 can stub the score as "owner toggles a
  contributor → trusted-contributor" and make it metric-driven later.)
- **Vouched/elected roles** for gardeners and admins — Wikipedia RfA / Discourse
  TL4. Becoming a gardener is itself a **proposal** (see 2.3) requiring a
  configured support threshold from the certifying role; removing an admin is the
  same process at a higher tier (the user explicitly called this out — "admin
  level governance to remove an admin"). Both are just grant-row writes behind a
  threshold gate.

The owner (`OWNER_EMAIL`) does **not** disappear — it becomes the **bootstrap
root** (the genesis admin who can seed the first thresholds and certify the first
gardeners), exactly like a Git repo's first maintainer. But every power the owner
holds becomes *delegable* via a role, and the threshold config can require even
the owner to get sign-off for high-stakes actions (Ostrom #7: the rules bind the
rule-makers).

### 2.2 HOW MANY: a threshold/policy engine

One config table is the heart of "configurable governance backend" the user
asked for:

`policies (id, action, scope_type: global|tag|note, scope, threshold_n,
quorum, distinct_required: bool, eligible_role, window_seconds, auto_publish:
bool, updated_by, updated_at)`

- `action ∈ {edit_note, new_entry, publish, certify_gardener, add_admin,
  remove_admin, change_policy, ...}` — the same engine governs content changes
  **and** governance changes (Ostrom #3, collective-choice: the rules are edited
  through the rules — "meta-governance").
- The decision function is a single pure helper, mirroring `effectiveLevel`:
  `requiredApprovals(action, resource) → Policy` then
  `isSatisfied(policy, approvals) → boolean`, where `isSatisfied` enforces
  `COUNT(DISTINCT approver WHERE approver_role ∈ eligible_role) ≥ threshold_n`
  (and quorum / window). `distinct_required` + role-eligibility is the cheap
  defense against sock-puppet sign-off (multisig / moderation-quorum lesson).
- Per-tag scoping means **congruence** (Ostrom #2): trivial tags
  (`#community-event`) can `threshold_n=1, auto_publish=true`; high-stakes tags
  (`#herbal-medicine`, `#policy-threat`) can demand 3 distinct gardeners +
  steward sign-off. This *is* Wikipedia protection levels expressed as config.

This table is small, declarative, and owner/admin-editable through the Network
surface — no code change to retune the commons.

### 2.3 WHAT STATE: the revision lifecycle (approval ≠ publishing)

This is the spine. Two **independent** fields per note, never collapsed (the
clearest lesson from Wikipedia stable-vs-pending, GitHub approved-vs-merged, and
CMS draft→approved→published):

- `approval_state ∈ {draft, pending, approved, rejected}` — *governance.*
- `publish_state ∈ {unpublished, live}` + a `published_revision_id` pointer —
  *visibility.* **The public/Wiki view always reads `published_revision_id`,
  never HEAD.** Approving a revision does not move the pointer; a separate
  **publish** step does (auto when `policy.auto_publish`, or by a `publish`-power
  role, or scheduled).

This needs **revisions** to be first-class — which also closes the versioning
gap (2.4). The flow, end to end:

1. **Propose.** A contributor either (a) edits an existing note in *suggest mode*
   (existing track-changes UI), or (b) submits a **new entry** — fully fleshed or
   just a *stub* (a note tagged `#needs-research` / `#needs-fill`, optionally with
   an AI-fill request). Both produce a **proposal** = a pending revision.
   - **Producer wiring (the key fix):** in `storeDocumentState()` (`collab.ts:522`),
     when the connection's `effectiveLevel` is `suggest` (or the note's policy
     says edits require review), divert the Yjs update into
     `createSuggestion()`/a new `revisions` row with `approval_state=pending`
     **instead of** `vault.updateNote()`. The canonical note is untouched until
     approval. This finally makes the `pending_suggestions` shell live.
   - Form-based submission reuses note-creation + tags wholesale: a `proposal`
     tag schema drives a guided form; submit creates a `draft` note + a pending
     revision. No new editor needed.
2. **Review.** Eligible reviewers (per the note's tag-scoped policy) see the
   pending revision with a **before/after diff** in a review queue (the missing
   owner dashboard — a new Network sub-tab, backed by the existing
   `GET /acl/suggestions` extended with diff payloads). Each approval is a row in
   a new `approvals (revision_id, approver, approver_role, vote, reason, at)`
   table.
3. **Approve.** When `isSatisfied(policy, approvals)` flips true, `approval_state
   → approved` and the queued Yjs update is **applied to the live doc** (the
   consumer the current accept endpoint lacks). Attribution + reason are logged.
4. **Publish.** Per policy: auto (repoint `published_revision_id`) or manual by a
   publish-power holder, or scheduled. Unpublishing/rolling back just repoints to
   an earlier revision — non-destructive.

Graduated sanctions (Ostrom #5) and conflict resolution (#6) slot in here as
extra states/queues: flag → warn → rate-limit → demote → revoke, and a dispute
note type routed to the `arbitrate` role.

### 2.4 History, rollback, canonical & fork

Revisions (2.3) double as the **version history** Prism lacks. New table:

`revisions (id, note_id, vault_id, parent_revision_id, content, content_hash,
metadata_json, author, author_role, origin: direct|suggest|agent|federation|import,
approval_state, created_at)`

- Snapshot on every accepted change (and optionally every direct owner save).
  `parent_revision_id` gives a DAG — the substrate for diff, blame, **rollback**
  (repoint `published_revision_id` to any ancestor), and **fork**.
- **Canonical version.** A vault/space is marked `canonical_vault_id`. In the
  user's high-trust model the Mac Mini hub is canonical; federated peers carry
  copies whose authority is explicit (canonical vs mirror), resolving the
  "where does the canonical version live" question without ARWeave/on-chain for
  now. Backup = those mirrors + GitHub sync of the canonical vault.
- **Fork.** "Fork the whole commons" = create a new vault/space with
  `forked_from_vault_id` + `forked_from_revision_id` ancestry pointers, seeded
  from a revision snapshot. Because revisions form a DAG, a fork can later open a
  **merge proposal** back to canonical (federation already moves the content;
  governance gates the merge — it's just a cross-vault proposal). This is the
  GitHub-fork mental model the user wants, expressed in our own primitives rather
  than depending on GitHub.
- **GitHub as the durable spine.** Keep GitHub sync as the *off-site, human-
  legible backup and disaster rollback* (its commit history is real git history),
  and surface that history in `HistoryPanel` alongside revisions. We do **not**
  need bidirectional GitHub PRs for v1 — our own revision/approval flow is the
  PR mechanism; GitHub is the archival mirror.

### 2.5 Memory: the audit log (Ostrom #4, monitoring)

`audit_log (id, action, actor, actor_role, resource_type, resource_id, before,
after, at)` — append-only, written at every grant mutation, role change, policy
edit, approval, publish, and sanction. The hooks already exist as choke points
(see §3); we just record through them. This makes the commons **legible and
accountable to its members**, which is what separates a commons from a fiefdom.

---

## 3. Where it attaches (exact hook points)

The codebase sweep surfaced four clean choke points; the whole layer hangs off
them, so the blast radius is small and the `effectiveLevel` invariant is
preserved:

1. **Grant mutation boundary** — every `upsertGrant()` / `removeGrant…()` call
   (`db.ts:540-564`, used throughout `acl.ts`). Wrap with
   `mutateGrantWithGovernance(grant, actor, reason)` → returns applied | forbidden
   | `{pendingApprovalId}`; always writes `audit_log`. This is where role grants,
   gardener certification, and admin add/remove get gated.
2. **Suggestion lifecycle** — `storeDocumentState()` (`collab.ts:522`, the
   **producer**) diverts suggest-level writes into `revisions`/`pending_suggestions`;
   `POST /acl/suggestions/:id/accept` (`acl.ts:611`, the **consumer**) gains the
   threshold check + the apply-to-doc step it's missing today.
3. **Collab authorization gate** — `authorizeConnection()` (`collab.ts:450-461`).
   Today binary (suggest+ → writable). Extend so a note under a review policy puts
   even `edit`-level non-stewards into "queue-for-approval" rather than direct
   write.
4. **Publication creation** — `POST /acl/tags/:tag/publish` (`acl.ts:406`).
   Decouple *approve-to-publish* from *go-live*; gate sensitive tags behind a
   publish policy.

All four already centralize the operations we need to govern — we are adding a
policy check + an audit write at each, not rearchitecting.

---

## 4. Phased build plan (testable, committed per step)

- **G0 — Schema + policy engine.** Add `roles`, `role_members`, `policies`,
  `revisions`, `approvals`, `audit_log` tables (`db.ts`) + the pure
  `requiredApprovals/isSatisfied` helpers (a `governance.ts` sibling to
  `permissions.ts`, fully unit-testable like the existing `effectiveLevel` tests).
  No behavior change yet. *Verify: typecheck + helper tests.*
- **G1 — Audit + roles (WHO).** Wrap grant mutations (hook 1); add role CRUD to
  `acl.ts` + a Network "Members & Roles" sub-tab; render the audit trail.
  Owner-bootstrapped roles, manual certification first. *Verify: gateway e2e —
  a gardener role can/can't do X.*
- **G2 — Review queue / PR pipeline (WHAT STATE, the headline).** Wire the
  producer (hook 2 in `storeDocumentState`) + consumer (accept applies to doc) +
  the review-dashboard sub-tab with before/after diffs + `approvals` recording +
  threshold gate (hook 3). Make `pending_suggestions` actually flow.
  *Verify: suggest-level edit → pending → N sign-offs → live; rejection path.*
- **G3 — Thresholds & meta-governance (HOW MANY).** Expose `policies` editing in
  the UI; route `certify_gardener` / `add_admin` / `remove_admin` /
  `change_policy` through the same engine. *Verify: configure 2-of-3 gardener
  sign-off on a tag and observe gating; vote an admin out.*
- **G4 — Approval≠Publishing + rollback.** Split `approval_state` /
  `publish_state` / `published_revision_id`; public Wiki reads the published
  pointer; add rollback (repoint to ancestor) + the version-history panel from
  `revisions`. Gate publish (hook 4). *Verify: approve-but-don't-publish; publish;
  roll back; confirm the public site follows the pointer.*
- **G5 — Canonical / fork / GitHub-spine.** Add `canonical_vault_id` +
  `forked_from_*` ancestry; surface GitHub commit history in `HistoryPanel`;
  cross-vault merge proposal (rides federation, gated by governance).
  *Verify (two-hub): fork → edit → merge-proposal → approved → converges.*

**Sequencing note.** G0–G2 are the spine and deliver the user's core ask
(Wikipedia-style propose → sign-off → live). G3–G5 deepen it into a true commons
(configurable thresholds, separate publish, fork/canonical). Each phase is
independently shippable and leaves `effectiveLevel` authoritative.

---

## 5. Open questions for the user (genuine forks in the road)

1. **Trust: earned vs. appointed (v1).** Start with owner/admin *appointing*
   gardeners (simple, high-trust, matches "we'll certify gardeners"), and add
   metric-driven auto-tiers later? Or build the computed `trust_score` now?
   *Recommendation: appoint first, automate later.*
2. **Where governance state lives.** Roles/policies/revisions in the **Prism
   Server SQLite** (fast, server-authoritative, but a second source of truth
   beside the vault) vs. **as governed notes in Parachute itself** (dogfoods the
   commons, federates for free, but slower and needs careful guard-tagging).
   *Recommendation: hybrid — operational state (approvals, sessions) in server
   SQLite; durable artifacts (proposals, policy docs, role registry) as
   guard-tagged notes so they version + federate like everything else.*
3. **Fork merge model.** Full DAG merge (powerful, complex) vs. proposal-only
   "re-submit a fork's changes as pending revisions to canonical" (simpler, gated
   by the same engine). *Recommendation: proposal-only for v1.*
4. **Does the owner stay sovereign,** or is even the owner bound by thresholds for
   high-stakes actions from day one? (Affects whether this is "a benevolent
   admin's tool" or "a real commons" — a values choice, not a technical one.)

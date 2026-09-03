# Governing a Commons

Prism can turn a single-owner vault into a governed commons: a group of people
who can propose changes, vote on them, and see the rules stated in plain
language rather than buried in an admin panel. This is the guide for the person
running that commons — an operator who is not necessarily the developer — and
for the members who join it.

For the implementation (source of truth, gotchas, the code paths) see
[`CLAUDE.md`](../CLAUDE.md) → *Bioregional Knowledge Commons (governance +
geospatial)*. For what shipped in which phase, see
[`bioregional-commons-PROGRESS.md`](roadmap/bioregional-commons-PROGRESS.md).

---

## The short version

Governance lives entirely as ordinary notes in your vault — roles, policies,
memberships, proposals, votes are all just tagged `governance-*` notes. Nothing
about it is a separate database or a second product. Until you turn it on, it
does nothing at all: every note behaves exactly as it did in a plain,
ungoverned Prism vault. Turning it on is a **one-way decision** — more on that
below — so the flow is: model your commons, look at it, edit it as many times
as you like, and only *then* lock it in.

Once locked, three things become true:

1. **Membership becomes access.** Someone holding a role that carries, say,
   "edit notes tagged #watershed" actually gets that access — no separate
   sharing step.
2. **Changing the constitution requires a vote.** Not even the person who
   bootstrapped it can edit a role or policy by hand anymore; every change,
   including turning governance back off, has to pass the amendment rule the
   constitution itself defines.
3. **Content changes can be governed too.** You can require edits to certain
   notes (or brand-new entries) to be proposed and approved before they go
   live, with the same voting machinery as a constitutional amendment.

---

## Bootstrapping with the wizard

**Network → Governance** shows a bootstrap wizard the first time nobody has
configured anything. It offers three starting templates — pick one, then edit
every field before you ratify anything:

- **Solo curator.** One `steward` role holding every power and every content
  capability. Changes take effect the moment you make them — there is no vote
  because there is nobody else to vote. Good for a personal wiki you might open
  up later: the constitution exists on day one, it just has a single
  signatory, and the amend policy is "1 approval from steward" (i.e., yourself).
- **Reviewed commons.** Stewards govern the constitution; a second role,
  `gardener`, can edit and publish content but holds no constitutional powers.
  A gardener's approval of a proposed edit publishes it immediately
  (`autoPublish: true`) — contributors propose, one gardener signs off, the
  change goes live. Constitutional changes still need a steward.
- **Open commons.** Adds a third role, `member`, for newcomers: they can view,
  comment, suggest, and create — but not edit existing notes outright. Edits
  need **two** gardener approvals and stay staged until a gardener explicitly
  publishes them (`autoPublish: false`) — approval and publishing are
  deliberately separate steps here. Gardeners also hold `assign_roles` and can
  staff new members themselves, without a vote. Amending the constitution needs
  **two** stewards, so add a second steward before you ratify — with only one,
  the commons would lock itself out of ever amending anything (see the next
  section).

Every template pre-fills the role/policy builder; nothing is applied until you
edit it to taste and step through the wizard's readiness checklist.

---

## Ratification, and why the lock is one-way

*Enable & lock* is not a save button — it is a **one-way latch**
(`config.enabled`). Before it, the bootstrap owner can edit roles, policies,
and memberships directly, as many times as needed. The instant it flips on,
**nobody** — not even the bootstrap owner — can edit a `governance-*` note
directly again. Every change from then on, including disabling governance
again, has to go through a proposal that clears the constitution's own amend
policy.

That is exactly the property that makes governance trustworthy — the rules
that govern the commons are themselves governed by the same rules — but it
also means a badly configured constitution can **permanently brick itself**:
if the amend policy names a role nobody holds, or requires more approvals than
there are active members of that role, no proposal could ever pass, and the
commons is stuck exactly as it was at the moment of ratification, forever.

Ratification therefore runs a **pre-flight check** before it lets the lock
close: it refuses to enable a constitution unless its amend policy resolves to
a real, existing role, and that role has at least as many active members as
the policy's approval threshold. If the check fails, *Enable & lock* tells you
exactly what's missing (an empty role, a role with zero members, not enough
members) instead of letting you lock yourself out. There is no way around this
check from the UI or the API — fix the constitution, or lower the threshold,
and try again.

If you do end up with a bricked constitution some other way (hand-edited
notes, a pre-1.0 vault), see **Recovery** at the end of this guide.

---

## Roles are capability bundles

A role bundles two different kinds of authority, and it matters which is
which:

- **Powers** — what a role's holders may do *to the commons itself*:
  `publish`, `assign_roles`, `manage_policy`, `invite`, `revoke`,
  `amend_governance`. Of these, `publish` and `assign_roles` are actually
  enforced today; the rest describe the constitution for humans (and future
  enforcement) but aren't checked by any code path yet. `amend_governance` is
  the constitutional one — it is what makes a role eligible to approve
  amendments, and it can never be handed to a role's holders except through
  the amendment process itself (see *Delegated staffing*, below).
- **Capabilities** — ordinary content access: `view`, `comment`, `suggest`,
  `edit`, `create`, `organize`, `delete`, `share`. This is the *same*
  vocabulary the sharing system uses everywhere else in Prism. A role's
  capabilities are what actually let its holders read and write notes — see
  *How membership becomes access*, next.

The role editor shows both as checkboxes grouped under human labels ("can edit
existing notes", "can move & retag", "can amend the constitution", …), and
every policy is displayed as the sentence it means — "Edits to notes tagged
#medicine need 2 approvals from Gardeners within 7 days, then await publish by
a publisher" — never as a raw form. The same sentence renderer writes that
policy's note body in the vault, so the constitution reads the same way
everywhere: in the UI, in search, and to anyone who opens the note directly.

A role can be **global** (applies vault-wide) or **scoped to one tag** (applies
only within notes carrying that tag) — a `watershed-gardener` role scoped to
`#watershed` can edit watershed notes and nothing else, even if the same
person also holds a global `member` role elsewhere.

---

## How membership becomes real access — the bridge

This is the part that makes governance more than a label: once governance is
enabled, **every active membership compiles into an ordinary sharing grant.**
A member holding a role with `edit`/`create` capability, scoped to `#water`,
gets exactly the grant a human admin would have created by hand in the Share
dialog — same table, same enforcement, same everything. There is no second
permission system layered on top of content: the one that already governs
sharing (`view < comment < suggest < edit < own`, plus the composable
capabilities above) is the *only* thing that ever decides whether a request to
read or write a note succeeds. Governance's only job, content-wise, is to keep
that table's `governance:`-owned rows in sync with the constitution.

That sync happens two ways:

- **Immediately**, after every governance change that goes live (a new
  membership, an approved amendment, a role's capabilities edited) — so a
  newly onboarded gardener can start editing right away.
- **On a fallback timer** regardless — a background worker re-derives and
  reconciles the grants every `GOVERNANCE_RECONCILE_MS` (5 minutes by
  default), so an expired membership's access is revoked even if nothing else
  happened to trigger an immediate reconcile, and a server restart never
  leaves the constitution and the grant table out of sync for long.

Disabling governance compiles the constitution to *nothing* — every grant it
had written disappears in the same reconcile. Access a human granted by hand
(through the ordinary Share dialog, independent of any role) is never touched
by any of this — the two provenances stay cleanly separable.

A role with no capabilities at all — a pure "arbiter" or "policy author" role
that only carries powers — grants no content access whatsoever. That's
deliberate: a procedural role shouldn't silently become a backdoor into every
note in the vault.

---

## Delegated staffing

Requiring a constitutional vote to add one new contributor would make routine
onboarding impossibly slow. So a role that holds `assign_roles` can name, in
its `assigns` list, the roles it is allowed to staff directly — no vote, no
proposal, just an ordinary add/remove-membership action, audited as a
`delegated:*` entry. In the *Open commons* template, gardeners can add and
remove members themselves this way.

The one thing delegation can never do is hand out constitutional power: a role
carrying `amend_governance` can never be named in anyone's `assigns` list in a
way that works. Changing who can change the constitution only ever happens
through the constitution's own amendment process.

---

## Scoped sharing

Governance capabilities are one way to reach the sharing system; the ordinary
Share dialog is the other, and as of this work a non-admin can use parts of it
directly. If you hold the `share` capability on a note or a tag (through a
role, or through a grant someone gave you by hand), you can manage *that one
resource's* people access yourself — add someone, remove someone, see who has
access — without needing an admin. Two safety rails apply automatically:

- You can only hand out capabilities you **yourself** hold on that resource —
  sharing distributes access, it never manufactures more of it.
- You can only share with people who **already have an account**. Pulling a
  brand-new person into the workspace is still an admin/invite decision.

---

## The proposal lifecycle

Any signed-in member with **standing** — workspace membership, a governance
role, or at least one grant in the vault — can open a proposal. (A stranger who
merely has view access to a public Wiki does not automatically get to fill the
proposal queue; standing requires an actual relationship to the vault.) Two
kinds of proposal exist:

- **Amendments** — a change to the constitution itself (`amend_governance`):
  edit a role, edit a policy, change the config, add/remove a membership
  post-lock.
- **Content proposals** — `edit_note` (a change to an existing note) or
  `new_entry` (a brand-new note, which can be a stub for someone to fill in
  later).

Whichever policy governs the action (the most specific one that matches —
a note-scoped policy beats a tag-scoped one, which beats the global default;
ties go to the stricter threshold) decides who is eligible to vote and how
many approvals it needs. Two properties worth knowing as a voter or a
proposer:

- **Votes are mutable while a proposal is open.** Changing your mind after
  reading a comment revises your existing vote rather than adding a second
  one — the approval tally always reflects your *current* position.
- **Voting windows auto-close.** If a policy sets a window (24 hours, 7 days,
  …), a proposal that's still open when the window elapses is automatically
  rejected the next time anyone touches it (votes on it, or tries to apply
  it). Approvals that landed *inside* the window still count even if nobody
  applies the proposal until after it technically closes.

**Applying ≠ publishing.** When a content proposal clears its policy, applying
it always snapshots a revision. If the policy says `autoPublish`, that
revision also goes live immediately. If not, it stays **staged** — visible as
an approved revision, not yet the note's live content — until someone holding
the `publish` power explicitly publishes it. This is what lets a commons
require, say, two gardeners to approve an edit but still have a single
designated publisher decide the timing of when it actually goes out.

Every note also keeps a revision history (visible in the editor's History
panel) and can be rolled back non-destructively — a rollback is itself a new
revision, never a delete.

---

## The contributor wiki loop

A member with `suggest` or `create` access but not `edit` doesn't get a
broken, silently-failing editor. They get an honest one: the note opens
locally editable, autosave and metadata writes are suppressed (nothing reaches
the vault until they choose to), and a banner offers **Submit for review** —
which opens an `edit_note` proposal carrying their draft. A member with only
`view`/`comment` sees a read-only notice instead. Either way, the same banner
shows the note's revision history inline.

This only ever appears on the web app, for a signed-in non-owner. Desktop and
the owner's own browser session never see the annotation that drives it, so
the feature is provably inert there — nothing changes about how you use Prism
day to day unless you're a governed commons member editing someone else's
vault.

---

## Notifications

When a proposal opens, the members eligible to vote on it are emailed — the
same rule sentence the constitution uses ("Edits to notes tagged #medicine
need 2 approvals from Gardeners…"), how many approvals it still needs, and a
link to the governance queue. This goes out through the same mail plumbing as
magic-link sign-in: if `RESEND_API_KEY` is configured, it actually sends;
if not, the notice is logged to the server console instead — useful for local
development and for an operator who hasn't set up email yet. Delivery is
fire-and-forget and capped at 50 recipients per proposal — a failed send never
turns a successful proposal into an error, and a large commons gets a bounded
burst rather than an unbounded one.

---

## Recovery

If a constitution is genuinely bricked — locked, with no role that could ever
clear its own amend policy — the only way out is to delete the
`governance-config` note directly against the vault, using the server's owner
Bearer token, from loopback (not through the gateway, which enforces the lock
you're trying to escape). This drops governance back to "not bootstrapped":
every note keeps whatever content it had, and any grants governance had
written stay until the next reconcile notices the constitution is gone and
tears them down. Treat this as a last resort — it is a deliberate escape
hatch, not a supported day-to-day operation, and the ratification pre-flight
described above exists specifically so you should never need it for a
constitution created after this work shipped.

---

## API reference

Everything below is mounted at `/api/governance` and requires a signed-in
session (anonymous requests get a `401`). This is not the full contract —
consult `apps/server/src/routes/governance.ts` for exact request/response
shapes — but it's what exists.

| Method & path | What it does |
|---|---|
| `GET /state` | The constitution: config, roles, policies, your powers, whether you're the (still-unlocked) bootstrap owner. |
| `GET /memberships` | The full membership roster (transparency for members). |
| `GET /audit` | The governance audit trail, newest first. |
| `GET /me` | Your own powers, active memberships, and content grants (governance-derived vs. direct). |
| `POST /config` | Set the constitution's config — including the `enabled` transition (bootstrap-owner-only pre-lock; ratification-checked). |
| `POST /roles` | Add (or upsert, by name) a role. |
| `POST /policies` | Add (or upsert, by action+scope) a policy. |
| `POST /memberships` | Add (or upsert) a membership. |
| `PATCH /roles/:ref` / `DELETE /roles/:ref` | Pre-lock fixups; post-lock these refuse with `requires_proposal`. |
| `PATCH /policies/:ref` / `DELETE /policies/:ref` | Same. |
| `DELETE /memberships` | Remove a membership (body: `subject`, `role`). Post-lock, an `assign_roles` holder can call this directly for roles their role `assigns`. |
| `GET /proposals` | List proposals, optionally filtered by `state`. |
| `GET /proposals/:id` | One proposal, its votes, its evaluation against its policy, and its payload. |
| `POST /proposals` | Open an amendment proposal (requires standing). |
| `POST /content/propose` | Open a content proposal — `edit_note` or `new_entry` (requires standing). |
| `POST /proposals/:id/vote` | Cast or revise your vote (`{"vote":"approve"\|"reject"}`). Requires the policy's eligible role. |
| `POST /proposals/:id/apply` | Effect an approved proposal — amendment or content. |
| `POST /proposals/:id/publish` | Publish a staged (approved but not auto-published) content revision. Requires `publish`. |
| `POST /proposals/:id/withdraw` | Withdraw your own open proposal (or any, if you're the owner). |
| `GET /notes/:id/revisions` | A note's revision history, newest first. |
| `POST /notes/:id/rollback` | Roll a note back to a prior revision (non-destructive; requires `publish`). |
| `POST /fork` | Fork a note — a full, non-syncing copy with ancestry pointers. |
| `POST /forks/:id/propose-merge` | Propose merging a fork's current content back into its origin, as an ordinary `edit_note` proposal. |

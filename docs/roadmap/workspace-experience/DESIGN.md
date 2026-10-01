# Prism workspace interaction design

> **Historical design reference (2026-09-30, pre-migration `c191b52`).** The [post-migration plan](POST-MIGRATION-PLAN.md), [current contracts](DOMAIN-CONTRACTS.md), and [release gates](RELEASE-GATES.md) supersede runtime assumptions, sequencing, and authority statements below. Retain applicable interaction details. Each agent session now supports **Read-only, Suggested edits only, and Read/write**; earlier Ask/Suggest examples are not a restriction. Concept logos are placeholders pending [BRAND.md](BRAND.md).

Status: proposed specification for the follow-on upgrade. Package ownership is in [WORKPLAN.md](WORKPLAN.md); backend details are in [CONTRACTS.md](CONTRACTS.md).

## Product model

A workspace contains vault-backed documents and conversations. An agent conversation has a working document and may consult other permitted sources. Messages from people and external services retain their own identity and destination; an agent can help draft a reply without sending it automatically. Navigation, document state, and agent execution are separate concerns that remain coordinated across devices.

Use familiar user-facing terms: **Agent, Sources, Changes, Properties, History, Messages**. Keep protocol names, raw JSON, worker names, and token details in operator settings. Show useful states such as “Saved on this device”, “Synced”, “Waiting for the server”, and “Reply failed”. Do not report all four as “Saved”.

## Visual direction

Evolve the existing Blue Sky tokens and shared UI components. Keep a restrained blue accent, neutral surfaces, readable typography, and subtle borders. Reserve elevation for floating menus and dialogs. Reduce permanent toolbars and dense colored controls around the document.

Initial layout targets, to validate in the actual app:

| Surface | Starting target |
| --- | --- |
| Desktop sidebar | 232–260 px, resizable/collapsible, labels retained |
| Agent companion | 360–420 px where space allows; drawer below a usable document width |
| Document reading measure | Approximately 680–760 px; wide mode for tables and code |
| Interface typography | 13–14 px desktop labels; 16 px mobile input; body 16–18 px |
| Page title | Approximately 30–36 px desktop, 26–30 px mobile |
| Controls | Minimum 44 px touch target; compact visual icon may have a larger hit area |
| Color contrast | WCAG AA text and meaningful controls; muted text must remain readable |
| Motion | Short state transitions; respect reduced motion; never animate scrolling away from the reader |

These values are design starting points, not measured improvements. Maintain text zoom, long titles, keyboard focus, light/dark parity, and high contrast before freezing tokens. Do not force document prose width onto spreadsheets, maps, canvas, or code.

## Desktop workspace

1. Put the active vault/workspace selector near the Prism identity. The selected vault remains visible when the agent can search it.
2. Keep Search and Messages prominent. Follow with Favorites and the document/project navigation. Recent documents may be a compact disclosure or search section instead of twelve permanently expanded rows.
3. Keep specialist surfaces under an expandable Tools section and let users pin frequently used destinations. Preserve Calendar, Map, Network/governance, agent activity, dashboards, and existing integrations.
4. Use one quiet document header for breadcrumb, navigation, save state, Share, Agent, and overflow actions. Retain tab switching, reordering, and closing with a compact optional tab strip and overflow. Do not remove tabs to match a mockup.
5. Move page-specific properties below the title as a compact disclosure. Links, history, and graph open contextual views without destroying the agent conversation.
6. Make Agent a dedicated companion panel. A temporary inspector may occupy the same physical region when needed, but its lifecycle cannot own or erase the conversation. On a wide screen, source preview can use a transient peek; avoid forcing four permanent columns.
7. Keep settings and service health accessible. A quiet sync summary replaces constant operator detail in the main writing frame; actionable errors still surface where they affect work.

Opening a citation uses a source peek first. “Open as document” navigates normally. In either case, a running turn remains bound to the original document. A clear header identifies the conversation's working document. Offer “Continue here” or “Return to working document” when browsing elsewhere, rather than changing context implicitly.

## Document editing

Use the existing editor engine and collaboration schema. Unify document chrome and behavior across the normal, collaborative, read-only, suggest-only, and governed-proposal surfaces before changing extensions.

- Selection toolbar: Ask agent, Comment, and relevant formatting. Commands must work with keyboard, touch, and assistive technology; hover is only an enhancement.
- Slash menu: keep existing block types and shortcuts, add discoverable agent actions that open the same conversation rather than a separate chat implementation.
- Page properties: show a small useful subset; reveal complete metadata on demand. Integration configuration belongs in a distinct section.
- Outline: an optional headings panel or popover for long documents; preserve selection and scroll when opening it.
- Formatting: selection and slash controls are the default quiet treatment. Keep a full-toolbar preference and accessible menu entry for users who need it.
- Source preview: show title, relevant passage, provenance, and an open action. A denied or removed source shows an honest unavailable state without leaking its body.
- Empty documents: immediate typing and a few useful starting actions. Avoid a dashboard of unrelated features.
- History: reuse the newly delivered vault history UI. Keep full-version restore distinct from accepting one proposal or undoing one local edit.

Rich-content parity must be inventoried. The current plain editor registers table/image extensions that are absent from the current shared collaboration schema. This is a compatibility risk to verify, not permission to change serialized content as part of a styling pass. Preserve unsupported content with a fallback and explicit state until schema round-trip tests cover an additive change.

## Document conversations

### Session behavior

- On first use, create a document-bound session through the upstream AgentClient. Restore the last accessible session when returning to that document; allow additional named sessions and an explicit New conversation action.
- Keep the composer draft separate from execution state. Switching inspector tabs, resizing, navigating, or reopening the sheet must not clear it.
- Key state by server origin, actor, vault, document, and session. A document ID alone is not a safe global identity.
- Opening another document restores its own conversation when the user chooses that document's Agent action. A source peek does not switch sessions.
- Show a small pending-work indicator when the agent is running elsewhere. The full Agent surface remains a session/history view using the same state and components.
- Persist committed messages through upstream sessions; use the upstream transcript mirror for vault search. Do not create a second transcript source of truth.

### Composer and context

Use an auto-growing composer with attach-context, send, and stop controls. Show the working document and mode near it. Provide a visible keyboard hint on desktop. Do not send on Enter while an IME composition is active. On touch/mobile, Enter inserts a newline and the send button submits.

Context can include the current draft, a selected passage, explicit reference notes, and retrieval from the active vault. The server verifies access to each reference. A current draft is distinguished from the last saved version, so the agent never silently answers against stale saved content while the user sees newer text.

The compact context display distinguishes:

| State | Label example | Meaning |
| --- | --- | --- |
| Search permission | “Can search Personal vault” | Available scope, not a claim that everything was read |
| Explicit attachment | “This page · Selected passage · 2 notes” | Sources supplied for this turn |
| Retrieved evidence | “Used 3 sources” | Actual sources returned by retrieval/tool activity |
| Limited source | “Excerpt used” or “Source unavailable” | Content was truncated, stale, denied, or missing |

Show citations close to supported claims. The expanded source view identifies the relevant passage and version/time where available. Let the user remove a pinned source or change scope for the next turn. Do not offer cross-vault search in this release unless upstream explicitly implements permission-safe federation for that request.

### Agent modes

| Mode | User expectation | Backend requirement |
| --- | --- | --- |
| Ask | Answer, explain, summarize, and retrieve | Read-only tools and verified scope |
| Suggest changes | Produce reviewable proposed edits | Proposal-only writes; no direct target-content mutation |
| Edit directly | Apply authorized changes with an audit trail | Optional later exposure, explicit scope, collab-safe service |

Start with Ask and Suggest changes. Keep upstream power-user profiles reachable if already shipped, but do not relabel a whole-vault writable profile as “Suggest”. Disable unavailable modes with a short explanation. Agent read access to vault context does not imply permission to modify every source.

Render assistant prose as sanitized rich text. Show tool work as concise activity rows, expandable for detail. A completed tool action is evidence of that action; do not invent progress percentages or citations. Expose waiting, queued, running, cancelling, interrupted, failed, and complete states. Closing the panel disconnects the view, not the server task. Retry sends a new explicit turn or resumes through the upstream contract without duplicate side effects.

Keep the composer usable while a turn runs. The user can draft a follow-up, queue it visibly, or choose Stop and refine. A queued follow-up has its own immutable context snapshot and can be edited or cancelled before execution if the server supports that transition. Do not inject changed scope into an already running turn or launch two writers for the same conversation. Stop and refine waits for the authoritative cancellation/completion outcome before sending the next turn. If upstream has no turn queue yet, retain the draft and offer Send when finished rather than simulating an accepted queue locally.

## Reviewing changes

1. An agent produces a proposal linked to its session/turn, target document, baseline, and cited context.
2. The conversation shows “2 proposed changes” and Review. The proposal has not yet changed the target text.
3. Review reveals localized additions/deletions in the document, with previous/next change controls and Accept/Dismiss.
4. Accept applies through the shared server/collaboration service. The client must not replace the full editor content to simulate acceptance.
5. If the anchor or baseline became stale, show the current passage and ask for refresh/reproposal. Do not apply at a guessed position.
6. Return to the conversation with the same scroll and draft. The proposal record shows accepted, dismissed, conflicted, or unavailable accurately on every device.

Reuse upstream suggestion/comment capabilities where appropriate. Keep ordinary tracked suggestions and governed proposals distinct: accepting an agent suggestion cannot bypass a governance vote or the actor's effective capabilities. A viewer may ask about permitted content but receives no editing controls; owner-only runtime availability from architecture v2 remains enforced.

An optional Accept all action is available only when the server defines its atomicity or reports each result explicitly. If acceptance succeeds for one edit and conflicts for another, preserve both statuses. Undo reverses the accepted transaction when safe; it does not blindly restore the entire document over another person's newer edits.

## Mobile web and PWA

The phone should have one primary task surface at a time:

| Surface | Behavior |
| --- | --- |
| Document | Full-width reading/editing, compact header, stable scroll and selection |
| Agent | Nearly full-height sheet or route, title and working-document chip, visible Back to page and close |
| Change review | Full-width passage with pinned Accept/Dismiss controls and Back to conversation |
| Messages | Conversation list, then full-width thread; back returns to the same filtered list position |
| Context picker | Searchable full-width sheet with selected references and clear Done action |

Use labeled Browse, Search, Agent, and More controls as the starting bottom-navigation design. Keep New and open documents one action away inside Browse/More; validate this tradeoff against current creation usage at F00. In messages, the reply composer owns the bottom region. Do not stack a global floating pill, reply box, and review toolbar over one another.

Account for the visual viewport and safe areas. The keyboard must not cover the composer or acceptance controls. Opening a menu or sheet manages focus; closing restores it. Apply drag-to-dismiss only from a handle or when the scroll container is at its boundary, so reading a conversation cannot accidentally dismiss it. Support Back, Escape, and an explicit close control rather than gestures alone.

Persist drafts locally during offline use; present agent requests and external replies as requiring connection. Do not silently queue outbound messages for later delivery. Resume upstream streams after foregrounding and show missed events once. Reconcile notification deep links with the correct actor, vault, document, and session; never display cached content from the previous account while authentication is unresolved.

## Search and connected context

Use a shared result model for the command palette, sidebar search, source picker, and message search where applicable. Each result shows a title, type, useful passage, and location. Provide distinct Open and Add to context actions. Keep commands discoverable without mixing them indistinguishably with document results.

Preserve tag-driven organization and file/path navigation. Improve labels and previews before changing the underlying ontology. A related-context section can show backlinks and retrieved related notes, with its basis identified. No graph is required to understand the agent's sources; graph and map remain optional exploration tools.

## Existing capabilities to preserve

Keep document, code, spreadsheet, canvas, presentation, website, tasks, projects, dashboards, calendar, email, messages, map, network, governance, publishing, share links, history, and multi-vault navigation reachable. Preserve their current deep links and permissions. Any consolidation of entry points gets an explicit old-to-new mapping in F00/F02, plus redirects or aliases where needed.

## Concept references

These images were generated with the built-in image generator during the initial review and copied here for a durable reference. All document text and source names in them are fictional. The briefs were: a light document-and-agent workspace; a dark in-document change review; and a three-screen mobile write/ask/review flow. They are not literal layouts to implement without testing.

![Light desktop concept with document and agent companion](assets/desktop-collaboration.png)

![Dark concept with inline review and source context](assets/desktop-review.png)

![Mobile concept showing writing, conversation, and change review](assets/mobile-workflow.png)

Implementation corrections to the concepts: retain tabs and creation affordances; derive all source counts and states from real data; make proposed-change counts consistent across screens; use actual permission-gated actions; provide an accessible theme-consistent Prism mark rather than adopting the generated icon as a new brand asset.

# Message thread reliability and design

> **Historical design reference (2026-09-30, pre-migration `c191b52`).** The [post-migration plan](POST-MIGRATION-PLAN.md), [current contracts](DOMAIN-CONTRACTS.md), and [release gates](RELEASE-GATES.md) supersede runtime assumptions, sequencing, and authority statements below. Retain applicable interaction details. Each agent session now supports **Read-only, Suggested edits only, and Read/write**; earlier Ask/Suggest examples are not a restriction. Concept logos are placeholders pending [BRAND.md](BRAND.md).

Status: planned. Implement through F06–F08 in [WORKPLAN.md](WORKPLAN.md), using architecture v2's delivered ingest and live-action services. Source findings below describe the pre-implementation snapshot at `c191b52` and must be rechecked at handoff.

## User requirements

The user wants it to be as easy to see who is responding as in a regular messaging app. They also report tagging/visual bugs around the top bars and intermittent message rendering bugs. Sender identity, header stability, tagging, and readable message bodies are release criteria, not optional cosmetic follow-ups.

Capture the exact affected thread types and viewport conditions during F00. Use synthetic or locally sanitized reproduction fixtures; never commit real conversations or account details to this public repository.

## Evidence and proposed fixes

| ID | Source-backed observation | Consequence or risk | Planned correction |
| --- | --- | --- | --- |
| MSG01 | [MessageRenderer](../../../packages/core/src/components/renderers/MessageRenderer.tsx) parses only matching single lines and skips all others | Multiline bodies lose continuation paragraphs; `[unknown]` entries disappear | Parse entry boundaries while preserving every continuation line; provide an explicit unknown timestamp and raw-text fallback |
| MSG02 | Its sender expression stops at the first colon; it invents line-index event IDs and sets every fallback message to incoming | Sender labels can be ambiguous, outgoing identity is lost, IDs move when history rolls over | Preserve uncertainty for legacy data; use structured sender/event identity for new messages and stable source references |
| MSG03 | [The server writer](../../../apps/server/src/worker/matrix.ts) writes UTC stamps without a zone; the renderer parses them as local time | Apparent times vary incorrectly with client timezone | Parse this known legacy format as UTC, display in the selected/local timezone, test DST boundaries |
| MSG04 | [MessageThread](../../../packages/core/src/components/comms/MessageThread.tsx) groups solely by sender | Same-sender messages across long gaps or dates merge into one group | Group by stable sender identity, direction, day, and bounded time gap; render explicit date separators |
| MSG05 | Message bodies render as ordinary `{msg.body}` text without whitespace preservation or media treatment | Newlines collapse; links, long tokens, attachments, and rich-message fallbacks are poorly represented | Shared safe message-body rendering with preserved whitespace, linkification, wrapping, and typed attachment/fallback blocks |
| MSG06 | Thread effect scrolls to bottom on every `messages.length` change | Receiving or prepending messages moves someone reading older history | Anchor-aware scrolling, bottom proximity detection, and a New messages button |
| MSG07 | Renderer passes `hasMore` but no `onLoadMore`, loading state, or cursor | Advertised older-message support has no working pagination path there | Real paginated query/adapter and explicit Load older control as well as top-of-scroll trigger |
| MSG08 | Any nonempty live Matrix batch replaces the complete parsed vault list | The visible conversation can shrink or change identity when live data arrives | One normalized timeline; reconcile only by reliable IDs/proven overlap; never wholesale swap history |
| MSG09 | [MessageComposer](../../../packages/core/src/components/comms/MessageComposer.tsx) does not await `onSend` and clears immediately | A failed send loses the visible draft and has no trustworthy delivery state | Await acceptance, preserve recoverable drafts, use client request IDs, expose sending/failed/unknown/confirmed |
| MSG10 | A missing room ID makes the renderer's send handler return without sending | The composer can appear to succeed despite no destination | Gate send on a resolved authorized destination and actual backend capability |
| MSG11 | Triage is copied to local state once; tag removal and addition are separate writes; send initiates best-effort handled tags | Stale labels and partial mutations are possible; replying silently changes classification | Resynchronize authoritative state; atomic scoped triage mutation; explicit Mark handled action after confirmed send |
| MSG12 | [VaultMessagesDashboard](../../../packages/core/src/components/comms/VaultMessagesDashboard.tsx) fetches up to 500 threads/200 email notes and the full graph for people | Totals/search can be incomplete and list loading is expensive | Server summary projection, cursor pagination, explicit incomplete state, targeted person relationships |
| MSG13 | List previews use the last non-heading line, titles use path slugs, and People view requires links | Previews may be continuation text or metadata; names look technical; unlinked threads disappear from People view | Summary title/last-message fields; readable participant names; clearly available All conversations and Unlinked filters |
| MSG14 | [Rollover](../../../apps/server/src/worker/matrix-rollover.ts) emits `message-archive` notes and a pointer; renderer has no archive handling | Older saved messages are absent from the thread view after rollover | Permission-aware archive traversal with stable ordering, overlap recovery, and a bounded page size |
| MSG15 | Top headers, triage-tier sticky bars, outer Canvas scrolling, and inner thread scrolling coexist | Candidate cause of reported top-bar overlap and clipping; exact layout remains to reproduce | One scroll owner per panel, explicit sticky offsets, minimal header hierarchy, and screenshot tests with keyboard/open menus |
| MSG16 | [EmailRenderer](../../../packages/core/src/components/renderers/EmailRenderer.tsx) derives account/recipient/threading from legacy metadata and includes a hard-coded account fallback | A reply can use an incorrect destination/account; sender presentation lacks a normalized model | Use authoritative account and reply capabilities; show account/To/Cc; never guess from a hard-coded fallback |

These observations do not claim every symptom was reproduced in the browser. In the initial review, the local web app required sign-in. F00 establishes runtime evidence and marks fixes already supplied upstream as complete/reused.

## Conversation list

Use a familiar master/detail layout on desktop and list-to-thread navigation on mobile. Keep one Messages header with search and a compact filter control. Preserve Triage, People, and Platform views as filters/groupings over the same authorized summary model rather than three divergent collections.

Each conversation row shows:

- Readable conversation title: source title or verified person name, with a group indicator where appropriate.
- Avatar or initials, plus a small source badge; platform color is a secondary cue.
- Last sender and a clean last-message preview, with sensible attachment text.
- Time of the last actual message, independent of a later triage/metadata edit.
- Unread indicator only when a trustworthy source/read-state contract exists. Unknown is not zero.
- At most one primary triage label; secondary tags stay behind a disclosure.

Show loading, refreshing, no conversations, no matches, permission denied, disconnected source, and partially available data as distinct states. Preserve list filters, query, selection, and scroll on return from a thread. Conversation counts reflect the filtered server result or are explicitly partial; never label a 500-item client slice as the whole inbox.

## Sender identity

1. The server resolves identity from the platform account, room, stable sender ID, and available person links. A display name is presentation, not an identity key.
2. Prefer a verified display name, then a meaningful source handle, then a stable distinguishable fallback. Never render several unknown people as the same generic “User”.
3. Show sender name at each incoming group, including group chats. A compact avatar/initial helps scanning, but color alone never identifies a speaker.
4. Establish “You” from the authenticated integration account's identity mapping, including bridged puppet identities where supported. Do not infer it from a matching name or phone-number suffix.
5. For legacy notes that cannot establish direction, show the recorded name on a neutral message. Do not fabricate outgoing alignment or a delivery receipt.
6. A participant popover shows the resolved person and source identity only to authorized readers. Navigation to a person record must not leak a hidden profile.
7. Display-name changes may update visible labels without rekeying messages, merging participants, or losing scroll anchors.

Acceptance fixtures include two people sharing a display name, names with a colon, non-Latin names, missing names, a renamed sender, the user's bridged account, and a group thread.

## Thread rendering

Give each panel one explicit scrolling area. The thread header contains title, participants/source, and a compact triage/status control. Put the workspace header above it with a known fixed height. Avoid repeating the same title in several tall bars. Menus render in a correctly layered portal and must not be clipped by the thread scroller.

Group consecutive messages by identity and direction only within a short configured window (initial target five minutes) and on the same displayed calendar day. Insert Today/Yesterday/date separators at day changes. A selected or focused message exposes its exact timestamp and source state; relative time alone is insufficient for older conversations.

The body renderer must:

- Preserve newlines, blank paragraphs, whitespace-sensitive snippets, emoji, and Unicode.
- Wrap long links and tokens without horizontal page overflow; allow code blocks to scroll internally.
- Sanitize rich content with the existing shared sanitizer and a message-specific allowlist. Treat plain text as plain text; never interpret arbitrary message bodies as trusted HTML.
- Render supported image/file/audio/video metadata through authenticated media access, with loading/error states. Show a clear attachment placeholder when only metadata or a filename exists.
- Represent edits, redactions, replies, and reactions only when structured source data supports them. A redacted message remains an explicit placeholder; a reply links to its target or says it is unavailable.
- Collapse long quoted email history/signatures behind a reversible disclosure while preserving access to the full text. Keep email headers and Matrix-style bubbles distinct where their semantics differ.
- Provide a readable raw transcript fallback when legacy content cannot be parsed confidently. No blank screen or silent loss of unmatched content.

Reserve space for media dimensions where known so loading an image does not repeatedly move the reading position. Rendering and caching must respect revocation and source availability; do not embed credential-bearing URLs.

## Scrolling and history

On first open, restore a saved anchor if available; otherwise open the relevant unread location when known, or the newest messages. Keep the newest end visible during incoming messages only if the reader is already near the bottom. When they are reading older content, preserve the anchor and show a New messages action.

For older-page loading, record the first visible message ID plus pixel offset. Prepend the page and restore that anchor after layout, including delayed media height changes. A manual Load older button remains available to keyboard and screen-reader users. Guard against repeated requests for an unchanged cursor and ignore stale responses from a previously selected thread.

Use a bounded render window for long histories only after measuring the non-virtualized baseline. Virtualization must preserve text selection, focused controls, accessibility, and anchors. Message identity must not be an array index. Legacy snapshot IDs are explicitly weaker than source event IDs; map them across revisions only when correspondence is proven.

## Archive reading

The server builds a normalized page from the current thread and its `archiveOf` chain. Reuse the rollover parser's entry-boundary semantics rather than inventing another incompatible format. The live note's `lastArchivePath` is a pointer, not an authorization grant.

Rules:

1. Check the requesting actor and vault for every source note. Reading the live note does not automatically authorize all matching archive paths. Align archive grants with upstream permission policy explicitly; otherwise return only permitted history without leaking hidden counts or titles.
2. Order archive pages deterministically using archive sequence plus entry order; known timestamp ties preserve source order. Unknown timestamps remain unknown.
3. Recognize the crash window where an archived block still appears in the live note using the writer's recorded hashes/counts. Do not delete duplicates merely because sender/text/minute match; identical messages can be legitimate.
4. Include current/archive revision information in opaque pagination cursors. Detect invalidated cursors during rollover and re-anchor, rather than silently skipping or repeating a page.
5. Bound archive reads per request and cache rebuildable projections. Opening a thread must not load all historical note bodies or trigger a full vault scan.
6. Preserve current note IDs, paths, archive metadata, tags, and searchability. This is initially a read-model correction, not a destructive transcript migration.

Legacy transcripts do not contain all source event IDs, directions, exact times, or relations. Show their limitations honestly. Backfill from the original service only when IDs and permissions can be verified; do not promise to reconstruct facts that were discarded.

## Structured message records

F06 first delivers a loss-preserving legacy adapter and paginated read contract. F08 adds versioned structured records for newly ingested messages if architecture v2 has not already supplied them. This separates immediate rendering repairs from a risky historical migration.

Keep canonical message data in Parachute. Use bounded, versioned event chunks linked to the existing thread with explicit metadata (schema version, source account/room, cursor coverage, time range, and archive relationship). Exact tag/field names are fixed during F06 and checked against the delivered ontology. Server indexes are rebuildable projections, not another source of truth. Do not place a growing JSON array on the live note or create an unbounded note per event without measuring the vault cost.

New structured records preserve event ID, sender ID/display name, UTC timestamp, body format, direction evidence, relation/target IDs, attachment metadata, and redaction/edit state. Fold relation events into the display model while retaining provenance. The existing human-readable transcript remains available for compatibility, agent context, and rollback. Record which source/revision generated each projection; never dual-write without idempotency and a recovery path.

During cutover, select one authoritative representation per covered range. Fill uncovered ranges from legacy text. Merge across representations only with verified source identity/coverage or explicit archive recovery evidence. Route updates through the single server ingest owner from architecture v2; no parallel desktop writer is introduced.

## Sending and replying

Use WP1.5's routes and audited permissions. A visible composer requires both a known destination and a backend capability; a readable archived thread can still be read-only. Show why replying is unavailable without suggesting the user must run the old desktop app.

The common composer has a per-actor/vault/thread draft, auto-grow, attachment capability state, keyboard handling, and send status. A request receives a stable client operation ID. On a confirmed submission, reconcile the pending bubble to the returned event/message ID. On failure, retain the text and offer Retry/Edit. When delivery is uncertain, show “Checking delivery” or “Delivery unconfirmed”; do not resend automatically.

Matrix: use its transaction identity through the server where available. Gmail: do not claim exactly-once delivery if the provider cannot guarantee it; store a dispatch record and reconcile before offering retry. No draft may disappear solely because the HTTP request started. Switching to another thread must not send the old draft to the new destination.

For email, show the actual sending account, To/Cc, subject, and reply/reply-all choice supported by the backend. Preserve message threading fields. Remove hard-coded account fallbacks. For a person with multiple channels, require a resolved channel/destination instead of choosing the first matching name.

Agent help is “Draft reply”, “Summarize”, or “Extract tasks” with the exact selected thread/messages as context. A proposed reply enters the human composer. Draft generation never itself authorizes delivery. Existing operator-authorized agent send profiles remain a separate explicit capability and audit path.

After a successful reply, offer Mark handled as a separate action. A reply does not prove every task in the conversation is handled. Triage writes preserve unrelated tags and report conflict/failure instead of silently swallowing it.

## Tagging and top bars

Use one authoritative classification state, with a pending indicator and rollback on mutation failure. If a new message arrives and the ingest service removes stale triage tags, refresh the chip and list grouping together through the upstream event channel. Display unknown or social classifications accurately rather than mapping every unlisted value to Unclassified.

F07's bar audit covers app header, thread header, filter row, sticky group heading, inspector tabs, composer, and mobile action strip. For each viewport, document height, scroll owner, sticky offset, and stacking order. Remove accidental duplicate borders and redundant labels. On mobile, put secondary filters in a sheet; the active filter has a concise visible summary. During keyboard entry, the composer gets the available bottom space.

Acceptance: long thread titles and multiple tags cannot cover message text; menus remain clickable; scrolling does not accumulate sticky tier bars; browser zoom and orientation changes do not clip controls; no full-page horizontal scrolling at 320 px width.

## Message completion criteria

- A reader can identify each speaker and their own replies wherever source identity permits it; ambiguity is explicit elsewhere.
- The normalized legacy view preserves all message body content, including continuation lines and unknown timestamps.
- UTC stamps display correctly in two distinct client timezones and across a DST boundary.
- Fetching older history, incoming messages, opening the keyboard, and media loading preserve the reading position.
- Rollover archives are accessible according to real permissions and do not duplicate the list's conversation count.
- Failed sends retain drafts; retries do not knowingly double-send; uncertain delivery stays visible.
- Headers and triage controls pass the user-reported bar/tagging regression scenarios in both themes.
- Email and Matrix use the same reliable interaction states while retaining their distinct reply semantics.

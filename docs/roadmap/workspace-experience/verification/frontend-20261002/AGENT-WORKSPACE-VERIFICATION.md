# B01–B03 — Agent workspace presentation

Traceable to FRONTEND-ACCEPTANCE B01–B03; DESIGN “Composer and context” and “Agent modes”; boards 02, 03, 04, 05, and 18. All screenshots and requests use fictional fixture data. No real agent execution, production mutation, or native operation was performed.

## B01 — One conversation workspace

Implemented a quiet recent-session rail with explicit New conversation, local title filter, date groups, status, separate keyboard-accessible archive action, and list recovery. “Recent” and the latest-50 disclosure deliberately distinguish the existing loaded list from whole-history search.

The working-document preview and unchanged permission controls now share the conversation header. Hosts without permission-changing support still show their current profile/mode. The same durable session/controller/draft keys power full and companion views. Sender identity, transcript width, prompt fill, touch targets, and the unified composer surface follow the approved boards. Existing permission transitions, budget displays, safe areas, IME/mobile Enter, and send guards remain.

## B02 — Context and source clarity

The source picker separates included notes from search results, supports removal in its included tray, and displays returned title/path plus a plain-text excerpt only when already available in the search result. It does not fetch more notes just to produce snippets. Saved source previews identify the returned saved update date and retain exact timestamp metadata. Captured text still uses the existing snapshot preview and access checks.

All labels distinguish supplied/saved/captured context from sources actually used. No inferred source-use claims were added. Source and picker launchers explicitly receive focus so Escape restores the correct launcher in Safari as well as Chromium.

## B03 — Activity and stop state

Existing tool names, outcomes, and summaries are readable in an Activity disclosure rather than hover-only pills. Long summaries scroll within the disclosure. Reconnect feedback is visible in the compact companion. Queue cards retain existing edit/remove/review/resume, source previews, and permission explanations.

An explicit Stop displays “Stop requested” and suppresses duplicate stop requests until an authoritative terminal state arrives. Failed or unaccepted requests keep the task live and explain uncertainty. A terminal event clears pending stop state synchronously, protecting against a later stop response. Session/unmount lifecycle guards prevent a late acknowledgement from changing another conversation. No reducer or API contract changed, and turn/follow-up retry receipts are untouched.

## Verification

- Chromium: all 42 focused agent, snapshot, queue, context-visual, workspace-visual, and state journeys pass.
- WebKit: all 42 focused journeys pass.
- Web TypeScript check and aggregate `tsconfig.e2e.json` check: pass.
- Visual review: full desktop, 390px and 320px; light and dark; source picker, source preview, long activity and reconnect. Selected fictional PNGs are stored beside this note.

New checks include local filtering/recovery, retained session and draft across responsive breakpoints, included-note removal, saved-source labels, long tools/reconnect, duplicate Stop, true/false acknowledgement, terminal-before-response, stop failure, and late session/unmount responses. Existing checks continue to cover all permission modes/pending changes, draft recovery, lost receipts, context access denial, snapshot capture, queue editing and cancellation, and IME/mobile input behavior.

## Boundaries

This is presentation and frontend lifecycle work on existing capabilities. It does not implement server-wide history search, invent richer source provenance, change agent permissions on behalf of the user, or complete unrelated proposal-review requirements. A06 selection-to-agent integration is a separately coordinated slice. Production, physical keyboard/IME, and installed native verification remain part of the coordinated integration pass.

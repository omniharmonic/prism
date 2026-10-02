# B05 — Focused suggestion review

Reference: FRONTEND-ACCEPTANCE B05 / R07.1,4–5 and board06. The existing live review queue now shows one change at a time with previous/next, current count, actual author and marked agent provenance, readable remove/insert blocks,44px actions, and keyboard focus retained on the next review after a decision. Remote changes resolve against current positions; identified replacements retain paired accept/reject behavior. View-only users can inspect and navigate without review commands. The underlying sync/command semantics are unchanged.

Visual inspection found the pre-existing inline suggestion bubble could float over the review panel while the editor was unfocused. It now appears only while the editor or that bubble has focus. This keeps inline review available when using Show in document without obscuring the queue.

24 combined Chromium/WebKit review and selection-to-agent journeys pass after the final focus fix. Aggregate fixture types pass. The review fixture uses two actual TipTap/Yjs bindings to the same Y.Doc, not two networked browsers: it verifies peer position shifts, remote review removal, paired replacement rejection, read-only downgrade, retained body, and focus after the last review. Fictional1440/390/320 screenshots are retained beside this note; the dark320 result was inspected after correcting bubble overlap and button contrast.

Initial fixture attempts failed because the isolated editor lacked a QueryClient provider, and later selectors matched both inline and queue Accept actions. Those fixture errors were fixed, then the actual visual overlap was corrected and the affected journeys rerun. No production or native acceptance yet.

Not included: durable review audit/inverse undo, a safe turn-to-session return link (the marks provide no session destination), human command composer/enforcement, or a claim that this local review action is already durable. The host's save/sync status remains authoritative.

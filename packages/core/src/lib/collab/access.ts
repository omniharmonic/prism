/**
 * What a live-collab client may OFFER at a given share level. Pure, so the web
 * shell and the server tests read the same table.
 *
 * The server (apps/server/src/collab.ts `authorizeConnection`) marks every
 * socket below "suggest" READ-ONLY, and Hocuspocus silently drops a read-only
 * connection's updates. A comment thread IS such an update — its anchor is a
 * `comment` mark in the body fragment and its data lives in the doc's
 * `comments` Y.Map (editor/comments.ts) — so a "comment"-level user cannot
 * persist a comment. COMMENTS NEED SUGGEST: offering the affordance below that
 * would let a user type a comment that vanishes on reload. (A server-side
 * "comments-map-only" filter was rejected as unsafe: the anchor is a body write,
 * and dropping one of a client's updates leaves a gap in its Yjs clock, so every
 * later update from that client would pend forever.)
 *
 * `level` is the note's `_level` from the gateway; null = unknown (the owner
 * path / a failed fetch), which keeps full affordances — the server still
 * enforces whatever the socket was actually granted.
 */
export interface CollabAffordances {
  /** Body is editable (directly, or as tracked suggestions typed into the doc). */
  editable: boolean;
  /** Edits are forced into suggestion mode (suggest level). */
  suggestOnly: boolean;
  /** May add / reply to / resolve comment threads. */
  canComment: boolean;
  /** May accept/reject suggestions, rename, etc. */
  canReview: boolean;
  /**
   * Suggest-only enforcement (NP-CO-12): the socket is read-only, so suggestions
   * and comments go through server-authored commands
   * (`POST /api/collab/:id/commands`) and the body is NEVER locally editable —
   * keystrokes would be refused by the server and linger in the local Y.Doc.
   */
  commands: boolean;
}

/** What the server granted this socket (`provider.authorizedScope`); undefined = not yet known. */
export type CollabSocketScope = "read-write" | "readonly" | undefined;

/**
 * `socketScope` is the scope the live socket was ACTUALLY authorized with. A
 * suggest-level person gets a writable socket only while the server runs with
 * `COLLAB_SUGGEST_ENFORCED=false` (the rollback switch); otherwise — and while
 * the scope is still unknown — they use commands and the body stays read-only.
 * A read-only socket for an editor (a locked page) is read-only too.
 */
export function collabAffordances(level: string | null, socketScope?: CollabSocketScope): CollabAffordances {
  if (level === null || level === "edit" || level === "own") {
    const editable = socketScope !== "readonly";
    return { editable, suggestOnly: false, canComment: editable, canReview: editable, commands: false };
  }
  if (level === "suggest") {
    if (socketScope === "read-write") {
      return { editable: true, suggestOnly: true, canComment: true, canReview: false, commands: false };
    }
    return { editable: false, suggestOnly: true, canComment: true, canReview: false, commands: true };
  }
  // "view", "comment", or anything unrecognized: read-only on the socket, so
  // offer nothing that writes to the shared doc.
  return { editable: false, suggestOnly: false, canComment: false, canReview: false, commands: false };
}

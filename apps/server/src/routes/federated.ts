/**
 * Federated-note lookup — maps a LOCAL note id → its `space_note_key` (the
 * cross-hub Yjs documentName). A hub's own collab clients call this before
 * opening a note so a FEDERATED note is opened under the SAME doc the bridge
 * syncs (the one-doc model, federation gap #2). Without it the browser opens the
 * doc by local id while the bridge serves it under space_note_key, so local
 * edits are persisted but never federated.
 *
 * GATED: returns 204 when federation is off, and 204 for a non-federated note.
 * It only ever returns the UUID mapping (+ space id + pinned kind), never note
 * content. Mounted at /api/federated BEFORE the /api gateway so the owner
 * short-circuit doesn't proxy it to the vault (which has no such route), and so
 * the PWA service-worker denylist (/^\/api\//) already covers it.
 */
import { Hono } from "hono";
import { getFederatedByLocal, getFederationEnabled } from "../db";
import { resolveActor } from "../auth/actor";

export const federated = new Hono();

federated.get("/:noteId", (c) => {
  if (!getFederationEnabled()) return c.body(null, 204);
  // Only THIS hub's own clients need this mapping (owner/session/capability).
  // Anonymous callers get 204 — no federation-membership enumeration oracle.
  if (resolveActor(c).kind === "anon") return c.body(null, 204);
  const fed = getFederatedByLocal(decodeURIComponent(c.req.param("noteId")));
  if (!fed) return c.body(null, 204);
  return c.json({ spaceNoteKey: fed.space_note_key, spaceId: fed.space_id, kind: fed.kind });
});

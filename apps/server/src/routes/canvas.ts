import { Hono } from "hono";
import { resolveActor } from "../auth/actor";
import { effectiveCaps } from "../permissions";
import { resolveVaultEntry } from "../db";
import { roleFloor } from "../roles";
import {
  vaultClient,
  VaultConflictError,
  VaultError,
  type Note,
} from "../parachute";
import { hocuspocus, docNameFor, noteKind, CANVAS_FIELD } from "../collab";
import {
  reconcileCanvasRelations,
  CanvasRelationError,
} from "../canvas-relations";

export const canvasApi = new Hono();
canvasApi.post("/:id/relationships", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  if (
    c.req.header("x-prism-vault") &&
    c.req.header("x-prism-vault") !== actor.vaultId
  )
    return c.json({ error: "vault_unavailable" }, 409);
  const input = await c.req.json().catch(() => null);
  if (
    typeof input?.fingerprint !== "string" ||
    input.fingerprint.length > 200_000
  )
    return c.json({ error: "bad_request" }, 400);
  const id = c.req.param("id");
  const entry = resolveVaultEntry(actor.vaultId);
  const authorize = (note: Note) => {
    const fresh = resolveActor(c);
    const now = resolveVaultEntry(fresh.vaultId);
    if (
      fresh.kind === "anon" ||
      fresh.vaultId !== actor.vaultId ||
      now.url !== entry.url ||
      now.vault !== entry.vault
    )
      throw new CanvasRelationError("not_found");
    const caps = effectiveCaps(
      fresh.grants,
      {
        id: note.id,
        tags: note.tags ?? [],
        creator:
          typeof note.metadata?.prism_creator === "string"
            ? note.metadata.prism_creator
            : null,
        visibility:
          note.metadata?.prism_visibility === "private"
            ? "private"
            : "workspace",
        path: note.path ?? null,
      },
      roleFloor(fresh.role),
      fresh.kind === "user" ? fresh.email : fresh.capabilityId,
    );
    if (!caps.has("view") || !caps.has("edit"))
      throw new CanvasRelationError("not_found");
  };
  try {
    const result = await reconcileCanvasRelations({
      vaultId: actor.vaultId,
      canvasId: id,
      fingerprint: input.fingerprint,
      authorize,
      scene: async () => {
        const note = await vaultClient(actor.vaultId).getNote(id);
        authorize(note);
        if (noteKind(note) !== "canvas")
          throw new CanvasRelationError("not_canvas");
        const live = hocuspocus.documents.get(docNameFor(actor.vaultId, id));
        if (live) return [...live.getMap(CANVAS_FIELD).values()];
        const parsed = JSON.parse(note.content || '{"elements":[]}');
        if (!Array.isArray(parsed.elements))
          throw new CanvasRelationError("invalid_scene");
        return parsed.elements;
      },
    });
    c.header("Cache-Control", "private, no-store");
    return c.json(result);
  } catch (e) {
    if (
      e instanceof VaultConflictError ||
      (e instanceof CanvasRelationError && e.message === "scene_changed")
    )
      return c.json({ error: "scene_changed" }, 409);
    if (
      (e instanceof CanvasRelationError && e.message === "not_found") ||
      (e instanceof VaultError && e.status === 404)
    )
      return c.json({ error: "not_found" }, 404);
    return c.json({ error: "relationships_unavailable" }, 503);
  }
});

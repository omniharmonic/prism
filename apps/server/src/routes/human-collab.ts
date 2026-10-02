import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { resolveActor, type Actor } from "../auth/actor";
import { accessRevision } from "../access-events";
import { effectiveCaps } from "../permissions";
import { roleFloor } from "../roles";
import { getUser, getVaultRegistry } from "../db";
import { vaultClient, VaultError, type Note } from "../parachute";
import { docNameFor, hocuspocus, noteKind } from "../collab";
import { applyHumanCommand } from "../human-collab";
import { colorFor, CollabOpError, CollabConflictError } from "../collab-ops";
import { rateLimit } from "../middleware/ratelimit";
const base = { requestId: z.string().uuid(), createdAt: z.number().int(), revision: z.string().regex(/^[a-f0-9]{64}$/) };
const range = { from: z.number().int().min(1).max(5_000_000), to: z.number().int().min(1).max(5_000_000), quote: z.string().max(10_000) };
const command = z.discriminatedUnion("kind", [
  z.object({ ...base, ...range, kind: z.literal("suggest"), text: z.string().max(10_000) }).strict(),
  z.object({ ...base, ...range, kind: z.literal("comment"), text: z.string().trim().min(1).max(10_000) }).strict(),
  z.object({ ...base, kind: z.literal("reply"), threadId: z.string().min(1).max(200), text: z.string().trim().min(1).max(10_000) }).strict(),
  z.object({ ...base, kind: z.literal("resolve"), threadId: z.string().min(1).max(200), resolved: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal("delete-comment"), threadId: z.string().min(1).max(200) }).strict(),
]);
const identity = (actor: Actor) => actor.kind === "user" ? `user:${actor.email}` : actor.kind === "link" ? `capability:${actor.capabilityId}` : "anonymous";
const allowed = (actor: Actor, note: Note) => {
  const caps = effectiveCaps(actor.grants, { id: note.id, tags: note.tags ?? [], creator: typeof note.metadata?.prism_creator === "string" ? note.metadata.prism_creator : null, visibility: note.metadata?.prism_visibility === "private" ? "private" : "workspace" }, roleFloor(actor.role), actor.kind === "user" ? actor.email : actor.kind === "link" ? actor.capabilityId : null);
  return actor.kind !== "anon" && caps.has("view") && (caps.has("suggest") || caps.has("edit"));
};
export const humanCollabApi = new Hono();
humanCollabApi.use("*", bodyLimit({ maxSize: 80_000 }));
humanCollabApi.use("*", rateLimit({ max: 120, windowMs: 60_000, name: "human-collab" }));
humanCollabApi.post("/:id/commands", async c => {
  c.header("Cache-Control", "no-store");
  const actor = resolveActor(c);
  const targetVault = c.req.header("x-prism-vault");
  if (actor.kind === "anon") return c.json({ error: "Sign in or open a valid sharing link." }, 401);
  if ((targetVault && (targetVault !== actor.vaultId || !getVaultRegistry().some(v => v.id === targetVault))) || !getVaultRegistry().some(v => v.id === actor.vaultId)) return c.json({ error: "Workspace changed. Reopen this document." }, 409);
  const parsed = command.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid collaboration command." }, 400);
  const id = c.req.param("id");
  if (!id || id.length > 200 || id.includes("::")) return c.json({ error: "Invalid document." }, 400);
  try {
    let note = await vaultClient(actor.vaultId).getNote(id);
    if (!allowed(actor, note)) return c.json({ error: "Suggest access is required for this document." }, 403);
    if (noteKind(note) !== "document") return c.json({ error: "Suggested edits and anchored comments are available only for prose documents." }, 400);
    const conn = await hocuspocus.openDirectConnection(docNameFor(actor.vaultId, id), { human: identity(actor) });
    try {
      // Recheck AFTER asynchronous document loading and note access. No awaits
      // between the final credential/grant/revision check and the mutation.
      const revision = accessRevision();
      note = await vaultClient(actor.vaultId).getNote(id);
      const fresh = resolveActor(c);
      if (revision !== accessRevision() || identity(fresh) !== identity(actor) || fresh.vaultId !== actor.vaultId || !allowed(fresh, note)) return c.json({ error: "Access changed. Reopen this document before trying again." }, 403);
      if (noteKind(note) !== "document") return c.json({ error: "This note is no longer a prose document." }, 409);
      if (!conn.document) return c.json({ error: "Could not open the live document." }, 503);
      const actorId = identity(fresh);
      const name = fresh.kind === "user" ? (getUser(fresh.email)?.name?.trim() || fresh.email) : "Guest";
      const result = applyHumanCommand(conn.document, parsed.data, { actorId, name, color: colorFor(actorId) });
      return c.json(result);
    } finally { await conn.disconnect(); }
  } catch (error) {
    if (error instanceof CollabConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof CollabOpError) return c.json({ error: error.message }, 400);
    if (error instanceof VaultError && error.status === 404) return c.json({ error: "Document unavailable." }, 404);
    console.error("[human-collab] command failed", error instanceof Error ? error.name : "unknown");
    return c.json({ error: "Could not confirm this change. Keep your draft and retry the same request." }, 502);
  }
});

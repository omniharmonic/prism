/** Lean project sections: no bodies, ACLs before membership/counts/paging. */
import { Hono } from "hono";
import { resolveActor, type Actor } from "../auth/actor";
import { effectiveCaps, type NoteRef } from "../permissions";
import { roleFloor } from "../roles";
import { vaultClient, VaultError, type Note } from "../parachute";
import { consumeRateLimit } from "../middleware/ratelimit";
import { PROJECT_SECTIONS, projectRelatedPage, type ProjectSection } from "@prism/core/projects";
export const projectsApi = new Hono();
const visible = (actor: Actor, n: Note) => effectiveCaps(actor.grants, {
  id: n.id, path: n.path ?? null, tags: n.tags ?? [],
  creator: typeof n.metadata?.prism_creator === "string" ? n.metadata.prism_creator : null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
} satisfies NoteRef, roleFloor(actor.role), actor.kind === "user" ? actor.email : actor.kind === "link" ? actor.capabilityId : null).has("view");
const MAX = 50_000;
const KEYS = ["projects", "project", "title", "name", "slug", "type", "prism_type", "status", "prism_creator", "prism_visibility", "prism_trashed_at", "merged_into", "due", "due_date", "date", "start_time"];
const cache = new Map<string, { at: number; value: Promise<Note[]> }>();
export function resetProjectInventoryForTests() { cache.clear(); }
function inventory(vaultId: string): Promise<Note[]> {
  const hit = cache.get(vaultId);
  if (hit && Date.now() - hit.at < 3_000) return hit.value;
  // Installed vault validates integer limit without a max and sorts deterministically.
  // One bounded lean read avoids offset races and repeated page requests.
  const value = vaultClient(vaultId).listNotes({ includeContent: false, includeMetadata: KEYS, limit: MAX, orderBy: "updated_at" });
  cache.delete(vaultId);
  cache.set(vaultId, { at: Date.now(), value });
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
  value.catch(() => { if (cache.get(vaultId)?.value === value) cache.delete(vaultId); });
  return value;
}
projectsApi.get("/:id/related", async c => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  if (c.req.header("x-prism-vault") && c.req.header("x-prism-vault") !== actor.vaultId) return c.json({ error: "vault_unavailable" }, 409);
  const kind = c.req.query("kind") ?? "documents";
  const after = c.req.query("after") ?? "";
  if (!(PROJECT_SECTIONS as readonly string[]).includes(kind) || after.length > 2048) return c.json({ error: "bad_request" }, 400);
  const retry = consumeRateLimit(`project-related:${actor.vaultId}:${actor.kind === "user" ? actor.email : actor.kind === "link" ? actor.capabilityId : ""}`, 120, 60_000);
  if (retry !== null) return c.json({ error: "rate_limited" }, 429);
  try {
    const project = await vaultClient(actor.vaultId).getNote(c.req.param("id"), { includeContent: false });
    if (!project || !visible(actor, project) || project.metadata?.prism_trashed_at || project.tags?.includes("prism-trashed")) return c.json({ error: "not_found" }, 404);
    if (!project.tags?.includes("project") && project.metadata?.type !== "project") return c.json({ error: "not_project" }, 400);
    const notes = await inventory(actor.vaultId);
    if (notes.length >= MAX) return c.json({ error: "project_inventory_limit" }, 503);
    const page = projectRelatedPage(notes.filter(n => visible(actor, n)), project, kind as ProjectSection, after);
    c.header("Cache-Control", "private, no-store");
    return c.json(page);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "not_found" }, 404);
    if (e instanceof Error && e.message === "project_cursor_changed") return c.json({ error: "project_cursor_changed" }, 409);
    return c.json({ error: "project_unavailable" }, 503);
  }
});

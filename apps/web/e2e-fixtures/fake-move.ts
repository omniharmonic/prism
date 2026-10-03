/**
 * The pages MOVE route (`POST /api/notes/:id/move`) for in-page fixture servers:
 * the page and everything under its path move together, compare-and-set on the
 * page's revision, a taken destination is a 409. Mutates `notes` in place.
 */
import { isUnder, movedPath, normalizePagePath, planSubtreeMove } from "../../../packages/core/src/lib/pages/model";

type Row = { id: string; path?: string | null; updatedAt?: string };

export function fakeMove(notes: Row[], id: string, body: Record<string, unknown>, stamp: () => string): { status: number; body: Record<string, unknown> } {
  const root = notes.find((n) => n.id === id);
  if (!root?.path) return { status: 404, body: { error: "not_found" } };
  const target = body.newPath !== undefined
    ? normalizePagePath(String(body.newPath))
    : movedPath(root.path, body.newParentPath ? normalizePagePath(String(body.newParentPath)) ?? "" : "");
  if (!target) return { status: 400, body: { error: "bad_request" } };
  if (target === root.path) return { status: 400, body: { error: "no_change" } };
  if (typeof body.if_updated_at !== "string") return { status: 428, body: { error: "precondition_required" } };
  if (body.if_updated_at !== root.updatedAt) return { status: 409, body: { error: "conflict", reason: "This page changed since you opened it. Reload and try again." } };
  if (isUnder(target, root.path)) return { status: 400, body: { error: "into_own_subtree", reason: "A page can’t move inside itself." } };
  const plan = planSubtreeMove(notes.map((n) => ({ id: n.id, path: n.path ?? null })), root.path, target, root.id);
  const moving = new Set(plan.map((m) => m.id));
  const clash = plan.find((m) => notes.some((n) => !moving.has(n.id) && n.path?.toLowerCase() === m.to.toLowerCase()));
  if (clash) return { status: 409, body: { error: "path_conflict", path: clash.to, reason: `A page already exists at ${clash.to}.` } };
  for (const m of plan) {
    const n = notes.find((x) => x.id === m.id)!;
    n.path = m.to;
    n.updatedAt = stamp();
  }
  return { status: 200, body: { ok: true, path: target, moved: plan.map((m) => ({ id: m.id, from: m.from, to: m.to })) } };
}

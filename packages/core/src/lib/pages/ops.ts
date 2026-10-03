/**
 * Page operations over the VaultClient seam. Shells with the Prism Server pages API
 * (web, Prism Client) use it — permission checks, protected locations and the
 * subtree as one server-side operation. Shells without it (the legacy desktop,
 * which talks to the vault directly) get the same behaviour from plain vault
 * writes here, so a sidebar delete is a Trash move everywhere and nothing is lost.
 */
import type { VaultClient } from "../../data/VaultClient";
import type { Note, NoteTreeEntry } from "../types";
import {
  PagesRequestError,
  TRASH_META,
  TRASH_TAG,
  isProtectedPath,
  isTrashed,
  isUnder,
  movedPath,
  pageTitle,
  planSubtreeMove,
  protectionReason,
  type MoveRequest,
  type MoveResult,
  type TrashListing,
} from "./model";

export async function movePage(client: VaultClient, id: string, request: MoveRequest): Promise<MoveResult> {
  if (client.movePage) return client.movePage(id, request);
  const [root, tree] = await Promise.all([client.getNote(id, { fresh: true }), client.listTree()]);
  if (!root.path) throw new PagesRequestError(400, "bad_request", "This page has no location to move.");
  const reason = protectionReason(root);
  if (reason) throw new PagesRequestError(403, "protected", reason);
  const target = request.newPath ?? movedPath(root.path, request.newParentPath ?? "");
  const from = root.path;
  if (from === target) throw new PagesRequestError(400, "no_change", "The page is already there.");
  if (isUnder(target, from)) throw new PagesRequestError(400, "into_own_subtree", "A page can’t move inside itself.");
  if (isProtectedPath(target)) throw new PagesRequestError(403, "protected", "That location is kept in sync by an integration.");
  const rows = tree.filter((t) => t.id !== root.id).map((t) => ({ id: t.id, path: t.path }));
  const plan = planSubtreeMove([{ id: root.id, path: root.path, updatedAt: root.updatedAt }, ...rows], from, target, root.id);
  const moving = new Set(plan.map((m) => m.id));
  const occupied = new Set(tree.filter((t) => t.path && !moving.has(t.id)).map((t) => t.path!.toLowerCase()));
  const clash = plan.find((m) => occupied.has(m.to.toLowerCase()));
  if (clash) throw new PagesRequestError(409, "path_conflict", `A page already exists at ${clash.to}.`);
  const moved: MoveResult["moved"] = [];
  for (const m of plan) {
    try {
      await client.updateNote(m.id, { path: m.to, ...(m.id === root.id && request.ifUpdatedAt ? { ifUpdatedAt: request.ifUpdatedAt } : {}) });
      moved.push({ id: m.id, from: m.from, to: m.to });
    } catch (e) {
      if (!moved.length) throw e;
      return { ok: false, path: target, moved, partial: { failed: { id: m.id, from: m.from, to: m.to, reason: "failed" }, resume: { moveId: "", newPath: target }, remaining: plan.length - moved.length } };
    }
  }
  return { ok: true, path: target, moved };
}

/** The trashed group of `rootId` in a lean listing (fallback path). */
const trashedGroup = (rows: NoteTreeEntry[], rootId: string) =>
  rows.filter((r) => r.id !== rootId && isTrashed(r) && r.metadata?.[TRASH_META.root] === rootId);

export async function trashPage(client: VaultClient, id: string, actorLabel = "you"): Promise<{ rootId: string; trashed: string[] }> {
  if (client.trashPage) return client.trashPage(id);
  const [root, tree] = await Promise.all([client.getNote(id, { fresh: true }), client.listTree()]);
  const reason = protectionReason(root);
  if (reason) throw new PagesRequestError(403, "protected", reason);
  if (isTrashed(root)) return { rootId: root.id, trashed: [] };
  const group = [root as Pick<Note, "id" | "path">, ...tree.filter((t) => t.id !== root.id && isUnder(t.path, root.path ?? "\u0000") && !isTrashed(t))];
  if (group.some((g) => protectionReason(g))) throw new PagesRequestError(403, "protected", "Some pages inside are kept in sync by an integration or the system.");
  const at = new Date().toISOString();
  const trashed: string[] = [];
  for (const g of group) {
    await client.updateNote(g.id, { metadata: { [TRASH_META.at]: at, [TRASH_META.by]: actorLabel, [TRASH_META.root]: root.id, [TRASH_META.path]: g.path } });
    await client.addTags(g.id, [TRASH_TAG]);
    trashed.push(g.id);
  }
  return { rootId: root.id, trashed };
}

export async function listTrash(client: VaultClient, query = ""): Promise<TrashListing> {
  if (client.listTrash) return client.listTrash(query);
  const rows = (await client.listNotes({ tag: TRASH_TAG })).filter(isTrashed);
  const ids = new Set(rows.map((r) => r.id));
  const q = query.trim().toLowerCase();
  const items = rows
    .filter((r) => {
      const root = r.metadata?.[TRASH_META.root];
      return !root || root === r.id || !ids.has(String(root));
    })
    .filter((r) => !q || (r.path ?? "").toLowerCase().includes(q))
    .map((r) => ({
      id: r.id,
      path: r.path,
      title: pageTitle(r.path),
      trashedAt: typeof r.metadata?.[TRASH_META.at] === "string" ? (r.metadata[TRASH_META.at] as string) : null,
      trashedBy: null,
      descendants: rows.filter((x) => x.id !== r.id && x.metadata?.[TRASH_META.root] === r.id).length,
      canRestore: true,
      canDelete: true,
    }))
    .sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
  return { items, total: items.length, retentionDays: 30, autoPurge: false };
}

export async function restoreFromTrash(client: VaultClient, id: string): Promise<{ restored: string[] }> {
  if (client.restoreFromTrash) return client.restoreFromTrash(id);
  const trashed = await client.listNotes({ tag: TRASH_TAG });
  const group = [id, ...trashedGroup(trashed, id).map((r) => r.id)];
  const clear = { [TRASH_META.at]: null, [TRASH_META.by]: null, [TRASH_META.root]: null, [TRASH_META.path]: null };
  for (const g of group) {
    await client.removeTags(g, [TRASH_TAG]);
    await client.updateNote(g, { metadata: clear });
  }
  return { restored: group };
}

export async function deleteFromTrash(client: VaultClient, id: string): Promise<{ deleted: string[] }> {
  if (client.deleteFromTrash) return client.deleteFromTrash(id);
  const root = await client.getNote(id, { fresh: true });
  if (!isTrashed(root)) throw new PagesRequestError(409, "not_in_trash", "Move the page to Trash first.");
  const trashed = await client.listNotes({ tag: TRASH_TAG });
  const group = [...trashedGroup(trashed, id).map((r) => r.id), id];
  for (const g of group) await client.deleteNote(g);
  return { deleted: group };
}

/** Lock / order: through the server's reconciling route when available, else a plain metadata write. */
export async function setPageMeta(client: VaultClient, id: string, set: { prism_locked?: boolean; prism_order?: number }): Promise<void> {
  const fresh = await client.getNote(id, { fresh: true });
  if (client.setPageMeta) {
    await client.setPageMeta(id, set, fresh.updatedAt ?? fresh.createdAt);
    return;
  }
  await client.updateNote(id, { metadata: set, ...(fresh.updatedAt ? { ifUpdatedAt: fresh.updatedAt } : {}) });
}

/** A human message for any page-operation failure. */
export function pageErrorText(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (e instanceof PagesRequestError) return e.message;
  if (e instanceof Error && /\b409\b/.test(e.message)) return "This page changed. Reload and try again.";
  if (e instanceof Error && /\b403\b/.test(e.message)) return "You don’t have permission to change this page.";
  return fallback;
}

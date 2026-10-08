/**
 * Record cards (integration-contract.md § 5): when the agent SUCCESSFULLY writes a
 * note, the thread gets a card {noteId, op, type, title, summary, links…} that opens
 * the note in Prism.
 *
 * Two sources, both best effort:
 *  1. The tool stream. A `tool.completed` (never `tool.failed`) for a Prism MCP write
 *     tool (`prism_create_note`, `prism_update_note`, …) or a raw vault MCP write
 *     (`create-note` …). Update/delete/comment/suggest name the note id in their
 *     input; a create names a PATH at most (Hermes' stream carries no tool result, so
 *     the created id is unknown) → resolved through the tree projection by path.
 *  2. The tree change feed (`subscribeTreeChanges`), for a create the stream could not
 *     resolve: a row that APPEARS while the turn runs (or within a grace period after)
 *     and matches the create's path, or — without a path — carries all of its tags and
 *     its `metadata.title`, and only when exactly one pending create matches.
 * LIMITS (documented in docs/omni-module.md): the tree has no writer column, so a note
 * the agent wrote through some other tool, or a create with neither path nor tags, gets
 * no card; a note written by someone else that happens to match a pending create's path
 * during the window would be attributed to the agent (paths are unique, so this needs the
 * same path); raw vault writes carry writer kind `external` (no Prism writer stamp).
 */
import { inferContentType } from "@prism/core/content-types";
import { resolveVaultEntry } from "../db";
import { ensureTree, subscribeTreeChanges, type TreeChange, type TreeRow } from "../tree";
import { vaultClient } from "../parachute";
import { omniConfig } from "./config";
import type { CardOp, WriteSignal } from "./stream";

export interface NoteMeta {
  id: string;
  path: string | null;
  tags: string[];
  title?: string | null;
  type?: string | null;
  prismType?: string | null;
  icon?: string | null;
  private?: boolean;
  updatedAt?: string | null;
}
export type NoteResolver = (ref: { id?: string; path?: string }) => Promise<NoteMeta | null>;
export type TreeSubscriber = (l: (c: TreeChange) => void) => Promise<() => void>;

const rowMeta = (r: TreeRow): NoteMeta => ({
  id: r.id, path: r.path, tags: r.tags, title: r.title ?? null, type: r.type ?? null, prismType: r.prismType ?? null,
  icon: r.icon ?? null, private: r.visibility === "private", updatedAt: r.updatedAt,
});

/** Default: the primary vault's tree projection, then one lean vault read by id. */
const defaultResolver: NoteResolver = async (ref) => {
  const entry = resolveVaultEntry(undefined);
  try {
    const t = await ensureTree(entry);
    const rows = t.rows();
    const key = ref.path?.replace(/\.md$/i, "").toLowerCase();
    const hit = rows.find((r) => (ref.id && r.id === ref.id) || (key && r.path?.replace(/\.md$/i, "").toLowerCase() === key));
    if (hit) return rowMeta(hit);
  } catch {
    /* fall through */
  }
  if (!ref.id) return null;
  try {
    const n = await vaultClient(entry.id, { timeoutMs: 5_000 }).getNote(ref.id, { includeContent: false, includeMetadata: ["title", "type", "prism_type", "icon", "prism_visibility"] });
    const m = n.metadata ?? {};
    return {
      id: n.id, path: n.path, tags: n.tags ?? [], title: typeof m.title === "string" ? m.title : null,
      type: typeof m.type === "string" ? m.type : null, prismType: typeof m.prism_type === "string" ? m.prism_type : null,
      icon: typeof m.icon === "string" ? m.icon : null, private: m.prism_visibility === "private", updatedAt: n.updatedAt,
    };
  } catch {
    return null;
  }
};
const defaultSubscriber: TreeSubscriber = (l) => subscribeTreeChanges(resolveVaultEntry(undefined), l);

let resolver: NoteResolver = defaultResolver;
let subscriber: TreeSubscriber | null = defaultSubscriber;
export function setOmniRecordSourcesForTests(o: { resolver?: NoteResolver | null; subscriber?: TreeSubscriber | null }): void {
  if (o.resolver !== undefined) resolver = o.resolver ?? defaultResolver;
  if (o.subscriber !== undefined) subscriber = o.subscriber;
}
export const resolveNote: NoteResolver = (ref) => resolver(ref);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const leaf = (p: string | null | undefined) => (p ? p.replace(/\.md$/i, "").split("/").pop() ?? p : null);

/** One line: what the write changed, from the tool input (never the body itself). */
export function changeSummary(w: WriteSignal): { summary: string; changedKeys: string[]; bodyChars?: number } {
  const i = w.input;
  const keys = i.metadata && typeof i.metadata === "object" && !Array.isArray(i.metadata) ? Object.keys(i.metadata as object).slice(0, 20) : [];
  const parts: string[] = [];
  if (w.op === "created") parts.push("Created");
  else if (w.op === "deleted") parts.push("Deleted");
  else if (w.op === "commented") parts.push(w.tool === "prism_resolve_comment" ? "Resolved a comment" : "Commented");
  else if (w.op === "suggested") parts.push("Suggested an edit");
  const body = typeof i.content === "string" ? i.content.length : undefined;
  if (w.op === "updated") {
    if (w.tool === "prism_restore_version") parts.push("Restored an earlier version");
    else if (w.tool === "prism_sheet_update") parts.push("Updated cells");
    else if (body !== undefined) parts.push(`Body edited (${body} chars)`);
  }
  if (keys.length && w.op !== "deleted") parts.push(`${keys.length === 1 ? "property" : "properties"} ${keys.join(", ")}`);
  const add = Array.isArray(i.add_tags) ? i.add_tags : Array.isArray((i.tags as { add?: unknown })?.add) ? ((i.tags as { add: unknown[] }).add) : [];
  if (add.length) parts.push(`+${add.slice(0, 5).join(" +")}`);
  if (typeof i.path === "string" && w.op === "updated") parts.push("moved");
  return { summary: parts.join(" · ").slice(0, 200) || "Changed", changedKeys: keys, ...(body !== undefined ? { bodyChars: body } : {}) };
}

/** The card for a resolved note. */
export function buildCard(w: WriteSignal, meta: NoteMeta, threadId: string): Record<string, unknown> & { noteId: string; op: CardOp } {
  const { summary, changedKeys, bodyChars } = changeSummary(w);
  const type = inferContentType({ path: meta.path ?? undefined, tags: meta.tags, metadata: { ...(meta.type ? { type: meta.type } : {}), ...(meta.prismType ? { prism_type: meta.prismType } : {}) }, content: "" } as Parameters<typeof inferContentType>[0]);
  const origin = omniConfig.appOrigin();
  const id = meta.id;
  return {
    kind: "record",
    noteId: id,
    op: w.op,
    type,
    title: meta.title || leaf(meta.path) || id,
    path: meta.path,
    tags: meta.tags,
    icon: meta.icon ?? null,
    summary,
    changedKeys,
    ...(bodyChars !== undefined ? { bodyDelta: { chars: bodyChars } } : {}),
    // Prism MCP writes carry Prism's agent writer stamp; raw vault writes carry none.
    writer: w.via === "prism" ? { kind: "agent", label: "Omni" } : { kind: "external", label: "Omni (vault)" },
    updatedAt: meta.updatedAt ?? null,
    threadId,
    links: { prism: `${origin}/page/${encodeURIComponent(id)}`, prismApp: `prism://page/${encodeURIComponent(id)}`, omni: `omni://record/${encodeURIComponent(id)}` },
    private: !!meta.private,
  };
}

export interface PendingCreate {
  write: WriteSignal;
  path?: string;
  tags: string[];
  title?: string;
}

/** Resolve one write to a card (null = the note could not be identified yet). */
export async function cardForWrite(w: WriteSignal, threadId: string): Promise<{ card?: ReturnType<typeof buildCard>; pending?: PendingCreate }> {
  const i = w.input;
  if (w.op === "created") {
    const path = str(i.path);
    const meta = path ? await resolveNote({ path }).catch(() => null) : null;
    if (meta) return { card: buildCard(w, meta, threadId) };
    const md = i.metadata && typeof i.metadata === "object" ? (i.metadata as Record<string, unknown>) : {};
    const tags = Array.isArray(i.tags) ? (i.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    return { pending: { write: w, path, tags, title: str(md.title) } };
  }
  const id = str(i.id) ?? str(i.note_id) ?? str(i.noteId);
  if (!id) return {};
  if (w.op === "deleted") {
    const meta = (await resolveNote({ id }).catch(() => null)) ?? { id, path: null, tags: [] };
    return { card: buildCard(w, meta, threadId) };
  }
  const meta = await resolveNote({ id }).catch(() => null);
  return { card: buildCard(w, meta ?? { id, path: null, tags: [] }, threadId) };
}

/**
 * Watch the tree for rows that resolve pending creates. Returns a stop function; the
 * watch also stops itself `graceMs` after `close()` is called (the turn ended).
 */
export async function watchPendingCreates(
  pending: PendingCreate[],
  onCard: (w: WriteSignal, meta: NoteMeta) => void,
): Promise<{ add: (p: PendingCreate) => void; close: (graceMs?: number) => void }> {
  const list = [...pending];
  let unsub: (() => void) | null = null;
  const matches = (p: PendingCreate, r: TreeRow): boolean => {
    if (p.path) return (r.path ?? "").replace(/\.md$/i, "").toLowerCase() === p.path.replace(/\.md$/i, "").toLowerCase();
    if (!p.tags.length) return false;
    if (!p.tags.every((t) => r.tags.includes(t))) return false;
    return p.title ? r.title === p.title || leaf(r.path) === p.title : false;
  };
  const listener = (c: TreeChange) => {
    if (c.kind !== "upsert" || c.prev) return; // only rows that APPEAR
    const hits = list.filter((p) => matches(p, c.row));
    if (hits.length !== 1) return; // ambiguous → no card rather than a wrong one
    list.splice(list.indexOf(hits[0]!), 1);
    onCard(hits[0]!.write, rowMeta(c.row));
  };
  if (subscriber) {
    try {
      unsub = await subscriber(listener);
    } catch {
      unsub = null;
    }
  }
  let timer: NodeJS.Timeout | undefined;
  return {
    add: (p) => void list.push(p),
    close: (graceMs = 30_000) => {
      clearTimeout(timer);
      const stop = () => {
        unsub?.();
        unsub = null;
      };
      if (graceMs <= 0 || list.length === 0) stop();
      else (timer = setTimeout(stop, graceMs)).unref?.();
    },
  };
}

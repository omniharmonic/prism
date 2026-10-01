/**
 * Vault-only halves of legacy desktop host commands (Arch v2 WP4.3), as pure
 * VaultClient operations so a thin client (PWA / Prism Client) gets them through
 * the gateway — every write is the signed-in user's, under `effectiveCaps`.
 *
 *   syncStatusFromNote / addSyncConfig / removeSyncConfig   ← sync_status / sync_add_config / sync_remove_config
 *   extractWikilinks / resolveWikilinks                     ← resolve_wikilinks (single note)
 *   queueSkillRun                                            ← "run this skill now" (server scheduler)
 */
import type { Note, NoteTreeEntry, UpdateNoteParams } from "../types";

/** The subset of VaultClient these ops need (easy to fake in tests). */
export interface VaultOpsClient {
  getNote(id: string): Promise<Note>;
  updateNote(id: string, params: UpdateNoteParams): Promise<Note>;
  listTree?(): Promise<NoteTreeEntry[]>;
  createLink?(sourceId: string, targetId: string, relationship: string, metadata?: unknown): Promise<unknown>;
}

export interface NoteSyncConfig {
  adapter: string;
  remote_id: string;
  last_synced: string;
  direction: string;
  conflict_strategy: string;
  auto_sync: boolean;
}

export interface NoteSyncStatus {
  adapter: string;
  remote_id: string;
  state: "synced" | "never_synced";
  last_synced: string | null;
  error: string | null;
}

/** Adapters the server can push/pull per note (`/api/sync/note/:id/*`). GitHub is
 *  directory-level on the server and is NOT a per-note adapter here. */
export const SERVER_NOTE_SYNC_ADAPTERS = ["google-docs", "notion"] as const;

function configsOf(metadata: Record<string, unknown> | null | undefined): NoteSyncConfig[] {
  const raw = metadata?.sync;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as Record<string, unknown>).adapter === "string")
    .map((s) => ({
      adapter: String(s.adapter),
      remote_id: typeof s.remote_id === "string" ? s.remote_id : "",
      last_synced: typeof s.last_synced === "string" ? s.last_synced : "",
      direction: typeof s.direction === "string" ? s.direction : "bidirectional",
      conflict_strategy: typeof s.conflict_strategy === "string" ? s.conflict_strategy : "ask",
      auto_sync: s.auto_sync === true,
    }));
}

/** Port of the desktop `sync_status`: state comes from `last_synced` only. */
export function syncStatusFromNote(note: Pick<Note, "metadata">): NoteSyncStatus[] {
  return configsOf(note.metadata).map((c) => ({
    adapter: c.adapter,
    remote_id: c.remote_id,
    state: c.last_synced ? "synced" : "never_synced",
    last_synced: c.last_synced || null,
    error: null,
  }));
}

/** Port of `sync_add_config`: append an adapter entry unless one exists. Returns false when it already did. */
export async function addSyncConfig(
  vc: VaultOpsClient,
  noteId: string,
  adapter: string,
  extra: Partial<Pick<NoteSyncConfig, "remote_id" | "direction">> = {},
): Promise<boolean> {
  const note = await vc.getNote(noteId);
  const configs = configsOf(note.metadata);
  const existing = configs.find((c) => c.adapter === adapter);
  if (existing && !extra.remote_id) return false;
  const entry: NoteSyncConfig = {
    adapter,
    remote_id: extra.remote_id ?? "",
    last_synced: "",
    direction: extra.direction ?? "bidirectional",
    conflict_strategy: "ask",
    auto_sync: false,
  };
  // A remote id (e.g. a picked Notion page) replaces that adapter's entry.
  const next = [...configs.filter((c) => c.adapter !== adapter), entry];
  await vc.updateNote(noteId, { metadata: { ...(note.metadata ?? {}), sync: next }, ifUpdatedAt: note.updatedAt ?? undefined });
  return true;
}

/** Port of `sync_remove_config`. */
export async function removeSyncConfig(vc: VaultOpsClient, noteId: string, adapter: string, remoteId: string): Promise<void> {
  const note = await vc.getNote(noteId);
  const next = configsOf(note.metadata).filter((c) => !(c.adapter === adapter && c.remote_id === remoteId));
  await vc.updateNote(noteId, { metadata: { ...(note.metadata ?? {}), sync: next }, ifUpdatedAt: note.updatedAt ?? undefined });
}

// ── wikilinks ────────────────────────────────────────────────────────────────

/** Port of the desktop `extract_wikilinks`: `[[target]]` / `[[target|label]]`, trimmed, de-duplicated, in order. */
export function extractWikilinks(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]*?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[1]!.split("|")[0]!.trim();
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/** Port of the desktop matcher: exact path, filename (case-insensitive), or either with `vault/` stripped. */
export function matchWikilink(wikilink: string, entries: Array<Pick<NoteTreeEntry, "id" | "path">>): Pick<NoteTreeEntry, "id" | "path"> | null {
  const lower = wikilink.toLowerCase();
  for (const n of entries) {
    const path = n.path ?? "";
    const name = path.split("/").pop() ?? "";
    if (path === wikilink || name.toLowerCase() === lower) return n;
    const stripped = path.startsWith("vault/") ? path.slice(6) : path;
    if (stripped === wikilink || (stripped.split("/").pop() ?? "").toLowerCase() === lower) return n;
  }
  return null;
}

export interface WikilinkResolution {
  resolved: number;
  total: number;
  links: Array<{ wikilink: string; targetId?: string; targetPath?: string | null; status: string }>;
}

/** Port of `resolve_wikilinks` (one note): create a `references` link for each wikilink that matches a note. */
export async function resolveWikilinks(vc: VaultOpsClient, noteId: string): Promise<WikilinkResolution> {
  if (!vc.listTree || !vc.createLink) throw new Error("this vault client cannot list or link notes");
  const note = await vc.getNote(noteId);
  const wikilinks = extractWikilinks(note.content ?? "");
  if (wikilinks.length === 0) return { resolved: 0, total: 0, links: [] };
  const tree = (await vc.listTree()).filter((n) => n.id !== noteId);
  const links: WikilinkResolution["links"] = [];
  let created = 0;
  for (const w of wikilinks) {
    const target = matchWikilink(w, tree);
    if (!target) {
      links.push({ wikilink: w, status: "unresolved" });
      continue;
    }
    try {
      await vc.createLink(noteId, target.id, "references", { source: "wikilink", original: w });
      created++;
      links.push({ wikilink: w, targetId: target.id, targetPath: target.path, status: "created" });
    } catch (e) {
      links.push({ wikilink: w, targetId: target.id, targetPath: target.path, status: `error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { resolved: created, total: wikilinks.length, links };
}

// ── skills ───────────────────────────────────────────────────────────────────

/**
 * "Run this skill now" for a thin client: clear the skill note's `lastRun`. The
 * server skill scheduler (WP1.1, `SKILLS_ENABLED`) treats an empty/unparseable
 * lastRun as DUE, so the skill runs on its next 60 s tick with its own routing
 * (structured / local model / claude) — no client-side spawn, no new route. A
 * daily skill (`runAtHour`) still waits for its local hour.
 */
export async function queueSkillRun(vc: VaultOpsClient, skillNoteId: string): Promise<void> {
  const note = await vc.getNote(skillNoteId);
  if (!(note.tags ?? []).includes("agent-skill")) throw new Error("not an agent-skill note");
  await vc.updateNote(skillNoteId, { metadata: { ...(note.metadata ?? {}), lastRun: "" }, ifUpdatedAt: note.updatedAt ?? undefined });
}

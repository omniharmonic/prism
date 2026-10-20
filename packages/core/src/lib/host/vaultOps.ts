/**
 * Vault-only halves of legacy desktop host commands (Arch v2 WP4.3), as pure
 * VaultClient operations so a thin client (PWA / Prism Client) gets them through
 * the gateway — every write is the signed-in user's, under `effectiveCaps`.
 *
 *   syncStatusFromNote / addSyncConfig / removeSyncConfig   ← sync_status / sync_add_config / sync_remove_config
 *   extractWikilinks / resolveWikilinks                     ← resolve_wikilinks (single note)
 *   queueSkillRun                                            ← "run this skill now" (server scheduler)
 *   updateSkillNote / validateSkillPatch                     ← agent_update_skill (skill config card)
 */
import type { Note, NoteTreeEntry, UpdateNoteParams } from "../types";
import { parseWikilinks, buildWikilinkIndex, resolveWikilink } from "../wikilinks";

/** The subset of VaultClient these ops need (easy to fake in tests). */
export interface VaultOpsClient {
  scope?(): string;
  getNote(id: string): Promise<Note>;
  updateNote(id: string, params: UpdateNoteParams): Promise<Note>;
  listTree?(): Promise<NoteTreeEntry[]>;
  listNotes?(): Promise<Note[]>;
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

export const extractWikilinks = (content: string): string[] => parseWikilinks(content).links;
/** Compatibility helper; ambiguous names never silently choose the first row. */
export function matchWikilink(wikilink: string, entries: Array<Pick<NoteTreeEntry, "id" | "path"> & Partial<Pick<NoteTreeEntry,"metadata">>>): Pick<NoteTreeEntry,"id"|"path"> | null {
  const result = resolveWikilink(wikilink,buildWikilinkIndex(entries));
  return result.kind === "match" ? result.note : null;
}

export interface WikilinkResolution {
  resolved: number;
  total: number;
  links: Array<{ wikilink: string; targetId?: string; targetPath?: string | null; status: string }>;
}

/** Port of `resolve_wikilinks` (one note): create a `references` link for each wikilink that matches a note. */
export async function resolveWikilinks(vc: VaultOpsClient, noteId: string): Promise<WikilinkResolution> {
  if (!vc.listTree || !vc.createLink) throw new Error("this vault client cannot list or link notes");
  const scope = vc.scope?.();
  const checkScope = () => { if (scope !== vc.scope?.()) throw new Error("Workspace changed. Reopen the original document before resolving its links."); };
  const note = await vc.getNote(noteId);
  checkScope();
  const wikilinks = extractWikilinks(note.content ?? "");
  if (wikilinks.length === 0) return { resolved: 0, total: 0, links: [] };
  const inventory = vc.listNotes ? await vc.listNotes() : await vc.listTree();
  checkScope();
  if (inventory.length >= 50_000) throw new Error("Document inventory may be incomplete; no links were changed");
  const tree = inventory.filter((n) => n.id !== noteId);
  const index = buildWikilinkIndex(tree);
  const links: WikilinkResolution["links"] = [];
  let created = 0;
  for (const w of wikilinks) {
    const result = resolveWikilink(w,index);
    if (result.kind !== "match") {
      links.push({ wikilink: w, status: result.kind === "ambiguous" ? "ambiguous" : "unresolved" });
      continue;
    }
    const target = result.note;
    try {
      checkScope();
      await vc.createLink(noteId, target.id, "references", { source: "wikilink", original: w });
      checkScope();
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

// ── skill-note config (port of the desktop `agent_update_skill`, parity A) ────
//
// The agent-skill note's metadata IS the server scheduler's source of truth
// (apps/server/src/worker/skills.ts reads skillName, enabled, intervalSecs,
// runAtHour, dependsOn, lastRun, executionMode, provider/model, structured; the
// prompt is the content). The skill config card on a thin client writes it here,
// through the VaultClient (the signed-in user's grants), never via a server
// route. `runner` (the server's lease) and `lastRun` are never touched.

export type SkillProvider = "" | "claude" | "local";
export const SKILL_PROVIDERS: readonly SkillProvider[] = ["", "claude", "local"];
export const SKILL_EXECUTION_MODES = ["agentic", "structured"] as const;

export interface SkillPatch {
  enabled?: boolean;
  intervalSecs?: number;
  /** null clears it (an hourly-style skill). */
  runAtHour?: number | null;
  /** A skill name, or null to clear. */
  dependsOn?: string | null;
  /** "" = the server default (SKILLS_DEFAULT_PROVIDER) — the desktop's sentinel. */
  provider?: SkillProvider;
  /** "" = the default model for the provider. */
  model?: string;
  executionMode?: (typeof SKILL_EXECUTION_MODES)[number];
  /** The structured-mode config block (validated like the server's parser). */
  structured?: Record<string, unknown> | null;
  description?: string;
  /** The prompt / rubric (note content). */
  prompt?: string;
}

/** Smallest interval the scheduler is asked to honour (its tick is 60 s). */
export const MIN_SKILL_INTERVAL_SECS = 60;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * Mirror of the server's `parseStructuredConfig` (worker/skills.ts): returns
 * the error the scheduler would fail the run with, or null when it would parse.
 * Stricter only where the server would silently drop data (non-string tags).
 */
export function validateStructuredBlock(s: unknown): string | null {
  if (s === null || s === undefined) return "missing 'structured' config block";
  if (typeof s !== "object" || Array.isArray(s)) return "'structured' must be an object";
  const o = s as Record<string, unknown>;
  const strList = (k: string, required: boolean): string | null => {
    const v = o[k];
    if (v === undefined) return required ? `'structured.${k}' is missing or empty` : null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return `'structured.${k}' must be a list of strings`;
    if (required && v.length === 0) return `'structured.${k}' is missing or empty`;
    return null;
  };
  const e = strList("sourceTags", true) ?? strList("excludeTags", false) ?? strList("allowedValues", false) ?? strList("alsoAddTags", false);
  if (e) return e;
  if (!("schema" in o)) return "'structured.schema' is missing";
  if (o.schema === null || typeof o.schema !== "object") return "'structured.schema' must be a JSON schema object";
  if (typeof o.resultField !== "string" || !o.resultField) return "'structured.resultField' is missing";
  if (o.limit !== undefined && !(typeof o.limit === "number" && Number.isInteger(o.limit) && o.limit > 0 && o.limit <= 1000)) {
    return "'structured.limit' must be a whole number from 1 to 1000";
  }
  if (o.shortcutLabels !== undefined) {
    const sl = o.shortcutLabels;
    if (!sl || typeof sl !== "object" || Array.isArray(sl) || Object.values(sl).some((v) => typeof v !== "string")) {
      return "'structured.shortcutLabels' must map labels to strings";
    }
  }
  return null;
}

/**
 * Validate a skill patch the way the desktop card constrained it (fixed interval
 * choices became "a whole number of seconds ≥ 60"; runAtHour 0–23; provider
 * claude|local|"" default) plus the fields the card now also edits: dependsOn
 * must name ANOTHER existing skill, structured mode needs a parseable block,
 * the prompt may not be blank. Returns the first error, or null.
 */
export function validateSkillPatch(
  patch: SkillPatch,
  ctx: {
    skillName: string;
    skillNames: string[];
    /** Every skill's current dependsOn (by skillName) — for cycle detection (L6). */
    dependsOnByName?: Record<string, string | null | undefined>;
    currentMode?: string;
    currentStructured?: unknown;
  },
): string | null {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return "enabled must be true or false";
  if (patch.intervalSecs !== undefined) {
    const v = patch.intervalSecs;
    if (!Number.isInteger(v) || v < MIN_SKILL_INTERVAL_SECS || v > 30 * 86400) return `interval must be a whole number of seconds from ${MIN_SKILL_INTERVAL_SECS} to 30 days`;
  }
  if (patch.runAtHour !== undefined && patch.runAtHour !== null) {
    if (!Number.isInteger(patch.runAtHour) || patch.runAtHour < 0 || patch.runAtHour > 23) return "run hour must be 0–23";
  }
  if (patch.dependsOn !== undefined && patch.dependsOn !== null) {
    if (patch.dependsOn === ctx.skillName) return "a skill cannot depend on itself";
    if (!ctx.skillNames.includes(patch.dependsOn)) return `no skill named '${patch.dependsOn}'`;
    // L6: following the chain from the new dependency must never come back here
    // (a cycle means neither skill ever runs: each waits for the other "today").
    const deps = ctx.dependsOnByName ?? {};
    const seen = new Set<string>();
    for (let cur: string | null | undefined = patch.dependsOn; cur; cur = deps[cur]) {
      if (cur === ctx.skillName) return `that would create a dependency cycle (${[...seen, cur].join(" → ")} → ${patch.dependsOn})`;
      if (seen.has(cur)) break; // an existing cycle elsewhere; not ours to report
      seen.add(cur);
    }
  }
  if (patch.provider !== undefined && !SKILL_PROVIDERS.includes(patch.provider)) return "provider must be claude, local or the default";
  if (patch.model !== undefined && patch.model !== "" && !MODEL_RE.test(patch.model)) return "model id has invalid characters";
  if (patch.executionMode !== undefined && !(SKILL_EXECUTION_MODES as readonly string[]).includes(patch.executionMode)) return "mode must be agentic or structured";
  if (patch.structured !== undefined && patch.structured !== null) {
    const e = validateStructuredBlock(patch.structured);
    if (e) return e;
  }
  const mode = patch.executionMode ?? ctx.currentMode;
  const block = patch.structured !== undefined ? patch.structured : ctx.currentStructured;
  if (mode === "structured" && (patch.executionMode !== undefined || patch.structured !== undefined)) {
    const e = validateStructuredBlock(block);
    if (e) return `structured mode needs a valid config block: ${e}`;
  }
  if (patch.description !== undefined && (typeof patch.description !== "string" || patch.description.length > 500)) return "description is too long";
  if (patch.prompt !== undefined && (typeof patch.prompt !== "string" || !patch.prompt.trim())) return "the prompt may not be empty";
  return null;
}

/** The patch merged onto the CURRENT note's metadata, so `runner`, `lastRun`
 *  and every key this card doesn't know survive. */
export function mergeSkillMetadata(current: Record<string, unknown> | null | undefined, patch: SkillPatch): Record<string, unknown> {
  const md: Record<string, unknown> = { ...(current ?? {}) };
  for (const k of ["enabled", "intervalSecs", "runAtHour", "dependsOn", "provider", "model", "executionMode", "structured", "description"] as const) {
    if (patch[k] !== undefined) md[k] = patch[k];
  }
  return md;
}

const isConflict = (e: unknown): boolean => /\b409\b|conflict/i.test(String((e as Error)?.message ?? e));

/**
 * Write a skill config change (`agent_update_skill`). Reads the note, checks it
 * is an `agent-skill`, validates against the vault's other skills, and writes
 * metadata (+ content for a prompt change) with `if_updated_at` — the desktop
 * forced it. A conflict on a METADATA-only change (the scheduler stamps
 * `lastRun`/`runner` on its own) is refetched and merged once; a prompt change
 * that conflicts is surfaced instead of clobbering someone else's edit.
 */
export async function updateSkillNote(
  vc: VaultOpsClient & { listNotes?: (q: { tag?: string; limit?: number }) => Promise<Note[]> },
  skillNoteId: string,
  patch: SkillPatch,
): Promise<Note> {
  const write = async (note: Note): Promise<Note> => {
    if (!(note.tags ?? []).includes("agent-skill")) throw new Error("not an agent-skill note");
    const md = (note.metadata ?? {}) as Record<string, unknown>;
    let skillNames: string[] = [];
    const dependsOnByName: Record<string, string | null> = {};
    if (patch.dependsOn) {
      const all = vc.listNotes ? await vc.listNotes({ tag: "agent-skill", limit: 200 }) : [];
      for (const n of all) {
        const m = (n.metadata ?? {}) as Record<string, unknown>;
        const name = typeof m.skillName === "string" ? m.skillName : "";
        if (!name) continue;
        skillNames.push(name);
        dependsOnByName[name] = typeof m.dependsOn === "string" && m.dependsOn ? m.dependsOn : null;
      }
    }
    const err = validateSkillPatch(patch, {
      skillName: String(md.skillName ?? ""),
      skillNames,
      dependsOnByName,
      currentMode: typeof md.executionMode === "string" ? md.executionMode : "agentic",
      currentStructured: md.structured,
    });
    if (err) throw new Error(err);
    return vc.updateNote(skillNoteId, {
      metadata: mergeSkillMetadata(md, patch),
      ...(patch.prompt !== undefined ? { content: patch.prompt } : {}),
      ifUpdatedAt: note.updatedAt ?? undefined,
    });
  };
  try {
    return await write(await vc.getNote(skillNoteId));
  } catch (e) {
    if (!isConflict(e) || patch.prompt !== undefined) throw e;
    return write(await vc.getNote(skillNoteId));
  }
}

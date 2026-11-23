// The owner's Comms notification settings (Sprint Task 1, D18 + D10). One JSON row in `settings`
// (key comms_notify_v1). Owner-only (one owner per server); every reader gets a complete, sanitized
// object — a stored row from an older build reads with the defaults filled in.
//
// Defaults (D18): only Needs attention notifies (urgent + action-required). Every other triage
// status is the owner's switch (default off; owner, 2026-11-22: "change notifications based on tag
// type or folder"). Strangers (folder unknown), low-priority and spam FOLDERS never notify unless
// one of the owner's folders says "all"; spam never does.
// Per owner folder (`folders`): "all" | "none"; a folder that is not listed follows the status and
// network rules ("default"). Precedence in notify.ts: Mute > folder none > folder all > the rest.
// Read receipts and typing (D10): one toggle, default OFF, with optional per-network overrides.
import { db } from "../db";
import type { Network } from "./types";

/** Every triage status (the Prism tags): the owner switches each on or off. `unclassified` covers
 *  "not yet sorted" (no tag yet, or the classifier failed). */
export const NOTIFIABLE_STATUSES = ["urgent", "action-required", "informational", "low", "social", "triaged", "handled", "unclassified"] as const;
export type NotifiableStatus = typeof NOTIFIABLE_STATUSES[number];

/** A folder's notification rule. "default" is never stored: it is the absence of a rule. */
export const FOLDER_NOTIFY_RULES = ["default", "all", "none"] as const;
export type FolderNotifyRule = typeof FOLDER_NOTIFY_RULES[number];
export type StoredFolderRule = Exclude<FolderNotifyRule, "default">;
const MAX_FOLDER_ID = 64;
const isFolderId = (k: string): boolean => k.length > 0 && k.length <= MAX_FOLDER_ID && /^[A-Za-z0-9_-]+$/.test(k);

export const NOTIFY_NETWORKS: readonly Network[] = [
  "whatsapp", "telegram", "discord", "messenger", "x", "imessage", "sms", "email", "matrix", "signal", "slack", "instagram", "linkedin",
];

export interface CommsNotifySettings {
  /** Master switch (the app's "Allow Notifications"). */
  enabled: boolean;
  statuses: Record<NotifiableStatus, boolean>;
  /** false = never notify for that network. Missing = on. */
  networks: Partial<Record<Network, boolean>>;
  /** A DM from someone with a person note notifies at once, before the classifier's verdict. */
  knownPeopleImmediately: boolean;
  /** Lock-screen privacy: no sender, no text — "New message" only. */
  hidePreviews: boolean;
  /** D10: send read receipts (and typing) — default off. */
  readReceipts: boolean;
  /** D10 per-network overrides of readReceipts. */
  readReceiptsByNetwork: Partial<Record<Network, boolean>>;
  /** Owner folder id → "all" | "none" (missing = "default": status + network rules). */
  folders: Record<string, StoredFolderRule>;
}

export const DEFAULT_NOTIFY_SETTINGS: CommsNotifySettings = Object.freeze({
  enabled: true,
  statuses: Object.freeze({
    urgent: true, "action-required": true, informational: false, low: false, social: false, triaged: false, handled: false, unclassified: false,
  }),
  networks: Object.freeze({}),
  knownPeopleImmediately: true,
  hidePreviews: false,
  readReceipts: false,
  readReceiptsByNetwork: Object.freeze({}),
  folders: Object.freeze({}),
}) as CommsNotifySettings;

const KEY = "comms_notify_v1";
const isNetwork = (n: string): n is Network => (NOTIFY_NETWORKS as readonly string[]).includes(n);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function netMap(v: unknown): Partial<Record<Network, boolean>> {
  const out: Partial<Record<Network, boolean>> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (isNetwork(k) && typeof b === "boolean") out[k] = b;
  return out;
}

function folderMap(v: unknown): Record<string, StoredFolderRule> {
  const out: Record<string, StoredFolderRule> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) if (isFolderId(k) && (r === "all" || r === "none")) out[k] = r;
  return out;
}

/** Any stored / incoming value → a complete settings object (unknown keys dropped). */
export function sanitizeNotifySettings(raw: unknown, base: CommsNotifySettings = DEFAULT_NOTIFY_SETTINGS): CommsNotifySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const st = r.statuses && typeof r.statuses === "object" && !Array.isArray(r.statuses) ? (r.statuses as Record<string, unknown>) : {};
  const statuses = { ...base.statuses };
  for (const s of NOTIFIABLE_STATUSES) statuses[s] = bool(st[s], base.statuses[s]);
  return {
    enabled: bool(r.enabled, base.enabled),
    statuses,
    networks: r.networks === undefined ? { ...base.networks } : netMap(r.networks),
    knownPeopleImmediately: bool(r.knownPeopleImmediately, base.knownPeopleImmediately),
    hidePreviews: bool(r.hidePreviews, base.hidePreviews),
    readReceipts: bool(r.readReceipts, base.readReceipts),
    readReceiptsByNetwork: r.readReceiptsByNetwork === undefined ? { ...base.readReceiptsByNetwork } : netMap(r.readReceiptsByNetwork),
    folders: r.folders === undefined ? { ...base.folders } : folderMap(r.folders),
  };
}

/** Strict validation of a PUT body: unknown keys or wrong types → the offending key (400). */
export function invalidNotifySettingsKey(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "body";
  const allowed = new Set(["enabled", "statuses", "networks", "knownPeopleImmediately", "hidePreviews", "readReceipts", "readReceiptsByNetwork", "folders"]);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) return k;
    if (k === "statuses") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return k;
      for (const [s, b] of Object.entries(v as Record<string, unknown>))
        if (!(NOTIFIABLE_STATUSES as readonly string[]).includes(s) || typeof b !== "boolean") return `statuses.${s}`;
    } else if (k === "networks" || k === "readReceiptsByNetwork") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return k;
      for (const [n, b] of Object.entries(v as Record<string, unknown>)) if (!isNetwork(n) || typeof b !== "boolean") return `${k}.${n}`;
    } else if (k === "folders") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return k;
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > 50) return k;
      for (const [f, r] of entries)
        if (!isFolderId(f) || !(FOLDER_NOTIFY_RULES as readonly unknown[]).includes(r)) return `folders.${f}`;
    } else if (typeof v !== "boolean") return k;
  }
  return null;
}

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const putStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

const folderIdsStmt = db.prepare("SELECT id FROM comms_folders");

/** Rules only for folders that still exist (a deleted folder's rule goes with it). */
function liveFolders(rules: Record<string, StoredFolderRule>): Record<string, StoredFolderRule> {
  if (!Object.keys(rules).length) return rules;
  const live = new Set((folderIdsStmt.all() as { id: string }[]).map((r) => r.id));
  return Object.fromEntries(Object.entries(rules).filter(([id]) => live.has(id)));
}

/** Folder ids of a PUT body that name no folder (422: a rule needs a folder). "default" is always fine. */
export function unknownFolderIds(patch: Record<string, unknown>): string[] {
  const f = patch.folders as Record<string, unknown> | undefined;
  if (!f) return [];
  const live = new Set((folderIdsStmt.all() as { id: string }[]).map((r) => r.id));
  return Object.entries(f).filter(([id, r]) => r !== "default" && !live.has(id)).map(([id]) => id);
}

export function getNotifySettings(): CommsNotifySettings {
  const row = getStmt.get(KEY) as { value: string } | undefined;
  let s: CommsNotifySettings;
  try {
    s = sanitizeNotifySettings(row ? JSON.parse(row.value) : {});
  } catch {
    s = sanitizeNotifySettings({});
  }
  s.folders = liveFolders(s.folders);
  return s;
}

/** Merge a validated partial onto the stored settings; returns the result. */
export function updateNotifySettings(patch: Record<string, unknown>): CommsNotifySettings {
  const cur = getNotifySettings();
  const merged = sanitizeNotifySettings(
    {
      ...patch,
      statuses: { ...cur.statuses, ...((patch.statuses as object | undefined) ?? {}) },
      ...(patch.networks !== undefined ? { networks: { ...cur.networks, ...(patch.networks as object) } } : {}),
      ...(patch.readReceiptsByNetwork !== undefined ? { readReceiptsByNetwork: { ...cur.readReceiptsByNetwork, ...(patch.readReceiptsByNetwork as object) } } : {}),
      // Key by key; "default" removes the folder's rule (folderMap drops it).
      ...(patch.folders !== undefined ? { folders: { ...cur.folders, ...(patch.folders as object) } } : {}),
    },
    cur,
  );
  merged.folders = liveFolders(merged.folders);
  putStmt.run(KEY, JSON.stringify(merged));
  return merged;
}

/** A thread's folder rule: any of its folders "none" → "none" (silence wins), else any "all" → "all". */
export function folderRuleOf(s: CommsNotifySettings, folderIds: readonly string[] | undefined): StoredFolderRule | null {
  let all = false;
  for (const id of folderIds ?? []) {
    const r = s.folders[id];
    if (r === "none") return "none";
    if (r === "all") all = true;
  }
  return all ? "all" : null;
}

/** D10: does the owner want read receipts (and typing) on this network? */
export function receiptsWanted(s: CommsNotifySettings, network: Network): boolean {
  return s.readReceiptsByNetwork[network] ?? s.readReceipts;
}

export function _resetNotifySettingsForTests(): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
}

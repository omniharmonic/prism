/**
 * Shape guard at the vault SINK: every create/update `vaultClient` sends passes
 * `shapeMetadata()`, so the field shapes the (corrected) tag schemas declare are
 * produced at the source instead of being cleaned up afterwards.
 *
 * Why: `qa/vault-health.md` (2026-10-08) found `""` in list fields on ~90% of
 * person/organization notes, label `confidence` on fields typed as numbers,
 * thread timestamps as strings — all writer artifacts. The one-off migrations in
 * `scripts/vault-hygiene/` heal the past; this keeps the drift from coming back.
 * The rules mirror `scripts/vault-hygiene/schema-fixes.json` and the agent
 * repo's `scripts/vault_shapes.py` (keep the three in step;
 * `test/vault-shapes.test.ts` pins the enums against schema-fixes.json).
 *
 * Rules by field NAME (always): a list field holding `""` is dropped on a create
 * and becomes `null` (= remove the key, RFC 7386 merge) on an update — empty is
 * ABSENT; empty / duplicate list elements are removed; `recording_id` is text.
 * Rules by TAG (when the tags are known: creates, updates that add tags): a
 * non-empty string in a declared list field becomes a one-element list;
 * `confidence` on person/project/organization/concept becomes high|medium|low;
 * task `status` synonyms → the canonical vocabulary; message-thread
 * `lastMessageAt` → epoch-ms integer, `platform` lower case; meeting/transcript
 * `source` lower case (`""` dropped); spec `version` → text.
 *
 * Governance notes are never touched (their metadata is HMAC-signed, see
 * governance-integrity.ts). Pure, linear, never throws, never mutates its input.
 * `VAULT_SHAPE_GUARD=0` turns it off.
 */

export const LIST_FIELDS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  person: ["organizations", "projects", "aliases"],
  organization: ["people", "projects", "aliases"],
  project: ["collaborators", "aliases", "keywords"],
  concept: ["aliases", "related", "sectors", "scales"],
  briefing: ["projects", "people"],
  meeting: ["projects", "attendees", "concepts", "organizations"],
  transcript: ["projects", "attendees"],
  research: ["projects"],
  "decision-record": ["participants"],
  "grant-application": ["collaborators"],
  "message-thread": ["participants", "participantIds"],
};
export const ALWAYS_LIST: ReadonlySet<string> = new Set(Object.values(LIST_FIELDS_BY_TAG).flat());

export const CONFIDENCE_TAGS: ReadonlySet<string> = new Set(["person", "project", "organization", "concept"]);
export const CONFIDENCE_LABELS = ["high", "medium", "low"] as const;

/** task.status (schema-fixes S4): tasks_store vocabulary + todo/done (ClickUp mirror, Prism task UI). */
export const TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending", "in-progress", "blocked", "waiting", "completed", "cancelled", "archived", "todo", "done",
]);
export const TASK_STATUS_SYNONYMS: Readonly<Record<string, string>> = {
  tracked: "pending",
  "not started": "pending",
  open: "pending",
  active: "in-progress",
  doing: "in-progress",
  in_progress: "in-progress",
  "in progress": "in-progress",
  review: "in-progress",
  "in review": "in-progress",
  resolved: "completed",
  complete: "completed",
  closed: "completed",
  duplicate: "cancelled",
  discarded: "cancelled",
  dropped: "cancelled",
  canceled: "cancelled",
  "waiting-on": "waiting",
  waiting_on: "waiting",
};
export const THREAD_PLATFORMS: ReadonlySet<string> = new Set([
  "whatsapp", "telegram", "signal", "discord", "email", "matrix", "twitter", "instagram", "messenger",
]);
const SOURCE_TAGS = new Set(["meeting", "transcript"]);

export type ShapeMode = "create" | "update";

const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function guardEnabled(): boolean {
  return !["0", "false", "off", "no"].includes((process.env.VAULT_SHAPE_GUARD ?? "1").trim().toLowerCase());
}

function cleanList(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  for (const raw of values) {
    if (isBlank(raw)) continue;
    const v = typeof raw === "string" ? raw.trim() : raw;
    const key = typeof v === "object" ? JSON.stringify(v) : v;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** A string in a list field: split on commas only when every piece is a wikilink or an address. */
function splitListString(s: string): string[] {
  const t = s.trim();
  if (t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim());
    if (parts.every((p) => p && ((p.startsWith("[[") && p.endsWith("]]")) || p.includes("@")))) return parts;
  }
  return [t];
}

/** Number / numeric string / label → high|medium|low; anything else null. */
export function confidenceLabel(value: unknown): "high" | "medium" | "low" | null {
  let num: number | null = null;
  if (typeof value === "number") num = value;
  else if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if ((CONFIDENCE_LABELS as readonly string[]).includes(s)) return s as "high" | "medium" | "low";
    if (s !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) num = Number(s);
  }
  if (num === null || !Number.isFinite(num)) return null;
  if (num > 1) num /= 100; // a percentage
  return num >= 0.8 ? "high" : num >= 0.5 ? "medium" : "low";
}

export function canonicalTaskStatus(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim().toLowerCase();
  if (TASK_STATUSES.has(s)) return s;
  return TASK_STATUS_SYNONYMS[s] ?? value;
}

/** Integer epoch ms from a number (s or ms), a digit string or an ISO-8601 string. */
export function epochMs(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return epochMs(Number(s));
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || !s.includes("T") ? s : `${s}Z`);
      if (Number.isFinite(t)) return t;
    }
  }
  return value;
}

const versionText = (value: unknown): unknown => (typeof value === "number" && Number.isFinite(value) ? String(value) : value);

/**
 * Return `metadata` with the declared shapes enforced. `tags` = the note's tags
 * when known (creates; the tags an update adds), else undefined (name rules only).
 */
export function shapeMetadata(
  metadata: Record<string, unknown> | undefined,
  tags: readonly string[] | undefined,
  mode: ShapeMode,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !guardEnabled()) return metadata;
  const tagset = new Set((tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  // Governance notes carry a signature over their metadata: never rewrite them.
  if ("gov_sig" in metadata || [...tagset].some((t) => t.startsWith("governance-"))) return metadata;

  const taggedLists = new Set<string>();
  for (const t of tagset) for (const f of LIST_FIELDS_BY_TAG[t] ?? []) taggedLists.add(f);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    let value = raw;
    if (ALWAYS_LIST.has(key) || taggedLists.has(key)) {
      if (typeof value === "string" && value.trim() === "") {
        if (mode === "update") out[key] = null; // empty IS absent: remove the stored key
        continue;
      }
      if (Array.isArray(value)) value = cleanList(value);
      else if (typeof value === "string" && taggedLists.has(key)) value = cleanList(splitListString(value));
    }
    if (key === "recording_id" && typeof value === "number") value = versionText(value);
    out[key] = value;
  }
  if (tagset.size === 0) return out;

  const dropOrNull = (key: string) => {
    if (mode === "update") out[key] = null;
    else delete out[key];
  };

  if ([...tagset].some((t) => CONFIDENCE_TAGS.has(t)) && "confidence" in out && out.confidence !== null) {
    const label = confidenceLabel(out.confidence);
    if (label) out.confidence = label;
    else dropOrNull("confidence");
  }
  if (tagset.has("task") && "status" in out) out.status = canonicalTaskStatus(out.status);
  if (tagset.has("message-thread")) {
    if (out.lastMessageAt !== undefined && out.lastMessageAt !== null) out.lastMessageAt = epochMs(out.lastMessageAt);
    if (typeof out.platform === "string") {
      const p = out.platform.trim().toLowerCase();
      if (p) out.platform = p;
      else dropOrNull("platform");
    }
  }
  if ([...tagset].some((t) => SOURCE_TAGS.has(t)) && typeof out.source === "string") {
    const s = out.source.trim().toLowerCase();
    if (s) out.source = s;
    else delete out.source; // never clear an existing source from an empty write
  }
  if (tagset.has("spec") && "version" in out) out.version = versionText(out.version);
  if (!tagset.has("task") && (tagset.has("organization") || tagset.has("writing")) && typeof out.status === "string") {
    out.status = out.status.trim().toLowerCase();
  }
  return out;
}

// ── lint (read side) ────────────────────────────────────────────────────────

/** Fields of a project-link kind: a folder link `[[vault/projects/<slug>]]` there dangles. */
const PROJECT_LINK_FIELDS = ["projects", "project"] as const;

function isFolderProjectLink(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t.startsWith("[[") || !t.endsWith("]]")) return false;
  let target = t.slice(2, -2);
  for (const ch of ["|", "#"]) {
    const k = target.indexOf(ch);
    if (k >= 0) target = target.slice(0, k);
  }
  const parts = target.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "vault" && parts[1] === "projects";
}

/**
 * The metadata keys of one note (seen under `tag`) whose stored value has a shape
 * the corrected schema does not declare. Pure; drives the `vault-lint` source.
 */
export function shapeViolations(metadata: Record<string, unknown> | null | undefined, tag: string): string[] {
  const md = metadata ?? {};
  const out: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(md, k) && md[k] !== null && md[k] !== undefined;
  for (const f of LIST_FIELDS_BY_TAG[tag] ?? []) {
    if (!has(f)) continue;
    const v = md[f];
    if (!Array.isArray(v) || v.some((x) => isBlank(x))) out.push(f);
  }
  if (CONFIDENCE_TAGS.has(tag) && has("confidence") && !(CONFIDENCE_LABELS as readonly unknown[]).includes(md.confidence)) out.push("confidence");
  if (tag === "task" && has("status") && !(typeof md.status === "string" && TASK_STATUSES.has(md.status))) out.push("status");
  if (tag === "message-thread") {
    if (has("lastMessageAt") && !Number.isInteger(md.lastMessageAt)) out.push("lastMessageAt");
    if (has("platform") && !(typeof md.platform === "string" && THREAD_PLATFORMS.has(md.platform))) out.push("platform");
  }
  if (SOURCE_TAGS.has(tag) && has("source") && !(typeof md.source === "string" && md.source.trim() !== "" && md.source === md.source.toLowerCase())) out.push("source");
  if (has("recording_id") && typeof md.recording_id !== "string") out.push("recording_id");
  if (tag === "spec" && has("version") && typeof md.version !== "string") out.push("version");
  for (const f of PROJECT_LINK_FIELDS) {
    if (!has(f)) continue;
    const v = md[f];
    if ((Array.isArray(v) ? v : [v]).some(isFolderProjectLink)) out.push(`${f}:folder-link`);
  }
  return [...new Set(out)];
}

/** Every metadata key `shapeViolations` reads for a tag (the lean listing asks for exactly these). */
export function lintKeys(tag: string): string[] {
  const keys = new Set<string>(LIST_FIELDS_BY_TAG[tag] ?? []);
  if (CONFIDENCE_TAGS.has(tag)) keys.add("confidence");
  if (tag === "task") keys.add("status");
  if (tag === "message-thread") ["lastMessageAt", "platform"].forEach((k) => keys.add(k));
  if (SOURCE_TAGS.has(tag)) keys.add("source");
  if (tag === "spec") keys.add("version");
  keys.add("recording_id");
  PROJECT_LINK_FIELDS.forEach((k) => keys.add(k));
  return [...keys];
}

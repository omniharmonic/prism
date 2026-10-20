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
 *
 * THE RULES' DATA (which fields are lists, the vocabularies, the tags) is not
 * written here: it is loaded from the contract, `@prism/core/vault-shapes`
 * (`packages/core/src/lib/schemas/vault-shapes.json`) — the single source the
 * agent repo's guard and every prompt's "Field shapes" block are generated from.
 * `test/schema-drift.test.ts` pins the contract to tag-schemas.json and
 * schema-fixes.json.
 */
import { DECLARED_FIELDS, VAULT_SHAPES as C } from "@prism/core/vault-shapes";

export const LIST_FIELDS_BY_TAG: Readonly<Record<string, readonly string[]>> = C.listFields;
export const ALWAYS_LIST: ReadonlySet<string> = new Set(Object.values(LIST_FIELDS_BY_TAG).flat());

export const CONFIDENCE_TAGS: ReadonlySet<string> = new Set(C.confidence.tags);
export const CONFIDENCE_LABELS = C.confidence.labels as readonly string[] as readonly ["high", "medium", "low"];

/** task.status (schema-fixes S4): tasks_store vocabulary + todo/done (ClickUp mirror, Prism task UI). */
export const TASK_STATUSES: ReadonlySet<string> = new Set(C.taskStatus.values);
export const TASK_STATUS_SYNONYMS: Readonly<Record<string, string>> = C.taskStatus.synonyms;
export const THREAD_PLATFORMS: ReadonlySet<string> = new Set(C.threadPlatforms);
const SOURCE_TAGS = new Set(C.source.tags);
/** Fields that are text wherever they appear / on one tag (contract `textFields`). */
const TEXT_ANYWHERE: readonly string[] = C.textFields["*"] ?? [];
const textFieldsOf = (tag: string): readonly string[] => (tag === "*" ? [] : (C.textFields[tag] ?? []));
const INTEGER_FIELDS: Readonly<Record<string, readonly string[]>> = C.integerFields;
const LOWERCASE_STATUS_TAGS: readonly string[] = C.lowercaseStatusTags;

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
    if (TEXT_ANYWHERE.includes(key) && typeof value === "number") value = versionText(value);
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
  for (const t of tagset) for (const f of INTEGER_FIELDS[t] ?? []) if (out[f] !== undefined && out[f] !== null) out[f] = epochMs(out[f]);
  if (tagset.has("message-thread")) {
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
  for (const t of tagset) for (const f of textFieldsOf(t)) if (f in out) out[f] = versionText(out[f]);
  if (!tagset.has("task") && LOWERCASE_STATUS_TAGS.some((t) => tagset.has(t)) && typeof out.status === "string") {
    out.status = out.status.trim().toLowerCase();
  }
  return out;
}

// ── lint (read side) ────────────────────────────────────────────────────────

/** Fields of a project-link kind: a folder link `[[vault/projects/<slug>]]` there dangles. */
const PROJECT_LINK_FIELDS: readonly string[] = C.projectLink.fields;
const PROJECT_FOLDER_PARTS: readonly string[] = C.projectLink.folder.split("/");

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
  return parts.length === PROJECT_FOLDER_PARTS.length + 1 && PROJECT_FOLDER_PARTS.every((seg, i) => parts[i] === seg);
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
  for (const f of INTEGER_FIELDS[tag] ?? []) if (has(f) && !Number.isInteger(md[f])) out.push(f);
  if (tag === "message-thread") {
    if (has("platform") && !(typeof md.platform === "string" && THREAD_PLATFORMS.has(md.platform))) out.push("platform");
  }
  if (SOURCE_TAGS.has(tag) && has("source") && !(typeof md.source === "string" && md.source.trim() !== "" && md.source === md.source.toLowerCase())) out.push("source");
  for (const f of [...TEXT_ANYWHERE, ...textFieldsOf(tag)]) if (has(f) && typeof md[f] !== "string") out.push(f);
  for (const f of PROJECT_LINK_FIELDS) {
    if (!has(f)) continue;
    const v = md[f];
    if ((Array.isArray(v) ? v : [v]).some(isFolderProjectLink)) out.push(`${f}:folder-link`);
  }
  return [...new Set(out)];
}

/**
 * The DECLARED-schema check: metadata keys of one note whose stored value breaks what
 * the tag's seeded schema (tag-schemas.json) declares — a value outside an `enum`
 * (`<field>:enum`), a value of another type (`<field>:type`), or an empty string where
 * the rule is "empty is absent" (`<field>:empty`). Fields `shapeViolations` already
 * judges (`skip`) are left to it, so nothing is counted twice. Pure; names only.
 */
export function declaredViolations(metadata: Record<string, unknown> | null | undefined, tag: string, skip: readonly string[] = []): string[] {
  const md = metadata ?? {};
  const out: string[] = [];
  const skipped = new Set(skip.map((f) => f.split(":")[0]));
  for (const [field, decl] of Object.entries(DECLARED_FIELDS[tag] ?? {})) {
    if (skipped.has(field) || !Object.prototype.hasOwnProperty.call(md, field)) continue;
    const v = md[field];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") {
      out.push(`${field}:empty`);
      continue;
    }
    const typeOk =
      decl.type === "array" ? Array.isArray(v)
      : decl.type === "integer" ? Number.isInteger(v)
      : decl.type === "number" ? typeof v === "number"
      : decl.type === "boolean" ? typeof v === "boolean"
      : decl.type === "object" ? typeof v === "object" && !Array.isArray(v)
      : typeof v === "string"; // string, date, reference
    if (!typeOk) out.push(`${field}:type`);
    else if (decl.enum && !decl.enum.includes(v as string)) out.push(`${field}:enum`);
  }
  return out;
}

/**
 * Metadata keys that say WHO wrote a note, cheapest first. Read by the lint only to
 * put a mis-shaped note in a writer bucket — the values themselves are never reported.
 */
export const PROVENANCE_KEYS = ["source", "processed_by", "processed-by", "runner", "calendarEventId", "matrixRoomId", "prism_import", "prism_last_writer"] as const;

/**
 * A coarse, low-cardinality name for the writer of a note: its ingest `source` word
 * (clickup, fathom, fireflies, proton-bridge, …), else a marker key. Never an id,
 * address or path. "unknown" = nothing on the note says (a direct vault/MCP write).
 */
export function writerBucket(metadata: Record<string, unknown> | null | undefined): string {
  const md = metadata ?? {};
  if (typeof md.source === "string") {
    const s = md.source.trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]{1,23}$/.test(s)) return s;
  }
  if (md.calendarEventId) return "calendar";
  if (md.matrixRoomId) return "matrix";
  if (md.processed_by || md["processed-by"]) return "routine";
  if (md.runner) return "skill";
  if (md.prism_import) return "import";
  if (md.prism_last_writer) return "prism-user";
  return "unknown";
}

/** Every metadata key the lint reads for a tag (the lean listing asks for exactly these). */
export function lintKeys(tag: string): string[] {
  const keys = new Set<string>(LIST_FIELDS_BY_TAG[tag] ?? []);
  if (CONFIDENCE_TAGS.has(tag)) keys.add("confidence");
  if (tag === "task") keys.add("status");
  (INTEGER_FIELDS[tag] ?? []).forEach((k) => keys.add(k));
  if (tag === "message-thread") keys.add("platform");
  if (SOURCE_TAGS.has(tag)) keys.add("source");
  [...TEXT_ANYWHERE, ...textFieldsOf(tag)].forEach((k) => keys.add(k));
  PROJECT_LINK_FIELDS.forEach((k) => keys.add(k));
  Object.keys(DECLARED_FIELDS[tag] ?? {}).forEach((k) => keys.add(k));
  PROVENANCE_KEYS.forEach((k) => keys.add(k));
  return [...keys];
}

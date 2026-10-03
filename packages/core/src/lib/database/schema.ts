/**
 * Typed page properties — PURE. Turns a vault tag schema (`type`, `enum`,
 * `default`, `description`) plus Prism's presentation hints (`kind`, `label`,
 * option `colors`, `hidden`) into the property definitions the property bar and
 * database views render.
 *
 * Storage contract (unchanged vault data model):
 *   - VALUES live in the note's `metadata[key]` — exactly what every other Prism
 *     surface, ingester and agent already reads and writes.
 *   - TYPES live in the vault tag schema (source of truth; written only through the
 *     server's owner-only `PUT /api/schemas/:tag`, which holds the admin token).
 *   - PRESENTATION hints live on the Prism Server per (vault, tag), merged into
 *     `GET /api/schemas`. They never change a value, so losing them only loses
 *     colours/labels; kinds are re-inferred from the vault type.
 *
 * Value encoding per kind: text/url/select/status/date → string; number → number;
 * checkbox → boolean; multi_select → string[]; person/relation → `[[note path]]`
 * (a string, or string[] when the vault type is `array`); files → string[] of
 * `[name](/api/attachments/<id>)` links (lib/media/attachments.ts `fileRef`).
 */

import { fileRef, parseFileRef, parseFileRefs } from "../media/attachments";

export const PROPERTY_KINDS = [
  "text", "number", "select", "multi_select", "status", "date", "person", "relation", "checkbox", "url", "email", "phone", "files",
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/** Vault 0.7 field types a property may be created with (no `object`). */
export const VAULT_FIELD_TYPES = ["string", "number", "integer", "boolean", "date", "array", "reference"] as const;
export type VaultFieldType = (typeof VAULT_FIELD_TYPES)[number];

export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
  text: "Text", number: "Number", select: "Select", multi_select: "Multi-select", status: "Status",
  date: "Date", person: "Person", relation: "Relation", checkbox: "Checkbox", url: "URL", email: "Email", phone: "Phone", files: "Files & media",
};

/** The vault type a new property of `kind` is created with. */
export const VAULT_TYPE_FOR_KIND: Record<PropertyKind, VaultFieldType> = {
  text: "string", number: "number", select: "string", multi_select: "array", status: "string",
  date: "string", person: "string", relation: "string", checkbox: "boolean", url: "string", email: "string", phone: "string", files: "array",
};

/** Number display formats (a presentation hint — the stored value stays a plain number). */
export const NUMBER_FORMATS = ["number", "comma", "percent", "usd", "eur", "gbp"] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
export const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
  number: "Number", comma: "Number with commas", percent: "Percent", usd: "US dollar", eur: "Euro", gbp: "Pound",
};

/** Status groups (Notion's To-do / In progress / Complete). */
export const STATUS_GROUPS = ["todo", "in_progress", "complete"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];
export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = { todo: "To-do", in_progress: "In progress", complete: "Complete" };

/**
 * Presentation hints (Prism Server, per vault + tag + field). They NEVER change a
 * stored value or the vault schema: a rename is a label, a "delete" hides the
 * property everywhere (`deleted`), an option rename/recolour/reorder/delete is a
 * map from the stored value to how it is shown.
 */
export interface FieldHints {
  kind?: PropertyKind;
  label?: string;
  colors?: Record<string, OptionColor>;
  hidden?: boolean;
  relationTag?: string;
  reverseLabel?: string;
  /** "Deleted": hidden on every surface (pages, views, filters). Values stay until an owner removes them. */
  deleted?: boolean;
  /** Stored option value → display name (an option "rename"). */
  optionLabels?: Record<string, string>;
  /** Display order of options (stored values); unlisted options follow in schema order. */
  optionOrder?: string[];
  /** Options no longer offered (only allowed while no page uses them). */
  hiddenOptions?: string[];
  /** Number: how the value is displayed. */
  format?: NumberFormat;
  /** Status: option value → group. */
  statusGroups?: Record<string, StatusGroup>;
}

/** One field as `GET /api/schemas` returns it: vault def + Prism hints. */
export interface SchemaField extends FieldHints {
  type?: string;
  enum?: string[];
  default?: unknown;
  description?: string;
  indexed?: boolean;
  /** Relation: the tag whose pages the picker searches ("the target database"). */
  relationTag?: string;
  /** Relation: when set, pages of `relationTag` show the pages that link to them under this label. */
  reverseLabel?: string;
}
export interface TagSchema {
  description: string | null;
  fields: Record<string, SchemaField>;
}
export type SchemaMap = Record<string, TagSchema>;

export interface PropertyOption {
  value: string;
  /** What people see (the option's display name; defaults to the stored value). */
  label: string;
  color: OptionColor;
  /** Status properties: the option's group. */
  group?: StatusGroup;
}
export interface PropertyDef {
  key: string;
  label: string;
  kind: PropertyKind;
  options: PropertyOption[];
  /** Tag whose schema declares it; null for a free metadata key. */
  tag: string | null;
  type?: string;
  description?: string;
  default?: unknown;
  /** True when the vault schema stores multiple values (array). */
  multiple: boolean;
  /** The vault enum exactly (never colour-hint keys) — what a schema write may extend. */
  enumValues: string[];
  /** Relation: the tag the picker searches. */
  target?: string;
  /** Relation: the reverse label shown on target pages. */
  reverseLabel?: string;
  /** Read-only system property (created/edited time/by). */
  system?: SystemKind;
  /** Number: display format. */
  format?: NumberFormat;
  /** Options hidden from pickers (still shown on pages that hold them). */
  hiddenOptions?: string[];
}

/**
 * Kinds a field of a given VAULT type can be presented as (NP-DB-11 "change
 * type"). A retype inside one row of this table only changes presentation; any
 * other change would be a vault type change, which Prism refuses.
 */
export function compatibleKinds(vaultType: string | undefined): PropertyKind[] {
  switch (vaultType) {
    case "boolean": return ["checkbox"];
    case "number":
    case "integer": return ["number"];
    case "date": return ["date"];
    case "reference": return ["relation", "person"];
    case "array": return ["multi_select", "person", "relation", "files"];
    case "string":
    case undefined: return ["text", "url", "email", "phone", "date", "select", "status", "person", "relation"];
    default: return [];
  }
}

/** The display name of an option value. */
export function optionLabel(def: Pick<PropertyDef, "options"> | undefined, value: string): string {
  return def?.options.find((o) => o.value === value)?.label ?? value;
}

const TODO_WORDS = /^(todo|to do|to-do|not started|backlog|draft|raw|new|open|planned|planning|tentative)$/i;
const DONE_WORDS = /^(done|complete|completed|closed|shipped|published|processed|archived|cancelled|canceled|confirmed|resolved)$/i;
/** A status option's group: the hint, else a guess from the word. */
export function statusGroupOf(value: string, hints?: Record<string, StatusGroup>): StatusGroup {
  const h = hints?.[value];
  if (h && (STATUS_GROUPS as readonly string[]).includes(h)) return h;
  const v = value.trim();
  return TODO_WORDS.test(v) ? "todo" : DONE_WORDS.test(v) ? "complete" : "in_progress";
}

/** Notion's system properties: read-only, sortable, filterable. */
export type SystemKind = "created_time" | "edited_time" | "created_by" | "edited_by";
/** Who last wrote a note — stamped by the Prism Server gateway (`apps/server/src/writer-stamp.ts`). */
export const LAST_WRITER_KEY = "prism_last_writer";
export const SYSTEM_PROPERTIES: PropertyDef[] = [
  { key: "$createdAt", label: "Created time", kind: "date", options: [], tag: null, multiple: false, enumValues: [], system: "created_time" },
  { key: "$updatedAt", label: "Last edited time", kind: "date", options: [], tag: null, multiple: false, enumValues: [], system: "edited_time" },
  { key: "prism_creator", label: "Created by", kind: "text", options: [], tag: null, multiple: false, enumValues: [], system: "created_by" },
  { key: LAST_WRITER_KEY, label: "Last edited by", kind: "text", options: [], tag: null, multiple: false, enumValues: [], system: "edited_by" },
];
export const isSystemProperty = (key: string): boolean => SYSTEM_PROPERTIES.some((p) => p.key === key);

/** A row/note's value for `def` (system properties read note columns). */
export function propertyValue(n: { createdAt?: string | null; updatedAt?: string | null; metadata?: Record<string, unknown> | null }, key: string): unknown {
  if (key === "$createdAt") return n.createdAt ?? null;
  if (key === "$updatedAt") return n.updatedAt ?? null;
  return n.metadata?.[key];
}

// Metadata keys that are system state, never shown as properties.
export const SYSTEM_KEYS = new Set([
  "type", "prism_type", "sync", "title", "icon", "cover", "coverY", "layout", "content_font",
]);
export const isSystemKey = (k: string): boolean =>
  SYSTEM_KEYS.has(k) || k.startsWith("prism_") || k.startsWith("gov_") || k.startsWith("_");

const PERSON_KEYS = /^(assigned|assignee|assignees|owner|owners|person|people|author|authors|lead|attendees|participants|collaborators|reviewer|reviewers|contact)$/i;
const RELATION_KEYS = /^(project|projects|parent|related|relates_to|organization|organizations|org|epic|area)$/i;
const URL_KEYS = /(^|_)(url|link|website|href)$/i;
const DATE_KEYS = /^(date|due|deadline|start|end|scheduled|completed|completed_at|due_date|start_date|end_date|first-met|last-contact|published)$/i;
const STATUS_KEYS = /^(status|state|stage|event_status)$/i;
const EMAIL_KEYS = /^(email|e-mail|mail|email_address)$/i;
const PHONE_KEYS = /^(phone|telephone|mobile|cell|phone_number)$/i;
const FILES_KEYS = /^(files?|attachments?|media|documents?)$/i;

/** Kind for a schema field (hints win, then vault type, then the key name). */
export function inferKind(key: string, f: SchemaField | undefined, sample?: unknown): PropertyKind {
  if (f?.kind && (PROPERTY_KINDS as readonly string[]).includes(f.kind)) return f.kind;
  const t = f?.type;
  if (t === "boolean") return "checkbox";
  if (t === "number" || t === "integer") return "number";
  if (t === "date") return "date";
  if (t === "reference") return "relation";
  if (t === "array") {
    if (FILES_KEYS.test(key) || (Array.isArray(sample) && sample.some((x) => parseFileRef(x)))) return "files";
    if (PERSON_KEYS.test(key)) return "person";
    if (RELATION_KEYS.test(key)) return "relation";
    return "multi_select";
  }
  if (f?.enum?.length) return STATUS_KEYS.test(key) ? "status" : "select";
  if (t === undefined) {
    // A free key (no schema): only the stored value may decide, so editing can
    // never change its format (e.g. plain "Alex Chen" never becomes [[Alex Chen]]).
    if (typeof sample === "boolean") return "checkbox";
    if (typeof sample === "number") return "number";
    if (Array.isArray(sample) && sample.some((x) => parseFileRef(x))) return "files";
    if (Array.isArray(sample)) return sample.some((x) => typeof x === "string" && x.startsWith("[[")) ? (PERSON_KEYS.test(key) ? "person" : "relation") : "multi_select";
    if (typeof sample === "string") {
      if (sample.startsWith("[[")) return PERSON_KEYS.test(key) ? "person" : "relation";
      if (/^https?:\/\//i.test(sample)) return "url";
      if (looksLikeEmail(sample)) return "email";
      if (/^\d{4}-\d{2}-\d{2}($|T)/.test(sample)) return "date";
    }
    return "text";
  }
  if (t === "string") {
    if (URL_KEYS.test(key)) return "url";
    if (EMAIL_KEYS.test(key)) return "email";
    if (PHONE_KEYS.test(key)) return "phone";
    if (DATE_KEYS.test(key)) return "date";
    if (PERSON_KEYS.test(key)) return "person";
    if (RELATION_KEYS.test(key) && typeof sample === "string" && sample.startsWith("[[")) return "relation";
  }
  return "text";
}

/** "first-met" → "First met". */
export function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim()
    .replace(/\b(url|id|api)\b/gi, (w) => w.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const KNOWN_COLORS: Record<string, OptionColor> = {
  todo: "gray", "to do": "gray", draft: "gray", raw: "gray", backlog: "gray", low: "gray",
  "in-progress": "blue", "in progress": "blue", active: "blue", doing: "blue", medium: "yellow", tentative: "yellow",
  review: "purple", "in-review": "purple", paused: "orange", high: "orange",
  done: "green", complete: "green", completed: "green", confirmed: "green", published: "green", processed: "green",
  blocked: "red", critical: "red", cancelled: "brown", canceled: "brown", archived: "brown",
};

/** Stable colour for an option: explicit hint, a known word, else a hash. */
export function optionColor(value: string, hints?: Record<string, OptionColor>): OptionColor {
  const hinted = hints?.[value];
  if (hinted && (OPTION_COLORS as readonly string[]).includes(hinted)) return hinted;
  const known = KNOWN_COLORS[value.trim().toLowerCase()];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return OPTION_COLORS[1 + (h % (OPTION_COLORS.length - 1))]!;
}

export function propertyFromField(key: string, f: SchemaField, tag: string | null, sample?: unknown): PropertyDef {
  const kind = inferKind(key, f, sample);
  const hiddenOptions = Array.isArray(f.hiddenOptions) ? f.hiddenOptions.filter((v) => typeof v === "string") : [];
  const all = [...new Set<string>([...(f.enum ?? []), ...Object.keys(f.colors ?? {})])].filter((v) => !hiddenOptions.includes(v));
  const order = Array.isArray(f.optionOrder) ? f.optionOrder : [];
  const rank = (v: string) => { const i = order.indexOf(v); return i < 0 ? order.length + all.indexOf(v) : i; };
  const values = order.length ? [...all].sort((a, b) => rank(a) - rank(b)) : all;
  const labelOf = (v: string) => { const l = f.optionLabels?.[v]; return typeof l === "string" && l.trim() ? l.trim() : v; };
  return {
    key,
    label: f.label?.trim() || humanize(key),
    kind,
    options: values.map((v) => ({ value: v, label: labelOf(v), color: optionColor(v, f.colors), ...(kind === "status" ? { group: statusGroupOf(v, f.statusGroups) } : {}) })),
    ...(kind === "number" && f.format && (NUMBER_FORMATS as readonly string[]).includes(f.format) ? { format: f.format } : {}),
    ...(hiddenOptions.length ? { hiddenOptions } : {}),
    tag,
    type: f.type,
    description: f.description,
    default: f.default,
    multiple: f.type === "array" || kind === "multi_select",
    enumValues: [...(f.enum ?? [])],
    ...(f.relationTag ? { target: f.relationTag } : {}),
    ...(f.reverseLabel ? { reverseLabel: f.reverseLabel } : {}),
  };
}

/** Keys the source tags' schemas mark as deleted (hidden everywhere). */
export function deletedKeys(tags: string[], schemas: SchemaMap): Set<string> {
  const out = new Set<string>();
  for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) if (f.deleted) out.add(k);
  return out;
}

/**
 * Properties of a note: every schema field of its tags (first tag that declares
 * a key wins), then its own non-system metadata keys no schema declares. Hidden
 * fields (hint `hidden`) are dropped unless the note has a value for them.
 */
export function resolveProperties(
  tags: string[],
  schemas: SchemaMap,
  metadata: Record<string, unknown> | null | undefined,
): PropertyDef[] {
  const meta = metadata ?? {};
  const out: PropertyDef[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const s = schemas[tag];
    if (!s) continue;
    for (const [key, f] of Object.entries(s.fields)) {
      if (seen.has(key) || isSystemKey(key)) continue;
      // A deleted property is hidden on every surface, value or not (its key stays claimed).
      if (f.deleted) { seen.add(key); continue; }
      if (f.hidden && isBlank(meta[key])) continue;
      seen.add(key);
      out.push(propertyFromField(key, f, tag, meta[key]));
    }
  }
  for (const [key, value] of Object.entries(meta)) {
    if (seen.has(key) || isSystemKey(key) || value === null || typeof value === "object" && !Array.isArray(value)) continue;
    seen.add(key);
    out.push(propertyFromField(key, {}, null, value));
  }
  return out;
}

export const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** `[[vault/people/Ada Lovelace]]` → `Ada Lovelace`. */
export function linkLabel(v: string): string {
  const t = v.trim();
  const inner = t.length >= 4 && t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2) : t;
  const alias = inner.split("|")[1];
  if (alias) return alias.trim();
  return (inner.split("/").pop() ?? inner).replace(/\.[^.]+$/, "");
}
/** `[[path]]` → `path`; plain strings pass through. */
export const linkTarget = (v: string): string => {
  const t = v.trim();
  return (t.length >= 4 && t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2) : t).split("|")[0]!.trim();
};
export const asWikilink = (path: string): string => `[[${path}]]`;

/** Short human text for any property value (cells, cards, filters). */
export function formatValue(def: Pick<PropertyDef, "kind"> & Partial<Pick<PropertyDef, "options" | "format">>, v: unknown): string {
  if (isBlank(v)) return "";
  if (def.kind === "checkbox") return v === true ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => formatValue(def, x)).filter(Boolean).join(", ");
  if ((def.kind === "select" || def.kind === "status" || def.kind === "multi_select") && def.options) return optionLabel(def as Pick<PropertyDef, "options">, String(v));
  if (def.kind === "person" || def.kind === "relation") return typeof v === "string" ? linkLabel(v) : String(v);
  if (def.kind === "date" && typeof v === "string") return formatDate(v);
  if (def.kind === "files") return parseFileRefs(v).map((f) => f.name).join(", ");
  if (def.kind === "phone" && typeof v === "string") return v.trim();
  if (def.kind === "number" && typeof v === "number") return formatNumber(v, def.format);
  return String(v);
}

/** A number as people read it. `percent` shows the stored number followed by % (12 → 12%), like Notion. */
export function formatNumber(n: number, format?: NumberFormat): string {
  switch (format) {
    case "number": return String(n);
    case "percent": return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
    case "usd": return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
    case "eur": return n.toLocaleString("en-IE", { style: "currency", currency: "EUR" });
    case "gbp": return n.toLocaleString("en-GB", { style: "currency", currency: "GBP" });
    default: return n.toLocaleString();
  }
}

/** "Oct 2, 3:41 PM" (+ year when not this year) — system timestamps. */
export function formatDateTime(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Valid-looking email (one @, a dot in the domain, no spaces). */
export function looksLikeEmail(v: string): boolean {
  // Linear (no backtracking regex over user text, review H2).
  const s = v.trim();
  if (s.length > 320) return false;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c <= 32 || c === 60 || c === 62) return false; }
  const dot = s.lastIndexOf(".");
  return dot > at + 1 && dot < s.length - 1;
}
/** Valid-looking phone (digits with + ( ) - . space, 5–20 digits). */
export const looksLikePhone = (v: string): boolean => /^\+?[\d\s().-]+$/.test(v.trim()) && (v.replace(/\D/g, "").length >= 5) && (v.replace(/\D/g, "").length <= 20);

export function formatDate(v: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(day ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Coerce raw editor input into the stored shape for `def` (null = clear). */
export function coerceValue(def: Pick<PropertyDef, "kind" | "multiple">, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (def.kind) {
    case "checkbox": return raw === true || raw === "true";
    case "number": {
      if (raw === "") return null;
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "multi_select": {
      const list = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim()).filter(Boolean);
      return list.length ? [...new Set(list)] : null;
    }
    case "files": {
      // Only links to OUR attachments are file values; anything else is dropped, never stored.
      const list = parseFileRefs(raw).map((f) => fileRef(f.name, f.url));
      return list.length ? [...new Set(list)].slice(0, 50) : null;
    }
    case "person":
    case "relation": {
      const list = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim()).filter(Boolean);
      if (!list.length) return null;
      return def.multiple ? [...new Set(list)] : list[0];
    }
    default: {
      const s = String(raw);
      return s.trim() === "" ? null : s;
    }
  }
}

// ── schema patch (PUT /api/schemas/:tag) ─────────────────────────────────────

export interface SchemaPatch {
  description?: string;
  /** New fields (type required) or additive edits to existing ones. */
  fields?: Record<string, { type?: VaultFieldType; enum?: string[]; description?: string; default?: unknown }>;
  /** Presentation hints per field (stored by the Prism Server, not the vault). */
  ui?: Record<string, FieldHints>;
}

const recordOf = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BANNED = new Set(["__proto__", "constructor", "prototype"]);
const okText = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

/** Validate an untrusted `PUT /api/schemas/:tag` body. Never throws. */
export function validateSchemaPatch(raw: unknown): { ok: true; patch: SchemaPatch } | { ok: false; error: string } {
  if (!recordOf(raw)) return { ok: false, error: "body must be an object" };
  const patch: SchemaPatch = {};
  if (raw.description !== undefined) {
    if (!okText(raw.description, 1000)) return { ok: false, error: "description must be ≤1000 chars" };
    patch.description = raw.description as string;
  }
  const names = (o: Record<string, unknown>) => Object.keys(o);
  if (raw.fields !== undefined) {
    if (!recordOf(raw.fields) || names(raw.fields).length > 20) return { ok: false, error: "fields must be an object of ≤20 fields" };
    patch.fields = {};
    for (const [name, def] of Object.entries(raw.fields)) {
      if (!FIELD_NAME.test(name) || BANNED.has(name) || isSystemKey(name)) return { ok: false, error: `invalid field name: ${name}` };
      if (!recordOf(def)) return { ok: false, error: `field ${name} must be an object` };
      const out: NonNullable<SchemaPatch["fields"]>[string] = {};
      if (def.type !== undefined) {
        if (!(VAULT_FIELD_TYPES as readonly string[]).includes(def.type as string)) return { ok: false, error: `field ${name}: unsupported type` };
        out.type = def.type as VaultFieldType;
      }
      if (def.enum !== undefined) {
        if (!Array.isArray(def.enum) || def.enum.length > 100 || !def.enum.every((e) => okText(e, 80) && (e as string).trim() !== "")) {
          return { ok: false, error: `field ${name}: enum must be ≤100 non-empty strings of ≤80 chars` };
        }
        out.enum = [...new Set(def.enum as string[])];
      }
      if (def.description !== undefined) {
        if (!okText(def.description, 500)) return { ok: false, error: `field ${name}: description must be ≤500 chars` };
        out.description = def.description as string;
      }
      if (def.default !== undefined) {
        const d = def.default;
        if (!(d === null || typeof d === "boolean" || (typeof d === "number" && Number.isFinite(d)) || okText(d, 200))) {
          return { ok: false, error: `field ${name}: default must be a scalar` };
        }
        out.default = d;
      }
      patch.fields[name] = out;
    }
  }
  if (raw.ui !== undefined) {
    if (!recordOf(raw.ui) || names(raw.ui).length > 100) return { ok: false, error: "ui must be an object of ≤100 fields" };
    patch.ui = {};
    for (const [name, h] of Object.entries(raw.ui)) {
      if (!FIELD_NAME.test(name) || BANNED.has(name)) return { ok: false, error: `invalid field name: ${name}` };
      if (!recordOf(h)) return { ok: false, error: `ui.${name} must be an object` };
      const out: FieldHints = {};
      if (h.kind !== undefined) {
        if (!(PROPERTY_KINDS as readonly string[]).includes(h.kind as string)) return { ok: false, error: `ui.${name}: unknown kind` };
        out.kind = h.kind as PropertyKind;
      }
      if (h.label !== undefined) {
        if (!okText(h.label, 80)) return { ok: false, error: `ui.${name}: label must be ≤80 chars` };
        out.label = (h.label as string).trim();
      }
      if (h.hidden !== undefined) {
        if (typeof h.hidden !== "boolean") return { ok: false, error: `ui.${name}: hidden must be boolean` };
        out.hidden = h.hidden;
      }
      if (h.relationTag !== undefined) {
        if (!okText(h.relationTag, 128) || !(h.relationTag as string).trim()) return { ok: false, error: `ui.${name}: relationTag must be a tag name` };
        out.relationTag = (h.relationTag as string).trim();
      }
      if (h.reverseLabel !== undefined) {
        if (!okText(h.reverseLabel, 80)) return { ok: false, error: `ui.${name}: reverseLabel must be ≤80 chars` };
        out.reverseLabel = (h.reverseLabel as string).trim();
      }
      if (h.deleted !== undefined) {
        if (typeof h.deleted !== "boolean") return { ok: false, error: `ui.${name}: deleted must be boolean` };
        out.deleted = h.deleted;
      }
      if (h.format !== undefined) {
        if (!(NUMBER_FORMATS as readonly string[]).includes(h.format as string)) return { ok: false, error: `ui.${name}: unknown number format` };
        out.format = h.format as NumberFormat;
      }
      const optName = (o: unknown) => okText(o, 80) && (o as string) !== "" && !BANNED.has(o as string);
      if (h.optionLabels !== undefined) {
        if (!recordOf(h.optionLabels) || names(h.optionLabels).length > 100) return { ok: false, error: `ui.${name}: optionLabels must be an object of ≤100 options` };
        out.optionLabels = {};
        for (const [opt, l] of Object.entries(h.optionLabels)) {
          if (!optName(opt) || !okText(l, 80)) return { ok: false, error: `ui.${name}: invalid option name` };
          if ((l as string).trim()) out.optionLabels[opt] = (l as string).trim();
        }
        const shown = Object.values(out.optionLabels).map((l) => l.toLowerCase());
        if (new Set(shown).size !== shown.length) return { ok: false, error: `ui.${name}: two options cannot share a name` };
      }
      for (const listKey of ["optionOrder", "hiddenOptions"] as const) {
        const v = h[listKey];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.length > 200 || !v.every(optName)) return { ok: false, error: `ui.${name}: ${listKey} must be a list of option names` };
        out[listKey] = [...new Set(v as string[])];
      }
      if (h.statusGroups !== undefined) {
        if (!recordOf(h.statusGroups) || names(h.statusGroups).length > 100) return { ok: false, error: `ui.${name}: statusGroups must be an object` };
        out.statusGroups = {};
        for (const [opt, g] of Object.entries(h.statusGroups)) {
          if (!optName(opt) || !(STATUS_GROUPS as readonly string[]).includes(g as string)) return { ok: false, error: `ui.${name}: invalid status group` };
          out.statusGroups[opt] = g as StatusGroup;
        }
      }
      if (h.colors !== undefined) {
        if (!recordOf(h.colors) || names(h.colors).length > 100) return { ok: false, error: `ui.${name}: colors must be an object` };
        out.colors = {};
        for (const [opt, c] of Object.entries(h.colors)) {
          if (!okText(opt, 80) || BANNED.has(opt) || !(OPTION_COLORS as readonly string[]).includes(c as string)) {
            return { ok: false, error: `ui.${name}: invalid colour` };
          }
          out.colors[opt] = c as OptionColor;
        }
      }
      patch.ui[name] = out;
    }
  }
  if (!patch.fields && !patch.ui && patch.description === undefined) return { ok: false, error: "nothing to change" };
  return { ok: true, patch };
}

/**
 * Merge an additive patch onto the current vault fields. Refuses anything that
 * could orphan existing values: changing a field's type, removing enum values,
 * or adding an enum to a free-text field. Display renames are hints (`ui.label`),
 * so the metadata KEY — and every stored value — never moves.
 */
export function mergeSchemaFields(
  current: Record<string, SchemaField>,
  add: NonNullable<SchemaPatch["fields"]>,
): { ok: true; fields: Record<string, SchemaField>; changed: boolean } | { ok: false; error: string; field: string } {
  const fields: Record<string, SchemaField> = {};
  for (const [k, v] of Object.entries(current)) fields[k] = { ...v };
  let changed = false;
  for (const [name, def] of Object.entries(add)) {
    const cur = fields[name];
    if (!cur) {
      if (!def.type) return { ok: false, error: "a new field needs a type", field: name };
      // Multi-select options live in the presentation hints (`ui.colors` keys):
      // the vault validates `enum` on string fields only.
      if (def.enum && def.type !== "string") return { ok: false, error: "only string fields take options", field: name };
      fields[name] = {
        type: def.type,
        ...(def.enum?.length ? { enum: def.enum } : {}),
        ...(def.description ? { description: def.description } : {}),
        ...(def.default !== undefined && def.default !== null ? { default: def.default } : {}),
      };
      changed = true;
      continue;
    }
    if (def.type && cur.type && def.type !== cur.type) return { ok: false, error: "changing a field's type is not additive", field: name };
    if (def.enum) {
      if (!cur.enum?.length) return { ok: false, error: "adding options to a free-text field is not additive", field: name };
      const missing = cur.enum.filter((e) => !def.enum!.includes(e));
      if (missing.length) return { ok: false, error: `removing options is not additive: ${missing.join(", ")}`, field: name };
      if (def.enum.length !== cur.enum.length) {
        fields[name] = { ...cur, enum: def.enum };
        changed = true;
      }
    }
    if (def.description !== undefined && def.description !== (cur.description ?? "")) {
      fields[name] = { ...fields[name], description: def.description };
      changed = true;
    }
  }
  return { ok: true, fields, changed };
}

/**
 * A safe path LEAF for a page titled `t` (CSV import, new rows, inline
 * databases): no separators/control characters, never `.`/`..` (review L1).
 */
export function safeTitleLeaf(t: string, max = 120): string {
  let s = "";
  for (const ch of t.trim()) {
    const c = ch.codePointAt(0)!;
    s += ch === "/" || ch === "\\" || c < 32 || c === 127 ? "-" : ch;
    if (s.length >= max) break;
  }
  s = s.trim();
  return !s || /^\.+$/.test(s) ? "Untitled" : s;
}

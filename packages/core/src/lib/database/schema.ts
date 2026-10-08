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
import { dateRange, hasTime, isDateValue } from "./dates";

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
  /** Set by the server on a field a type conversion created: the key its values were converted from. */
  convertedFrom?: string;
  /**
   * Relation / person: the pages the picker searches and new pages are created in —
   * pages carrying a tag, or pages under a folder. `relationTag` is the older form of
   * `{tag}`; the two are kept in step (`mergeFieldHints`) so older clients still read it.
   */
  relationTarget?: RelationTarget;
  /** Relation / person: one page or several. Must agree with the vault type when there is one (array = several). */
  multiple?: boolean;
}

/** What a relation points at: pages with a tag, or pages under a folder (path prefix). */
export type RelationTarget = { tag: string } | { pathPrefix: string };

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
  /** Property keys a page with this tag shows at the top, in order (a per-tag presentation hint; absent = every filled property). */
  pinned?: string[];
}
/** Most properties one tag may pin to the top of its pages. */
export const MAX_PINNED = 12;
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
  /** Relation: the folder the picker searches (a path-prefix target; `target` is then absent). */
  targetPath?: string;
  /** The target came from the property's NAME (no hint stored): "projects" → #project. */
  targetInferred?: boolean;
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
 * An option's display name may not read as ANOTHER option (its stored value or its
 * name): two chips that look the same but store different values. Returns the
 * clashing name, or null. `values` = every option of the field.
 */
export function optionNameClash(values: string[], labels: Record<string, string>): string | null {
  const taken = new Map<string, string>(); // shown text (lower-cased) → the option value it belongs to
  for (const v of values) if (!Object.prototype.hasOwnProperty.call(labels, v)) taken.set(v.toLowerCase(), v);
  for (const [v, l] of Object.entries(labels)) {
    const shown = l.toLowerCase();
    const holder = taken.get(shown);
    if (holder !== undefined && holder !== v) return l;
    // The stored value of another option, even one that is itself renamed, stays reserved.
    if (values.some((o) => o !== v && o.toLowerCase() === shown)) return l;
    taken.set(shown, v);
  }
  return null;
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
/**
 * Presentation state stored beside the properties (the page's own font). Never LISTED as a property —
 * but deliberately not a system key: `POST /api/properties/:id` refuses system keys, and the queued
 * font write replays through that route.
 */
export const PRESENTATION_KEYS = new Set(["contentFont"]);
/** A metadata key no schema declares may be shown as a free property. */
export const isListableKey = (k: string): boolean => !isSystemKey(k) && !PRESENTATION_KEYS.has(k);

const PERSON_KEYS = /^(assigned|assignee|assignees|owner|owners|person|people|author|authors|lead|attendees|participants|collaborators|reviewer|reviewers|contact)$/i;
/** A property name that reads as people ("assignee", "owner", "reviewer", …) — `inferKind`'s own rule. */
export const isPeopleKeyName = (key: string): boolean => PERSON_KEYS.test(key);
const RELATION_KEYS = /^(project|projects|parent|related|relates_to|organization|organizations|org|epic|area)$/i;
const URL_KEYS = /(^|_)(url|link|website|href)$/i;
const DATE_KEYS = /^(date|due|deadline|start|end|scheduled|completed|completed_at|due_date|start_date|end_date|first-met|last-contact|published)$/i;
const STATUS_KEYS = /^(status|state|stage|event_status)$/i;
const EMAIL_KEYS = /^(email|e-mail|mail|email_address)$/i;
const PHONE_KEYS = /^(phone|telephone|mobile|cell|phone_number)$/i;
const FILES_KEYS = /^(files?|attachments?|media|documents?)$/i;

/** Property names that point at people, whatever their exact word. */
const PERSON_TARGET_NAMES = /^(people|persons?|attendees?|participants?|assigned|assignees?|owners?|authors?|leads?|collaborators?|reviewers?|contacts?|members?)$/i;
const ORG_TARGET_NAMES = /^(orgs?|organi[sz]ations?|compan(y|ies))$/i;

/**
 * The tag a relation-ish property points at, read from its NAME when no hint says
 * (C: "projects" → #project, "attendees" → #person, "organizations" → #organization,
 * "meetings" → #meeting, "tasks" → #task). Only a tag in `knownTags` (tags with a
 * schema) is ever proposed, and only for names that read as a relation: a people
 * word, a RELATION_KEYS word, or the plural of a known tag. "email" next to an
 * #email tag is NOT a relation. Null = no confident answer (never a guess).
 */
export function inferRelationTarget(key: string, knownTags: Iterable<string>): string | null {
  const known = new Set<string>();
  for (const t of knownTags) known.add(t.toLowerCase());
  const k = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!k) return null;
  const has = (t: string) => known.has(t) ? t : null;
  if (PERSON_TARGET_NAMES.test(k)) return has("person");
  if (ORG_TARGET_NAMES.test(k)) return has("organization") ?? has("organisation");
  if (/^projects?$/.test(k)) return has("project");
  // The plural of a known tag ("meetings", "tasks", "categories", "boxes").
  const singulars = [k.endsWith("ies") ? `${k.slice(0, -3)}y` : null, k.endsWith("es") ? k.slice(0, -2) : null, k.endsWith("s") ? k.slice(0, -1) : null];
  for (const s of singulars) if (s && s.length > 1 && has(s)) return s;
  // The singular itself only for words that already read as a relation ("organization", "epic").
  if (RELATION_KEYS.test(k) && has(k)) return k;
  return null;
}

/** Does this name read as a relation or people property (for the backfill report)? */
export const isRelationKeyName = (key: string): boolean => RELATION_KEYS.test(key) || PERSON_KEYS.test(key) || PERSON_TARGET_NAMES.test(key) || ORG_TARGET_NAMES.test(key);

/** The target a field's hints state (`relationTarget`, else the older `relationTag`), or null. */
export function relationTargetOf(f: Pick<FieldHints, "relationTarget" | "relationTag"> | undefined): RelationTarget | null {
  const t = f?.relationTarget as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    if (typeof t.tag === "string" && t.tag.trim()) return { tag: t.tag.trim() };
    if (typeof t.pathPrefix === "string" && t.pathPrefix.trim()) return { pathPrefix: t.pathPrefix.trim() };
  }
  if (typeof f?.relationTag === "string" && f.relationTag.trim()) return { tag: f.relationTag.trim() };
  return null;
}

/**
 * Merge a hints patch onto the stored hints of one field (the server's PUT, the
 * fixtures). Colours merge per option; `relationTarget` and `relationTag` are kept
 * in step — a tag target also writes `relationTag` (older clients, reverse
 * relations read it), a folder target drops it.
 */
export function mergeFieldHints(prev: FieldHints | undefined, h: FieldHints): FieldHints {
  const next: FieldHints = { ...(prev ?? {}), ...h };
  if (h.colors) next.colors = { ...(prev?.colors ?? {}), ...h.colors };
  if (h.relationTarget) {
    if ("tag" in h.relationTarget) next.relationTag = h.relationTarget.tag;
    else delete next.relationTag;
  } else if (h.relationTag) next.relationTarget = { tag: h.relationTag };
  return next;
}

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
      if (/^\d{4}-\d{2}-\d{2}($|T)/.test(sample) && isDateValue(sample)) return "date";
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

/** An option value stored as an identifier ("in-progress", "not_started", "todo") reads as words. */
const OPTION_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const OPTION_WORDS: Record<string, string> = { todo: "To do" };

/** The name an option shows when no `optionLabels` hint renames it: "in-progress" → "In progress".
 *  Only identifier-shaped values change; anything typed with spaces or capitals shows as typed. The
 *  stored value never changes (filters, CSV export and writes use it). */
export function defaultOptionLabel(value: string): string {
  if (!OPTION_SLUG.test(value)) return value;
  const known = OPTION_WORDS[value];
  if (known) return known;
  const words = value.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/**
 * `knownTags` (tags with a schema) lets a relation-ish name find its target when no
 * hint names one (`inferRelationTarget`). With a target, a DECLARED string/array field
 * named like a relation ("project", "projects", "meetings") is a relation whatever its
 * current value — plain names and bare slugs then show as chips the picker can fix.
 * A free key (no schema) keeps the kind its value gives it.
 */
export function propertyFromField(key: string, f: SchemaField, tag: string | null, sample?: unknown, knownTags?: Iterable<string>): PropertyDef {
  let kind = inferKind(key, f, sample);
  const hinted = relationTargetOf(f);
  const inferred = !hinted && knownTags ? inferRelationTarget(key, knownTags) : null;
  const declaredText = f.type === "string" || f.type === "array" || f.type === "reference";
  if (f.kind === undefined && declaredText && (kind === "text" || kind === "multi_select") && (hinted || inferred)) {
    const targetTag = hinted && "tag" in hinted ? hinted.tag : inferred;
    kind = PERSON_KEYS.test(key) || PERSON_TARGET_NAMES.test(key) || targetTag === "person" ? "person" : "relation";
  }
  const linkish = kind === "relation" || kind === "person";
  const target = linkish ? hinted ?? (inferred ? { tag: inferred } : null) : null;
  const multiple = f.type === "array" || kind === "multi_select" || (f.type === undefined && linkish && (typeof f.multiple === "boolean" ? f.multiple : Array.isArray(sample)));
  const hiddenOptions = Array.isArray(f.hiddenOptions) ? f.hiddenOptions.filter((v) => typeof v === "string") : [];
  const all = [...new Set<string>([...(f.enum ?? []), ...Object.keys(f.colors ?? {})])].filter((v) => !hiddenOptions.includes(v));
  const order = Array.isArray(f.optionOrder) ? f.optionOrder : [];
  const rank = (v: string) => { const i = order.indexOf(v); return i < 0 ? order.length + all.indexOf(v) : i; };
  const values = order.length ? [...all].sort((a, b) => rank(a) - rank(b)) : all;
  const labelOf = (v: string) => { const l = f.optionLabels?.[v]; return typeof l === "string" && l.trim() ? l.trim() : defaultOptionLabel(v); };
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
    multiple,
    enumValues: [...(f.enum ?? [])],
    ...(target && "tag" in target ? { target: target.tag } : {}),
    ...(target && "pathPrefix" in target ? { targetPath: target.pathPrefix } : {}),
    ...(target && !hinted ? { targetInferred: true } : {}),
    ...(f.reverseLabel ? { reverseLabel: f.reverseLabel } : {}),
  };
}

/**
 * The keys a page with these tags shows at the top: each tag's `pinned` list, in tag
 * order, a key once. Empty = no tag pins anything (the page lists every filled property).
 */
export function pinnedKeys(tags: string[], schemas: SchemaMap): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const list = Object.prototype.hasOwnProperty.call(schemas, t) ? schemas[t]?.pinned : undefined;
    if (!Array.isArray(list)) continue;
    for (const k of list) if (typeof k === "string" && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Split a page's properties into the pinned ones (in pinned order) and the rest (in their own order). */
export function splitPinned(props: PropertyDef[], pinned: string[]): { top: PropertyDef[]; rest: PropertyDef[] } {
  const top: PropertyDef[] = [];
  for (const k of pinned) {
    const p = props.find((d) => d.key === k);
    if (p) top.push(p);
  }
  return { top, rest: props.filter((p) => !top.includes(p)) };
}

/** Keys hidden everywhere for a page with these tags: deleted by one of them and declared LIVE by none. */
export function deletedKeys(tags: string[], schemas: SchemaMap): Set<string> {
  const out = new Set<string>();
  const live = new Set<string>();
  for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) (f.deleted ? out : live).add(k);
  for (const k of live) out.delete(k);
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
  // A deleted property is hidden on every surface, value or not — but only as THAT tag's
  // property: another tag of the same page that declares the key live still shows it.
  const gone = deletedKeys(tags, schemas);
  const known = Object.keys(schemas);
  for (const tag of tags) {
    const s = schemas[tag];
    if (!s) continue;
    for (const [key, f] of Object.entries(s.fields)) {
      if (seen.has(key) || isSystemKey(key) || f.deleted) continue;
      if (f.hidden && isBlank(meta[key])) continue;
      seen.add(key);
      out.push(propertyFromField(key, f, tag, meta[key], known));
    }
  }
  for (const [key, value] of Object.entries(meta)) {
    if (gone.has(key)) continue;
    if (seen.has(key) || !isListableKey(key) || value === null || typeof value === "object" && !Array.isArray(value)) continue;
    seen.add(key);
    out.push(propertyFromField(key, {}, null, value, known));
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
  // A project note at `vault/projects/<slug>/PROJECT` is named by its folder, not "PROJECT".
  const parts = inner.split("/").filter(Boolean);
  const leaf = (parts.pop() ?? inner).replace(/\.[^.]+$/, "");
  return GENERIC_LEAF.test(leaf) && parts.length ? parts[parts.length - 1]! : leaf;
}
/** File names that name a FOLDER's note rather than themselves (PROJECT.md, index, README). */
export const GENERIC_LEAF = /^(project|index|readme)$/i;
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

/** "Oct 3" · "Oct 3, 9:30 AM" (a value with a time) · "Oct 3 → Oct 5" (a range). */
export function formatDate(v: string): string {
  const r = dateRange(v);
  if (r) return `${formatOneDate(r[0])} → ${formatOneDate(r[1])}`;
  return formatOneDate(v);
}
function formatOneDate(v: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(day ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) };
  return hasTime(v) ? d.toLocaleString(undefined, { ...date, hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, date);
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
  /** The tag must be NEW (no pages, no schema, nobody shares or publishes it) — the server enforces it (CSV → new database). */
  requireNew?: boolean;
  description?: string;
  /** New fields (type required) or additive edits to existing ones. */
  fields?: Record<string, { type?: VaultFieldType; enum?: string[]; description?: string; default?: unknown }>;
  /** Presentation hints per field (stored by the Prism Server, not the vault). */
  ui?: Record<string, FieldHints>;
  /** The tag's pinned properties, in order (replaces the list; `[]` clears it). Each must be a property of the tag. */
  pinned?: string[];
}

const recordOf = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Every `Object.prototype` property name (toString, valueOf, hasOwnProperty, constructor, __proto__, …) + `prototype`: never a field or option name. */
export const isPrototypeName = (k: string): boolean => k === "prototype" || k in Object.prototype;
const BANNED = { has: isPrototypeName };
/** A label as stored: no line breaks, no bidi controls (they could reorder or spoof surrounding UI text). */
export function cleanLabel(v: string): string {
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    out += c === 9 || c === 10 || c === 13 ? " " : ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
/**
 * Tags whose notes an integration owns (ingest): their schemas may gain fields and
 * hints, never a `default:`; their values are never removed in bulk; a CSV never
 * becomes a "new" database over one; date ranges are not offered on their fields.
 */
export const INGEST_TAGS: ReadonlySet<string> = new Set(["email", "meeting", "message-thread", "message-archive", "person", "transcript", "task", "clickup", "alert"]);
/** `metadata.source` values an ingester recognises its own notes by (mirrors the server's `INGEST_SOURCES`; a test pins them equal). */
export const INGEST_SOURCE_VALUES: ReadonlySet<string> = new Set(["clickup", "fireflies", "fathom", "proton-bridge", "github", "gmail", "matrix", "calendar", "notion"]);
/** Is this row kept in sync by an integration (calendar event, ClickUp task, any ingest tag or source)? */
export function integrationOwned(n: { tags?: string[] | null; metadata?: Record<string, unknown> | null }): boolean {
  const m = n.metadata ?? {};
  if (typeof m.calendarEventId === "string" && m.calendarEventId) return true;
  if (m.source_id !== undefined && m.source_id !== null && m.source_id !== "") return true;
  if (typeof m.source === "string" && INGEST_SOURCE_VALUES.has(m.source.trim().toLowerCase())) return true;
  return (n.tags ?? []).some((t) => t === "clickup" || t === "meeting" || t === "email" || t === "message-thread" || t === "message-archive" || t === "transcript");
}
const okText = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);

/** Validate an untrusted `PUT /api/schemas/:tag` body. Never throws. */
export function validateSchemaPatch(raw: unknown): { ok: true; patch: SchemaPatch } | { ok: false; error: string } {
  if (!recordOf(raw)) return { ok: false, error: "body must be an object" };
  const patch: SchemaPatch = {};
  if (raw.requireNew !== undefined) {
    if (typeof raw.requireNew !== "boolean") return { ok: false, error: "requireNew must be boolean" };
    if (raw.requireNew) patch.requireNew = true;
  }
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
      if (!FIELD_NAME.test(name) || BANNED.has(name) || isSystemKey(name)) return { ok: false, error: `invalid field name: ${name}` };
      if (!recordOf(h)) return { ok: false, error: `ui.${name} must be an object` };
      const out: FieldHints = {};
      if (h.kind !== undefined) {
        if (!(PROPERTY_KINDS as readonly string[]).includes(h.kind as string)) return { ok: false, error: `ui.${name}: unknown kind` };
        out.kind = h.kind as PropertyKind;
      }
      if (h.label !== undefined) {
        if (!okText(h.label, 80)) return { ok: false, error: `ui.${name}: label must be ≤80 chars` };
        out.label = cleanLabel(h.label as string);
      }
      if (h.hidden !== undefined) {
        if (typeof h.hidden !== "boolean") return { ok: false, error: `ui.${name}: hidden must be boolean` };
        out.hidden = h.hidden;
      }
      if (h.relationTag !== undefined) {
        if (!okText(h.relationTag, 128) || !(h.relationTag as string).trim()) return { ok: false, error: `ui.${name}: relationTag must be a tag name` };
        out.relationTag = (h.relationTag as string).trim();
      }
      if (h.relationTarget !== undefined) {
        const t = validRelationTarget(h.relationTarget);
        if (!t) return { ok: false, error: `ui.${name}: relationTarget must be {tag} or {pathPrefix}` };
        out.relationTarget = t;
      }
      if (h.multiple !== undefined) {
        if (typeof h.multiple !== "boolean") return { ok: false, error: `ui.${name}: multiple must be boolean` };
        out.multiple = h.multiple;
      }
      if (h.reverseLabel !== undefined) {
        if (!okText(h.reverseLabel, 80)) return { ok: false, error: `ui.${name}: reverseLabel must be ≤80 chars` };
        out.reverseLabel = cleanLabel(h.reverseLabel as string);
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
          const text = cleanLabel(l as string);
          if (text) out.optionLabels[opt] = text;
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
  if (raw.pinned !== undefined) {
    if (!Array.isArray(raw.pinned) || raw.pinned.length > MAX_PINNED) return { ok: false, error: `pinned must be a list of ≤${MAX_PINNED} property keys` };
    const keys: string[] = [];
    for (const k of raw.pinned) {
      if (typeof k !== "string" || !FIELD_NAME.test(k) || BANNED.has(k) || isSystemKey(k)) return { ok: false, error: "pinned: invalid property key" };
      if (keys.includes(k)) return { ok: false, error: `pinned: ${k} is listed twice` };
      keys.push(k);
    }
    patch.pinned = keys;
  }
  if (!patch.fields && !patch.ui && patch.description === undefined && patch.pinned === undefined) return { ok: false, error: "nothing to change" };
  for (const group of [patch.ui ?? {}] as Array<Record<string, FieldHints>>) {
    for (const [name, h] of Object.entries(group)) {
      for (const opt of [...Object.keys(h.colors ?? {}), ...(h.optionOrder ?? []), ...(h.hiddenOptions ?? []), ...Object.keys(h.statusGroups ?? {})]) {
        if (isPrototypeName(opt)) return { ok: false, error: `ui.${name}: invalid option name` };
      }
    }
  }
  for (const [name, f] of Object.entries(patch.fields ?? {})) if ((f.enum ?? []).some(isPrototypeName)) return { ok: false, error: `field ${name}: invalid option name` };
  return { ok: true, patch };
}

/**
 * An untrusted relation target, or null. A tag is a tag name; a folder is a
 * relative vault path ("vault/projects"): no leading slash, no `.`/`..` or empty
 * segments, no backslash or control characters, ≤ 200 characters.
 */
export function validRelationTarget(raw: unknown): RelationTarget | null {
  if (!recordOf(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return null;
  if (keys[0] === "tag") {
    const t = raw.tag;
    if (!okText(t, 128) || !(t as string).trim() || /[\r\n]/.test(t as string)) return null;
    return { tag: (t as string).trim().replace(/^#+/, "") };
  }
  if (keys[0] === "pathPrefix") {
    const p = raw.pathPrefix;
    if (!okText(p, 200)) return null;
    const v = (p as string).trim().replace(/\/+$/, "");
    if (!v || v.startsWith("/") || v.includes("\\")) return null;
    if (v.split("/").some((seg) => !seg.trim() || seg === "." || seg === "..")) return null;
    return { pathPrefix: v };
  }
  return null;
}

/** The metadata key a new property named `label` gets ("Due date" → `due_date`). */
export function keyFromLabel(label: string): string {
  const k = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return /^[a-z]/.test(k) ? k : `p_${k}`;
}

/** What the one-step "New property" form collects. */
export interface NewPropertyDraft {
  label: string;
  kind: PropertyKind;
  /** Select / status / multi-select: the options, in order (the typed text IS the stored value). */
  options?: Array<{ value: string; color?: OptionColor; group?: StatusGroup }>;
  /** Number: display format (absent = the default). */
  format?: NumberFormat;
  /** Relation / person: what it links to. */
  target?: RelationTarget | null;
  /** Relation / person: several pages (vault `array`) or one (vault `string`). */
  multiple?: boolean;
  /** Relation: the name the reverse side shows on target pages (tag targets only). */
  reverseLabel?: string;
  /** Date: store as the vault's own `date` type (one day; no time, no range). */
  dateOnly?: boolean;
}

/**
 * ONE schema write for a brand-new property (A): the vault field (additive, with
 * its enum for select/status) and every presentation hint in the same PUT, so a
 * property is created with its options, colours, groups, number format and relation
 * target — never "create, then edit". Never throws; validates what the form can't.
 */
export function buildNewPropertyPatch(d: NewPropertyDraft): { ok: true; key: string; patch: SchemaPatch } | { ok: false; error: string } {
  const label = cleanLabel(d.label ?? "");
  if (!label) return { ok: false, error: "Give the property a name." };
  if (label.length > 80) return { ok: false, error: "The name is too long." };
  const key = keyFromLabel(label);
  if (!FIELD_NAME.test(key) || isSystemKey(key) || isPrototypeName(key)) return { ok: false, error: "That name can’t be used for a property." };
  if (!(PROPERTY_KINDS as readonly string[]).includes(d.kind)) return { ok: false, error: "Choose a type." };
  const linkish = d.kind === "relation" || d.kind === "person";
  const type: VaultFieldType = linkish ? (d.multiple ? "array" : "string") : d.kind === "date" && d.dateOnly ? "date" : VAULT_TYPE_FOR_KIND[d.kind];
  const ui: FieldHints = { kind: d.kind, label };
  const field: NonNullable<SchemaPatch["fields"]>[string] = { type };
  if (d.kind === "select" || d.kind === "status" || d.kind === "multi_select") {
    const opts = (d.options ?? []).map((o) => ({ ...o, value: cleanLabel(o.value ?? "") })).filter((o) => o.value);
    const seen = new Set<string>();
    for (const o of opts) {
      if (o.value.length > 80) return { ok: false, error: `“${o.value.slice(0, 20)}…” is too long for an option.` };
      if (isPrototypeName(o.value)) return { ok: false, error: `“${o.value}” can’t be an option name.` };
      const k = o.value.toLowerCase();
      if (seen.has(k)) return { ok: false, error: `“${o.value}” is listed twice.` };
      seen.add(k);
    }
    if (opts.length > 100) return { ok: false, error: "A property can have at most 100 options." };
    if (opts.length) {
      // The vault validates `enum` on string fields only: multi-select options are hints.
      if (d.kind !== "multi_select") field.enum = opts.map((o) => o.value);
      ui.colors = Object.fromEntries(opts.map((o) => [o.value, o.color && (OPTION_COLORS as readonly string[]).includes(o.color) ? o.color : optionColor(o.value)]));
      if (opts.length > 1) ui.optionOrder = opts.map((o) => o.value);
      if (d.kind === "status") ui.statusGroups = Object.fromEntries(opts.map((o) => [o.value, o.group && (STATUS_GROUPS as readonly string[]).includes(o.group) ? o.group : statusGroupOf(o.value)]));
    }
  }
  if (d.kind === "number" && d.format && d.format !== "number" && (NUMBER_FORMATS as readonly string[]).includes(d.format)) ui.format = d.format;
  if (linkish) {
    const t = d.target ? validRelationTarget(d.target) : null;
    if (d.target && !t) return { ok: false, error: "That isn’t a tag or folder pages can link to." };
    if (t && "tag" in t) ui.relationTag = t.tag; // the older form: every client reads it
    else if (t) ui.relationTarget = t;
    ui.multiple = !!d.multiple;
    const rev = cleanLabel(d.reverseLabel ?? "");
    if (d.kind === "relation" && rev && t && "tag" in t) ui.reverseLabel = rev.slice(0, 80);
  }
  return { ok: true, key, patch: { fields: { [key]: field }, ui: { [key]: ui } } };
}

/** One row of the relation-target backfill report. */
export interface RelationTargetPlan {
  proposals: Array<{ tag: string; field: string; kind: "relation" | "person"; target: string }>;
  unresolved: Array<{ tag: string; field: string; kind: PropertyKind; reason: string }>;
  /** Fields that already state a target (left alone). */
  alreadySet: number;
}

/**
 * The backfill planner (C): for every property of every tag that reads as a
 * relation or person (by its kind or its name) and states no target, the target its
 * NAME gives it — or why there is none. Presentation only: the result is turned into
 * `relationTag` hints; no stored value is ever read or rewritten.
 */
export function planRelationTargets(schemas: SchemaMap, skipTag: (tag: string) => boolean = () => false): RelationTargetPlan {
  const known = Object.keys(schemas);
  const out: RelationTargetPlan = { proposals: [], unresolved: [], alreadySet: 0 };
  for (const tag of Object.keys(schemas).sort()) {
    if (skipTag(tag)) continue;
    for (const [field, f] of Object.entries(schemas[tag]?.fields ?? {})) {
      if (isSystemKey(field) || f.deleted) continue;
      const kind = inferKind(field, f);
      const nameSays = isRelationKeyName(field) || inferRelationTarget(field, known) !== null;
      if (kind !== "relation" && kind !== "person" && !nameSays) continue;
      if (f.kind && f.kind !== "relation" && f.kind !== "person") continue; // the owner chose another type
      if (f.type && !["string", "array", "reference"].includes(f.type)) continue;
      if (relationTargetOf(f)) { out.alreadySet++; continue; }
      const target = inferRelationTarget(field, known);
      const k: "relation" | "person" = kind === "person" || target === "person" ? "person" : "relation";
      if (target) out.proposals.push({ tag, field, kind: k, target });
      else out.unresolved.push({ tag, field, kind, reason: isRelationKeyName(field) ? "no tag matches this name" : "not a relation name" });
    }
  }
  return out;
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

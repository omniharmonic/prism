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
 * (a string, or string[] when the vault type is `array`).
 */

export const PROPERTY_KINDS = [
  "text", "number", "select", "multi_select", "status", "date", "person", "relation", "checkbox", "url",
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/** Vault 0.7 field types a property may be created with (no `object`). */
export const VAULT_FIELD_TYPES = ["string", "number", "integer", "boolean", "date", "array", "reference"] as const;
export type VaultFieldType = (typeof VAULT_FIELD_TYPES)[number];

export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
  text: "Text", number: "Number", select: "Select", multi_select: "Multi-select", status: "Status",
  date: "Date", person: "Person", relation: "Relation", checkbox: "Checkbox", url: "URL",
};

/** The vault type a new property of `kind` is created with. */
export const VAULT_TYPE_FOR_KIND: Record<PropertyKind, VaultFieldType> = {
  text: "string", number: "number", select: "string", multi_select: "array", status: "string",
  date: "string", person: "string", relation: "string", checkbox: "boolean", url: "string",
};

/** One field as `GET /api/schemas` returns it: vault def + Prism hints. */
export interface SchemaField {
  type?: string;
  enum?: string[];
  default?: unknown;
  description?: string;
  indexed?: boolean;
  kind?: PropertyKind;
  label?: string;
  colors?: Record<string, OptionColor>;
  hidden?: boolean;
}
export interface TagSchema {
  description: string | null;
  fields: Record<string, SchemaField>;
}
export type SchemaMap = Record<string, TagSchema>;

/** Hints a client may send in `PUT /api/schemas/:tag` (`ui`). */
export interface FieldHints {
  kind?: PropertyKind;
  label?: string;
  colors?: Record<string, OptionColor>;
  hidden?: boolean;
}

export interface PropertyOption {
  value: string;
  color: OptionColor;
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
}

// Metadata keys that are system state, never shown as properties.
export const SYSTEM_KEYS = new Set([
  "type", "prism_type", "sync", "title", "icon", "cover", "layout", "content_font",
]);
export const isSystemKey = (k: string): boolean =>
  SYSTEM_KEYS.has(k) || k.startsWith("prism_") || k.startsWith("gov_") || k.startsWith("_");

const PERSON_KEYS = /^(assigned|assignee|assignees|owner|owners|person|people|author|authors|lead|attendees|participants|collaborators|reviewer|reviewers|contact)$/i;
const RELATION_KEYS = /^(project|projects|parent|related|relates_to|organization|organizations|org|epic|area)$/i;
const URL_KEYS = /(^|_)(url|link|website|href)$/i;
const DATE_KEYS = /^(date|due|deadline|start|end|scheduled|completed|completed_at|due_date|start_date|end_date|first-met|last-contact|published)$/i;
const STATUS_KEYS = /^(status|state|stage|event_status)$/i;

/** Kind for a schema field (hints win, then vault type, then the key name). */
export function inferKind(key: string, f: SchemaField | undefined, sample?: unknown): PropertyKind {
  if (f?.kind && (PROPERTY_KINDS as readonly string[]).includes(f.kind)) return f.kind;
  const t = f?.type;
  if (t === "boolean") return "checkbox";
  if (t === "number" || t === "integer") return "number";
  if (t === "date") return "date";
  if (t === "reference") return "relation";
  if (t === "array") {
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
    if (Array.isArray(sample)) return sample.some((x) => typeof x === "string" && x.startsWith("[[")) ? (PERSON_KEYS.test(key) ? "person" : "relation") : "multi_select";
    if (typeof sample === "string") {
      if (sample.startsWith("[[")) return PERSON_KEYS.test(key) ? "person" : "relation";
      if (/^https?:\/\//i.test(sample)) return "url";
      if (/^\d{4}-\d{2}-\d{2}($|T)/.test(sample)) return "date";
    }
    return "text";
  }
  if (t === "string") {
    if (URL_KEYS.test(key)) return "url";
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
  const values = new Set<string>([...(f.enum ?? []), ...Object.keys(f.colors ?? {})]);
  return {
    key,
    label: f.label?.trim() || humanize(key),
    kind,
    options: [...values].map((v) => ({ value: v, color: optionColor(v, f.colors) })),
    tag,
    type: f.type,
    description: f.description,
    default: f.default,
    multiple: f.type === "array" || kind === "multi_select",
  };
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
  const inner = v.trim().replace(/^\[\[(.*)\]\]$/, "$1");
  const alias = inner.split("|")[1];
  if (alias) return alias.trim();
  return (inner.split("/").pop() ?? inner).replace(/\.[^.]+$/, "");
}
/** `[[path]]` → `path`; plain strings pass through. */
export const linkTarget = (v: string): string => v.trim().replace(/^\[\[(.*)\]\]$/, "$1").split("|")[0]!.trim();
export const asWikilink = (path: string): string => `[[${path}]]`;

/** Short human text for any property value (cells, cards, filters). */
export function formatValue(def: Pick<PropertyDef, "kind">, v: unknown): string {
  if (isBlank(v)) return "";
  if (def.kind === "checkbox") return v === true ? "Yes" : "No";
  if (Array.isArray(v)) return v.map((x) => formatValue(def, x)).filter(Boolean).join(", ");
  if (def.kind === "person" || def.kind === "relation") return typeof v === "string" ? linkLabel(v) : String(v);
  if (def.kind === "date" && typeof v === "string") return formatDate(v);
  if (def.kind === "number" && typeof v === "number") return v.toLocaleString();
  return String(v);
}

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

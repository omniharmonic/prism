/**
 * Idempotent vault tag-schema provisioning.
 *
 * Single source of truth: packages/core/src/lib/schemas/tag-schemas.json
 * (shape: { version, tags: { "<tag>": { description, contentType, precedence, fields } } }).
 * `contentType` / `precedence` are Prism-side renderer concerns and are NOT seeded —
 * the vault tag schema only stores `description` + `fields`.
 *
 * REST endpoints used (Parachute 0.5.x+, base `${vaultUrl}/vault/${vault}/api`):
 *   - GET  /tags?include_schema=true     → [{ name, count, description, fields, ... }]
 *   - PUT  /tags/:tag  { description, fields }  → upsert (server MERGES fields)
 *
 * Auth: vault 0.7.x (≥0.7.1) gates tag-schema writes behind `vault:<name>:admin`
 * — a `:write` token gets 403 `insufficient_scope`. Pass `adminToken` (e.g. from
 * `mintEphemeralAdminToken`) for the PUTs; reads keep using `token`. On 0.6.x
 * the write token suffices, so `adminToken` is optional. Failures surface as a
 * `SchemaWriteError` with an actionable message instead of a raw status dump.
 *
 * Safety contract (CRITICAL — never destructive):
 *   - absent tag            → create with description + fields
 *   - present tag           → ADD missing fields / fill an EMPTY description only;
 *                             NEVER overwrite an existing field def or a non-empty description
 *   - already complete      → unchanged (no write)
 *   - dryRun                → compute the plan, perform NO writes
 *
 * Although the server PUT merges, we still compute the merged body client-side so we
 * only write when something actually changes and the written body is fully determined.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the canonical tag-schemas.json (packages/core). */
export const TAG_SCHEMAS_PATH = resolve(
  __dirname,
  "../../../../packages/core/src/lib/schemas/tag-schemas.json",
);

export interface TagFieldDef {
  type?: string;
  description?: string;
  enum?: string[];
  indexed?: boolean;
  [k: string]: unknown;
}

export interface TagSchemaEntry {
  description?: string;
  contentType?: string;
  precedence?: number;
  fields?: Record<string, TagFieldDef>;
  [k: string]: unknown;
}

interface TagSchemasFile {
  version: number;
  tags: Record<string, TagSchemaEntry>;
}

/** Shape returned by GET /tags?include_schema=true */
interface VaultTag {
  name: string;
  count: number;
  description: string | null;
  fields: Record<string, TagFieldDef> | null;
  parent_names?: string[] | null;
}

/** The `parent_names` (is-a parents) declared for a tag, if any. */
function desiredParentNames(entry: TagSchemaEntry): string[] {
  const p = (entry as { parent_names?: unknown }).parent_names;
  return Array.isArray(p) ? p.map(String).filter(Boolean) : [];
}

export interface SeedOptions {
  vaultUrl: string;
  vault: string;
  token: string;
  /** `vault:<name>:admin` token for the schema PUTs (required on vault ≥0.7.1). */
  adminToken?: string;
  dryRun?: boolean;
  /** Optional override of the schema source (defaults to the canonical JSON). */
  schemas?: Record<string, TagSchemaEntry>;
  /** Optional progress logger. */
  log?: (msg: string) => void;
}

export interface SeedResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
  /** Per-tag detail of what changed (for updated/created). */
  details: Record<string, { addedFields: string[]; filledDescription: boolean }>;
  /**
   * Fields NOT declared on a tag because another tag already declares the same field name with
   * another type (vault ≥0.7.9 requires every declarer of a field to agree; it refuses the whole
   * PUT with 422 `tag_field_conflict` otherwise). The note's metadata can still carry the key;
   * only the declaration is left out. Fields whose `indexed` flag differed are declared with the
   * flag the vault already has (`adoptedIndexed`), not left out.
   */
  conflicts?: FieldConflict[];
  adoptedIndexed?: FieldConflict[];
  dryRun: boolean;
}

export interface FieldConflict {
  tag: string;
  field: string;
  /** The tag that declared the field first (in the vault, or earlier in this seed). */
  with: string;
  /** What this tag asked for vs what is declared. */
  wanted: { type?: string; indexed: boolean };
  declared: { type?: string; indexed: boolean };
}

/** Load the canonical tag-schema map from packages/core. */
export function loadCanonicalSchemas(): Record<string, TagSchemaEntry> {
  const raw = readFileSync(TAG_SCHEMAS_PATH, "utf8");
  const parsed = JSON.parse(raw) as TagSchemasFile;
  return parsed.tags;
}

/**
 * Vault 0.6.x builds a field index when a schema field carries `indexed: true`,
 * and the index build 500s for any non-string type — AFTER the schema row is
 * written. Vault 0.7.x instead rejects non-indexable types cleanly (400
 * `invalid_indexed_field`; indexable = string/integer/boolean/reference/date).
 * Fields WE declare are only sent `indexed` when they're strings (safe on
 * both); fields ECHOED back from the vault keep `indexed` for any type 0.7.x
 * can index (never un-index a real index) and lose it otherwise.
 */
const INDEXABLE_V07 = new Set(["string", "integer", "boolean", "reference", "date"]);
function stripIndexed(fields: Record<string, TagFieldDef>, keep: (type: string | undefined) => boolean): Record<string, TagFieldDef> {
  const out: Record<string, TagFieldDef> = {};
  for (const [name, def] of Object.entries(fields)) {
    const d = def as TagFieldDef & { indexed?: boolean; type?: string };
    if (d?.indexed && !keep(d.type)) {
      const { indexed: _drop, ...rest } = d;
      out[name] = rest as TagFieldDef;
    } else {
      out[name] = def;
    }
  }
  return out;
}
const indexableFields = (f: Record<string, TagFieldDef>) => stripIndexed(f, (t) => t === "string");
const echoableFields = (f: Record<string, TagFieldDef>) => stripIndexed(f, (t) => INDEXABLE_V07.has(t ?? ""));

/** A field declaration as the vault compares them across tags: its type and whether it is indexed. */
interface Declared {
  tag: string;
  type?: string;
  indexed: boolean;
}

/**
 * Vault ≥0.7.9 (`collectCrossTagFieldViolations`) refuses a tag schema whose field disagrees with
 * another tag's declaration of the same field name, in type or in the `indexed` flag — and it
 * refuses the WHOLE PUT. Prism's canonical schemas held such pairs until 2026-10-20 (e.g.
 * `confidence`, a label on `person` and a number on `species` — now `confidence_score`; the drift
 * test keeps the file consistent), and a person's own vault may hold others (a tag of their own,
 * or the old declarations in a vault seeded before the renames), so a fresh install's `schemas`
 * step failed (clean-VM run, 2026-10-20). This stays as the safety net. Rule, deterministic: the
 * vault's existing declarations win, then the earlier tag in the canonical file. A different
 * `indexed` flag is resolved by adopting the declared one; a different type leaves the field out
 * of this tag's schema (reported). Fields the tag already has in the vault are never touched.
 */
function reconcileFields(
  tag: string,
  wanted: Record<string, TagFieldDef>,
  declared: Map<string, Declared>,
  result: { conflicts: FieldConflict[]; adoptedIndexed: FieldConflict[] },
): Record<string, TagFieldDef> {
  const out: Record<string, TagFieldDef> = {};
  for (const [field, def] of Object.entries(wanted)) {
    const mine = { type: def.type, indexed: def.indexed === true };
    const other = declared.get(field);
    if (!other || other.tag === tag) {
      out[field] = def;
      declared.set(field, { tag, ...mine });
      continue;
    }
    const conflict: FieldConflict = { tag, field, with: other.tag, wanted: mine, declared: { type: other.type, indexed: other.indexed } };
    if (other.type !== mine.type) {
      result.conflicts.push(conflict);
      continue;
    }
    if (other.indexed !== mine.indexed) {
      result.adoptedIndexed.push(conflict);
      const { indexed: _drop, ...rest } = def;
      out[field] = other.indexed ? { ...rest, indexed: true } : (rest as TagFieldDef);
      continue;
    }
    out[field] = def;
  }
  return out;
}

/** A tag-schema request the vault refused, with an operator-actionable message. */
export class SchemaWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorType: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "SchemaWriteError";
  }
}

function describeFailure(opts: SeedOptions, method: string, path: string, status: number, body: unknown): string {
  const b = (body ?? {}) as { error_type?: string; error?: string; violations?: unknown; message?: string };
  const t = b.error_type ?? "";
  if (status === 403 && t === "insufficient_scope") {
    return (
      `schema writes need vault:${opts.vault}:admin (vault ≥0.7.1 refuses them with a :write token). ` +
      `Rerun with an admin token — e.g. PARACHUTE_ADMIN_TOKEN=$(parachute auth mint-token --scope vault:${opts.vault}:admin --ephemeral)`
    );
  }
  if (t === "tag_field_conflict" || t === "invalid_indexed_field" || t === "schema_validation") {
    const detail = b.violations ? ` ${JSON.stringify(b.violations)}` : b.error || b.message ? ` ${b.error ?? b.message}` : "";
    return `${method} ${path}: vault rejected the schema (${status} ${t}); nothing was written.${detail}`;
  }
  return `${method} ${path}: ${status} ${typeof body === "string" ? body : JSON.stringify(body)}`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function vaultFetch(opts: SeedOptions, path: string, init?: RequestInit): Promise<Response> {
  const base = `${opts.vaultUrl}/vault/${opts.vault}/api`;
  const method = init?.method ?? "GET";
  const token = method === "GET" ? opts.token : (opts.adminToken ?? opts.token);
  const resp = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    const errorType = (body as { error_type?: unknown })?.error_type;
    throw new SchemaWriteError(
      describeFailure(opts, method, path, resp.status, body),
      resp.status,
      typeof errorType === "string" ? errorType : null,
      body,
    );
  }
  return resp;
}

/**
 * Provision tag schemas idempotently. Safe to run repeatedly against a live vault.
 */
export async function seedTagSchemas(opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const desired = opts.schemas ?? loadCanonicalSchemas();

  // 1. Read existing schemas.
  const existingList = (await vaultFetch(opts, "/tags?include_schema=true").then((r) => r.json())) as VaultTag[];
  const existing = new Map<string, VaultTag>();
  for (const t of existingList) existing.set(t.name, t);

  const result: SeedResult & { conflicts: FieldConflict[]; adoptedIndexed: FieldConflict[] } = {
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    details: {},
    conflicts: [],
    adoptedIndexed: [],
    dryRun: !!opts.dryRun,
  };

  // Every field the vault already declares, by name (first declarer wins, as in the vault).
  const declared = new Map<string, Declared>();
  for (const t of existingList) {
    for (const [field, def] of Object.entries(echoableFields(t.fields ?? {}))) {
      if (!declared.has(field)) declared.set(field, { tag: t.name, type: def.type, indexed: def.indexed === true });
    }
  }

  for (const [tag, entry] of Object.entries(desired)) {
    const desiredDescription = isNonEmptyString(entry.description) ? entry.description.trim() : "";
    const desiredParents = desiredParentNames(entry);

    const cur = existing.get(tag);
    const own = new Set(Object.keys(cur?.fields ?? {}));
    const wanted = Object.fromEntries(Object.entries(indexableFields(entry.fields ?? {})).filter(([f]) => !own.has(f)));
    const desiredFields = reconcileFields(tag, wanted, declared, result);
    // "Has a schema" = the vault tag carries a description or any field definitions.
    const hasSchema = !!cur && (isNonEmptyString(cur.description) || (cur.fields && Object.keys(cur.fields).length > 0));

    if (!hasSchema) {
      // Absent (or bare tag with no schema) → create.
      const addedFields = Object.keys(desiredFields);
      const filledDescription = !!desiredDescription;
      if (!desiredDescription && addedFields.length === 0 && desiredParents.length === 0) {
        // Nothing to seed for this tag.
        result.unchanged.push(tag);
        continue;
      }
      result.created.push(tag);
      result.details[tag] = { addedFields, filledDescription };
      if (!opts.dryRun) {
        await vaultFetch(opts, `/tags/${encodeURIComponent(tag)}`, {
          method: "PUT",
          body: JSON.stringify({
            description: desiredDescription,
            fields: desiredFields,
            ...(desiredParents.length ? { parent_names: desiredParents } : {}),
          }),
        });
      }
      log(`${opts.dryRun ? "[dry-run] " : ""}create ${tag} (${addedFields.length} fields${filledDescription ? ", +description" : ""}${desiredParents.length ? `, parents=${desiredParents.join("/")}` : ""})`);
      continue;
    }

    // Present with a schema → compute additive merge only.
    const curFields = echoableFields(cur!.fields ?? {});
    const mergedFields: Record<string, TagFieldDef> = { ...curFields };
    const addedFields: string[] = [];
    for (const [fname, fdef] of Object.entries(desiredFields)) {
      if (!(fname in curFields)) {
        mergedFields[fname] = fdef;
        addedFields.push(fname);
      }
      // else: field already defined — NEVER overwrite.
    }

    const curDescription = isNonEmptyString(cur!.description) ? cur!.description! : "";
    const filledDescription = !curDescription && !!desiredDescription;
    const finalDescription = curDescription || desiredDescription;

    // parent_names are additive/non-destructive: only set them when the vault tag
    // has none yet (never clobber a curated hierarchy).
    const curParents = Array.isArray(cur!.parent_names) ? cur!.parent_names! : [];
    const addParents = curParents.length === 0 && desiredParents.length > 0;

    if (addedFields.length === 0 && !filledDescription && !addParents) {
      result.unchanged.push(tag);
      continue;
    }

    result.updated.push(tag);
    result.details[tag] = { addedFields, filledDescription };
    if (!opts.dryRun) {
      await vaultFetch(opts, `/tags/${encodeURIComponent(tag)}`, {
        method: "PUT",
        body: JSON.stringify({
          description: finalDescription,
          fields: mergedFields,
          ...(addParents ? { parent_names: desiredParents } : {}),
        }),
      });
    }
    log(
      `${opts.dryRun ? "[dry-run] " : ""}update ${tag} (+${addedFields.length} fields${filledDescription ? ", +description" : ""})`,
    );
  }

  return result;
}

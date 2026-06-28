/**
 * Idempotent vault tag-schema provisioning.
 *
 * Single source of truth: packages/core/src/lib/schemas/tag-schemas.json
 * (shape: { version, tags: { "<tag>": { description, contentType, precedence, fields } } }).
 * `contentType` / `precedence` are Prism-side renderer concerns and are NOT seeded —
 * the vault tag schema only stores `description` + `fields`.
 *
 * REST endpoints used (Parachute 0.5.x, base `${vaultUrl}/vault/${vault}/api`):
 *   - GET  /tags?include_schema=true     → [{ name, count, description, fields, ... }]
 *   - PUT  /tags/:tag  { description, fields }  → upsert (server MERGES fields)
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
}

export interface SeedOptions {
  vaultUrl: string;
  vault: string;
  token: string;
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
  dryRun: boolean;
}

/** Load the canonical tag-schema map from packages/core. */
export function loadCanonicalSchemas(): Record<string, TagSchemaEntry> {
  const raw = readFileSync(TAG_SCHEMAS_PATH, "utf8");
  const parsed = JSON.parse(raw) as TagSchemasFile;
  return parsed.tags;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

async function vaultFetch(opts: SeedOptions, path: string, init?: RequestInit): Promise<Response> {
  const base = `${opts.vaultUrl}/vault/${opts.vault}/api`;
  const resp = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path}: ${resp.status} ${body}`);
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

  const result: SeedResult = {
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
    details: {},
    dryRun: !!opts.dryRun,
  };

  for (const [tag, entry] of Object.entries(desired)) {
    const desiredDescription = isNonEmptyString(entry.description) ? entry.description.trim() : "";
    const desiredFields = entry.fields ?? {};

    const cur = existing.get(tag);
    // "Has a schema" = the vault tag carries a description or any field definitions.
    const hasSchema = !!cur && (isNonEmptyString(cur.description) || (cur.fields && Object.keys(cur.fields).length > 0));

    if (!hasSchema) {
      // Absent (or bare tag with no schema) → create.
      const addedFields = Object.keys(desiredFields);
      const filledDescription = !!desiredDescription;
      if (!desiredDescription && addedFields.length === 0) {
        // Nothing to seed for this tag.
        result.unchanged.push(tag);
        continue;
      }
      result.created.push(tag);
      result.details[tag] = { addedFields, filledDescription };
      if (!opts.dryRun) {
        await vaultFetch(opts, `/tags/${encodeURIComponent(tag)}`, {
          method: "PUT",
          body: JSON.stringify({ description: desiredDescription, fields: desiredFields }),
        });
      }
      log(`${opts.dryRun ? "[dry-run] " : ""}create ${tag} (${addedFields.length} fields${filledDescription ? ", +description" : ""})`);
      continue;
    }

    // Present with a schema → compute additive merge only.
    const curFields = cur!.fields ?? {};
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

    if (addedFields.length === 0 && !filledDescription) {
      result.unchanged.push(tag);
      continue;
    }

    result.updated.push(tag);
    result.details[tag] = { addedFields, filledDescription };
    if (!opts.dryRun) {
      await vaultFetch(opts, `/tags/${encodeURIComponent(tag)}`, {
        method: "PUT",
        body: JSON.stringify({ description: finalDescription, fields: mergedFields }),
      });
    }
    log(
      `${opts.dryRun ? "[dry-run] " : ""}update ${tag} (+${addedFields.length} fields${filledDescription ? ", +description" : ""})`,
    );
  }

  return result;
}

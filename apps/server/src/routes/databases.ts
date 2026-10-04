/**
 * Typed properties + database views — the server half (mounted into the gateway
 * BEFORE the owner short-circuit, so owners and non-owners both reach these
 * handlers instead of the vault passthrough / the non-owner 403 catch-all).
 *
 *   GET  /api/schemas[?tags=a,b]   tag → {description, fields{type,enum,default,
 *                                  description,indexed,kind,label,colors,hidden}}
 *   PUT  /api/schemas/:tag         owner-only additive schema edit (+ hints)
 *   POST /api/schemas/:tag/fields/:field/remove-values
 *                                  owner-only: clear a DELETED property's values (dry-run default)
 *   POST /api/query                lean filtered/sorted/paged rows for a view
 *   POST /api/properties/:id       metadata-only property write with per-field CAS
 *   POST /api/properties/batch     up to 100 of those, one result each (bulk edit)
 *   POST /api/databases/import/csv owner/admin CSV import (dry-run default, keyed)
 *
 * PERMISSIONS. Read gates use the same `view`-cap math as every other gateway
 * read (`effectiveCaps(...).has("view")`); writes need `edit` on the note. A
 * non-owner sees the schema of a tag only if they can view at least one note
 * carrying it (computed from the in-memory tree projection — no vault list) or
 * hold a grant naming it (they already know that name). Counts never leave.
 *
 * Vault cost. Lists are LEAN (no content; `include_metadata` = exactly the keys
 * a query reads), single-tag, bounded by `QUERY_SCAN_MAX`, and coalesced for a
 * few seconds so paging a view does not re-list the tag per page.
 *
 * Schema writes need `vault:<name>:admin`; the server mints a 1 h ephemeral admin
 * token per write (`mintEphemeralAdminToken`, the seeders' path) — never stored,
 * never returned. Presentation hints (kind/label/colours/hidden) are Prism-only
 * and live in the server's settings table per (vault, tag).
 */
import { ingestKeyChanged, INGEST_KEYS, INGEST_SOURCES } from "../ingest-keys";
import { grantsForResource } from "../db";
import { publishedTag } from "../pages";
import { recordAction } from "../actions/store";
import { Hono, type Context } from "hono";
import { canonicalTag } from "../tags";
import { protectionReason, systemNoteReason, SYSTEM_NOTE_TAGS } from "@prism/core/pages";
import { bodyLimit } from "hono/body-limit";
import { db, resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultConflictError, VaultError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, grantedTags, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { ensureTree, rowRef, treeUpsertNote } from "../tree";
import { docNameFor, isDocLive, isNoteId, markReconciled } from "../collab";
import { consumeRateLimit } from "../middleware/ratelimit";
import { mintEphemeralAdminToken } from "../mcp-token";
import { csrfRefusal } from "./actions";
import { resolveWriter, stampMetadata, stripIdentity, WRITER_AT_KEY, WRITER_KEY, writerNames } from "../writer-stamp";
import { CHANGE_KEY, creatorNameFor, stripWriterMeta } from "../sharing";
import {
  safeTitleLeaf,
  unwrapLink,
  coerceCsvValue,
  CsvError,
  CursorMismatchError,
  parseCsv,
  isFieldKey,
  isSystemKey,
  mergeSchemaFields,
  compatibleKinds,
  INGEST_TAGS,
  isPrototypeName,
  optionNameClash,
  PROPERTY_KIND_LABELS,
  metadataKeysFor,
  runQuery,
  validateQuerySpec,
  validateSchemaPatch,
  type FieldHints,
  type QueryInput,
  type SchemaField,
  type TagSchema,
} from "@prism/core/database";

import { assignedToMe, myIdentity, resetMyTasksForTests, type MyIdentity } from "../my-tasks";

export const databasesApi = new Hono();

// ── shared helpers ───────────────────────────────────────────────────────────

const ref = (n: Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null }): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});
const actorSubject = (a: Actor): string | null => (a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null);
const capsFor = (actor: Actor, note: NoteRef): Set<Cap> =>
  effectiveCaps(actor.grants, note, roleFloor(actor.role), actorSubject(actor));
const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
/** Same vault binding as `/tree`: admins choose with X-Prism-Vault; others are bound to their own. */
const entryFor = (c: Context, a: Actor): VaultEntry =>
  isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId);
const ACCESS_KEYS = new Set(["prism_creator", "prism_visibility"]);

function vaultFailure(c: Context, e: unknown) {
  if (e instanceof VaultError) {
    if (e.status === 404) return c.json({ error: "not_found" }, 404);
    if (e.status === 400 || e.status === 413 || e.status === 422) {
      const json = e.message.slice(e.message.indexOf("{"));
      let reason: string | undefined;
      try {
        const b = JSON.parse(json) as { error_type?: string; error?: string };
        reason = b.error_type ?? b.error;
      } catch {
        /* no structured body */
      }
      return c.json({ error: "vault_rejected", status: e.status, reason }, e.status);
    }
    return c.json({ error: "vault_error", status: e.status }, 502);
  }
  console.warn(`[databases] vault call failed: ${(e as Error).message}`);
  return c.json({ error: "vault_unreachable" }, 502);
}

// ── schemas ──────────────────────────────────────────────────────────────────

interface VaultTagRow {
  name?: string;
  tag?: string;
  description?: string | null;
  fields?: Record<string, SchemaField> | null;
}

const SCHEMA_TTL_MS = Number(process.env.SCHEMA_CACHE_TTL_MS ?? 30_000);
const schemaCache = new Map<string, { expires: number; value: Promise<Map<string, TagSchema>> }>();

async function vaultSchemas(entry: VaultEntry): Promise<Map<string, TagSchema>> {
  const hit = schemaCache.get(entry.id);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = (async () => {
    const resp = await fetch(`${entry.url}/vault/${entry.vault}/api/tags?include_schema=true`, {
      headers: { Authorization: `Bearer ${entry.token}` },
    });
    if (!resp.ok) throw new VaultError(resp.status, `GET /tags: ${resp.status} ${await resp.text().catch(() => "")}`);
    const rows = (await resp.json()) as VaultTagRow[];
    const out = new Map<string, TagSchema>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const name = r.name ?? r.tag;
      if (!name) continue;
      const fields = r.fields && typeof r.fields === "object" ? r.fields : {};
      if (!Object.keys(fields).length && !r.description) continue;
      out.set(name, { description: r.description ?? null, fields });
    }
    return out;
  })();
  schemaCache.set(entry.id, { expires: Date.now() + SCHEMA_TTL_MS, value });
  value.catch(() => schemaCache.delete(entry.id));
  return value;
}

/** Test-only: forget cached vault schemas + listings. */
export function resetDatabaseCachesForTests(): void {
  resetMyTasksForTests();
  schemaCache.clear();
  listCache.clear();
  listRows = 0;
}

const hintKey = (vaultId: string, tag: string) => `schema-ui:${vaultId}:${tag}`;
const selectHints = db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'");
const upsertHints = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
function readHints(vaultId: string): Map<string, Record<string, FieldHints>> {
  const prefix = `schema-ui:${vaultId}:`.replace(/[\\%_]/g, (m) => `\\${m}`);
  const out = new Map<string, Record<string, FieldHints>>();
  for (const row of selectHints.all(`${prefix}%`) as Array<{ key: string; value: string }>) {
    try {
      out.set(row.key.slice(`schema-ui:${vaultId}:`.length), JSON.parse(row.value) as Record<string, FieldHints>);
    } catch {
      /* a corrupt hint row only loses presentation */
    }
  }
  return out;
}

/** Vault def + hints, exactly what clients render. `count` never appears. */
function present(schema: TagSchema | undefined, hints: Record<string, FieldHints> | undefined): TagSchema {
  const fields: Record<string, SchemaField> = {};
  for (const [k, f] of Object.entries(schema?.fields ?? {})) {
    const { type, enum: en, default: def, description, indexed } = f;
    fields[k] = {
      ...(type !== undefined ? { type } : {}),
      ...(Array.isArray(en) ? { enum: en } : {}),
      ...(def !== undefined ? { default: def } : {}),
      ...(description ? { description } : {}),
      ...(indexed ? { indexed } : {}),
    };
  }
  for (const [k, h] of Object.entries(hints ?? {})) fields[k] = { ...(fields[k] ?? {}), ...h };
  return { description: schema?.description ?? null, fields };
}

/** Tags a non-owner may learn the schema of (see the module header). */
async function visibleTags(actor: Actor, entry: VaultEntry): Promise<Set<string>> {
  const tags = new Set<string>(grantedTags(actor.grants));
  const tree = await ensureTree(entry);
  for (const r of tree.rows()) {
    if (!r.tags.length || r.tags.every((t) => tags.has(t))) continue;
    if (capsFor(actor, rowRef(r)).has("view")) for (const t of r.tags) tags.add(t);
  }
  return tags;
}

databasesApi.get("/schemas", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const entry = entryFor(c, actor);
  const wanted = (c.req.query("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (wanted.length > 100 || wanted.some((t) => t.length > 128)) return c.json({ error: "bad_request" }, 400);
  let schemas: Map<string, TagSchema>;
  let allowed: Set<string> | null;
  try {
    schemas = await vaultSchemas(entry);
    allowed = isAdmin(actor) ? null : await visibleTags(actor, entry);
  } catch (e) {
    return vaultFailure(c, e);
  }
  const hints = readHints(entry.id);
  const names = new Set<string>([...schemas.keys(), ...hints.keys()]);
  const out: Record<string, TagSchema> = {};
  for (const name of names) {
    if (wanted.length && !wanted.includes(name)) continue;
    if (allowed && !allowed.has(name)) continue;
    out[name] = present(schemas.get(name), hints.get(name));
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ schemas: out, canEdit: actor.kind === "user" && actor.role === "owner" });
});

/** Injectable admin-token source (tests). Production: the seeders' ephemeral mint. */
let mintAdmin: (vaultName: string) => Promise<string> = mintEphemeralAdminToken;
export function setSchemaAdminMinter(fn: ((vaultName: string) => Promise<string>) | null): void {
  mintAdmin = fn ?? mintEphemeralAdminToken;
}

/** Vault 0.7 refuses `indexed` on non-indexable types; never echo it there. */
const INDEXABLE = new Set(["string", "integer", "boolean", "reference", "date"]);
const echoable = (fields: Record<string, SchemaField>): Record<string, SchemaField> => {
  const out: Record<string, SchemaField> = {};
  for (const [k, f] of Object.entries(fields)) {
    const { kind: _k, label: _l, colors: _c, hidden: _h, ...vaultDef } = f;
    if (vaultDef.indexed && !INDEXABLE.has(vaultDef.type ?? "")) delete vaultDef.indexed;
    out[k] = vaultDef;
  }
  return out;
};

/**
 * System/ingest tags (review L6). Governance + skill notes are read by code that
 * signs or schedules them: no schema edits at all. Ingest-owned tags may gain
 * fields/hints, but never a `default:` (the vault would stamp it into notes the
 * ingesters own).
 */
const LOCKED_TAG = (t: string) => t === "prism-trashed" || (SYSTEM_NOTE_TAGS as readonly string[]).includes(t) || t.startsWith("governance-");
const own = <T,>(o: Record<string, T> | null | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * Why `tag` cannot start a NEW database (CSV → new database), or null. A tag
 * with pages or a schema already is someone's database; a tag a grant names or
 * a site publishes would hand the imported pages to those audiences.
 */
async function newTagRefusal(entry: VaultEntry, tag: string): Promise<{ status: 403 | 409; error: string; detail: string } | null> {
  if (LOCKED_TAG(tag)) return { status: 403, error: "forbidden", detail: "this tag is managed by Prism" };
  if (INGEST_TAGS.has(tag)) return { status: 409, error: "tag_in_use", detail: `#${tag} belongs to an integration` };
  if (grantsForResource("tag", tag, entry.id).length > 0 || publishedTag(entry.id, tag)) return { status: 409, error: "tag_governed", detail: `#${tag} is shared or published, so new pages with it would be visible to other people` };
  const schema = (await vaultSchemas(entry)).get(tag);
  if (Object.keys(schema?.fields ?? {}).length || Object.keys(readHints(entry.id).get(tag) ?? {}).length) return { status: 409, error: "tag_in_use", detail: `#${tag} already has properties` };
  const any = await vaultClient(entry.id).listNotes({ tags: [tag], includeMetadata: [], limit: 1 });
  if (any.length) return { status: 409, error: "tag_in_use", detail: `#${tag} is already used by pages` };
  return null;
}
const perOwner = (c: Context, name: string, email: string, max: number) => {
  const wait = consumeRateLimit(`${name}:${email}`, max, 60_000);
  if (wait === null) return null;
  c.header("Retry-After", String(wait));
  return c.json({ error: "rate_limited", retryAfter: wait }, 429);
};

databasesApi.get("/schemas/:tag/availability", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden" }, 403);
  const limited = perOwner(c, "schema-write", actor.email, envInt("SCHEMA_WRITES_PER_MINUTE", 120));
  if (limited) return limited;
  const tag = canonicalTag(c.req.param("tag") ?? "");
  if (!tag || tag.length > 128 || /[\u0000-\u001f]/.test(tag)) return c.json({ error: "bad_request", detail: "invalid tag" }, 400);
  let refusal;
  try {
    refusal = await newTagRefusal(entryFor(c, actor), tag);
  } catch (e) {
    return vaultFailure(c, e);
  }
  c.header("Cache-Control", "private, no-store");
  return c.json(refusal ? { tag, available: false, reason: refusal.error, detail: refusal.detail } : { tag, available: true });
});
const JS_TYPE_OK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  date: (v) => typeof v === "string",
  reference: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
};
/** One read-merge-write at a time per (vault, tag): two concurrent additive edits must not drop each other. */
const schemaLocks = new Map<string, Promise<unknown>>();
async function withSchemaLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = schemaLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  schemaLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (schemaLocks.get(key) === run) schemaLocks.delete(key);
  }
}

databasesApi.put("/schemas/:tag", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden", reason: "changing a schema is owner-only" }, 403);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const limited = perOwner(c, "schema-write", actor.email, envInt("SCHEMA_WRITES_PER_MINUTE", 120));
  if (limited) return limited;
  const tag = canonicalTag(c.req.param("tag") ?? "");
  if (!tag || tag.length > 128 || /[\u0000-\u001f]/.test(tag)) return c.json({ error: "bad_request", detail: "invalid tag" }, 400);
  const parsed = validateSchemaPatch(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  const { patch } = parsed;
  const entry = entryFor(c, actor);
  if (LOCKED_TAG(tag)) return c.json({ error: "forbidden", reason: "this tag's schema is managed by Prism" }, 403);
  if (INGEST_TAGS.has(tag) && Object.values(patch.fields ?? {}).some((f) => f.default !== undefined)) {
    return c.json({ error: "protected_tag", detail: "ingested tags cannot gain a default value" }, 409);
  }
  return withSchemaLock(`${entry.id}\u0000${tag}`, () => applySchemaPatch(c, entry, tag, patch));
});

async function applySchemaPatch(c: Context, entry: VaultEntry, tag: string, patch: import("@prism/core/database").SchemaPatch) {
  let current: TagSchema | undefined;
  try {
    schemaCache.delete(entry.id); // decide against the vault's CURRENT schema
    current = (await vaultSchemas(entry)).get(tag);
  } catch (e) {
    return vaultFailure(c, e);
  }
  if (patch.requireNew) {
    let refusal;
    try {
      refusal = await newTagRefusal(entry, tag);
    } catch (e) {
      return vaultFailure(c, e);
    }
    if (refusal) return c.json({ error: refusal.error, detail: refusal.detail }, refusal.status);
  }
  const merged = mergeSchemaFields(current?.fields ?? {}, patch.fields ?? {});
  if (!merged.ok) return c.json({ error: "not_additive", detail: merged.error, field: merged.field }, 409);
  // A NEW field whose name existing notes already use with a different value type
  // would make those notes fail schema validation on their next write.
  const added = Object.entries(patch.fields ?? {}).filter(([k, f]) => !current?.fields[k] && f.type);
  if (added.length) {
    let sample: Note[];
    try {
      sample = await vaultClient(entry.id).listNotes({ tags: [tag], includeMetadata: added.map(([k]) => k), limit: 2000 });
    } catch (e) {
      return vaultFailure(c, e);
    }
    for (const [k, f] of added) {
      const ok = JS_TYPE_OK[f.type!] ?? (() => true);
      if (sample.some((n) => n.metadata?.[k] !== undefined && n.metadata?.[k] !== null && !ok(n.metadata[k]))) {
        return c.json({ error: "type_conflict", detail: `existing pages already use “${k}” with a different kind of value`, field: k }, 409);
      }
    }
  }
  // Presentation only (NP-DB-11): a `kind` hint must be a presentation of the field's
  // VAULT type. Anything else would be a vault type change, which is never made here.
  // The kind in force is this request's, else the one stored earlier — so a hint saved
  // for a free key is checked again when the field is declared with a type later.
  const storedHints = readHints(entry.id).get(tag) ?? {};
  for (const k of new Set([...Object.keys(patch.ui ?? {}), ...Object.keys(patch.fields ?? {})])) {
    const vaultType = own(merged.fields, k)?.type;
    const kind = own(patch.ui, k)?.kind ?? own(storedHints, k)?.kind;
    if (kind && vaultType !== undefined && !compatibleKinds(vaultType).includes(kind)) {
      return c.json({
        error: "incompatible_kind", field: k,
        detail: `“${k}” is stored as ${vaultType} for every page with this tag, so it cannot be shown as ${PROPERTY_KIND_LABELS[kind]}. Stored values are never converted; choose a matching type or add a new property instead.`,
      }, 409);
    }
  }
  // An option's display name may not read as another option (its value or its name).
  for (const [k, h] of Object.entries(patch.ui ?? {})) {
    if (!h.optionLabels) continue;
    const values = [...new Set([...(own(merged.fields, k)?.enum ?? []), ...Object.keys(own(storedHints, k)?.colors ?? {}), ...Object.keys(h.colors ?? {})])];
    const clash = optionNameClash(values, h.optionLabels);
    if (clash) return c.json({ error: "option_name_taken", field: k, detail: `Another option is already called “${clash}”.` }, 409);
  }
  // Deleting an option (hide it) is refused while any page still holds it.
  for (const [k, h] of Object.entries(patch.ui ?? {})) {
    const fresh = (h.hiddenOptions ?? []).filter((o) => !(own(storedHints, k)?.hiddenOptions ?? []).includes(o));
    if (!fresh.length) continue;
    let rows: Note[];
    try {
      rows = await vaultClient(entry.id).listNotes({ tags: [tag], includeMetadata: [k], limit: RAW_MAX });
    } catch (e) {
      return vaultFailure(c, e);
    }
    if (rows.length >= RAW_MAX) return c.json({ error: "option_in_use", field: k, detail: "this tag has too many pages to verify that the option is unused" }, 409);
    for (const o of fresh) {
      const count = rows.filter((n) => !(n.tags ?? []).includes("prism-trashed") && holdsOption(n.metadata?.[k], o)).length;
      if (count) return c.json({ error: "option_in_use", field: k, option: o, count, detail: `${count} ${count === 1 ? "page still uses" : "pages still use"} “${o}”. Change ${count === 1 ? "it" : "them"} first.` }, 409);
    }
  }
  const description = patch.description ?? current?.description ?? "";
  const vaultChange = merged.changed || (patch.description !== undefined && patch.description !== (current?.description ?? ""));

  if (vaultChange) {
    let token: string;
    try {
      token = await mintAdmin(entry.vault);
    } catch {
      return c.json({ error: "schema_admin_unavailable", detail: "the server could not obtain an admin token for this vault" }, 503);
    }
    const resp = await fetch(`${entry.url}/vault/${entry.vault}/api/tags/${encodeURIComponent(tag)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description, fields: echoable(merged.fields) }),
    }).catch((e: unknown) => e as Error);
    if (resp instanceof Error) return vaultFailure(c, resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 403) return c.json({ error: "schema_admin_unavailable", detail: "the vault refused the admin token" }, 503);
      return vaultFailure(c, new VaultError(resp.status, `PUT /tags/${tag}: ${resp.status} ${text}`));
    }
  }
  if (patch.ui) {
    const all = readHints(entry.id).get(tag) ?? {};
    for (const [field, h] of Object.entries(patch.ui)) {
      const next: FieldHints = { ...(all[field] ?? {}), ...h };
      if (h.colors) next.colors = { ...(all[field]?.colors ?? {}), ...h.colors };
      all[field] = next;
    }
    upsertHints.run(hintKey(entry.id, tag), JSON.stringify(all));
  }
  schemaCache.delete(entry.id);
  const fresh = vaultChange ? { description: description || null, fields: merged.fields } : current;
  return c.json({ tag, schema: present(fresh, readHints(entry.id).get(tag)) });
}

const holdsOption = (v: unknown, option: string): boolean => (Array.isArray(v) ? v.some((x) => String(x) === option) : typeof v === "string" && v === option);

// ── removing a deleted property's values (NP-DB-11 "delete with explicit data handling") ──

const REMOVE_DEFAULT = 500;
const REMOVE_MAX = 2000;
const REMOVE_CONCURRENCY = 2;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** ONE removal run at a time for the whole server (it is a burst of vault writes). */
let removeRunning = false;

/**
 * Clear `metadata[field]` on the pages of `tag`. The vault tag schema is never
 * touched (it is shared and additive-only); this is the only place Prism deletes
 * property DATA, so it is deliberately narrow:
 *   - server-owner role only, CSRF-guarded, dry-run unless `dryRun: false`;
 *   - a write needs the property already marked deleted (hidden everywhere) — a
 *     visible property's values are never removed (a dry run may preview first);
 *   - never for Prism-managed or ingest-owned tags, system/ingest keys, system
 *     notes, trashed pages, or a page that also carries ANOTHER tag whose schema
 *     declares the same key (that tag's property would lose its value);
 *   - never a page an integration owns (protected place/tag, any ingest tag, an
 *     ingest `source`) nor someone else's PRIVATE page — both skipped and counted;
 *   - one CAS write per page (`if_updated_at`; a page that moved is a conflict,
 *     never retried blindly, never forced), ≤ `limit` pages and ~20 s per request
 *     (`more: true` → the client asks again), one run at a time server-wide,
 *     rate limited per owner.
 */
databasesApi.post("/schemas/:tag/fields/:field/remove-values", bodyLimit({ maxSize: 4096 }), async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden", reason: "removing a property's values is owner-only" }, 403);
  const via = requestVia(c);
  const csrf = csrfRefusal(c, via);
  if (csrf) return csrf;
  // A person at a signed-in browser or device — never an agent credential (MCP, loopback token).
  if (via !== "session" && via !== "device") return c.json({ error: "agent_origin_refused", detail: "removing values needs a signed-in person" }, 403);
  const tag = canonicalTag(c.req.param("tag") ?? "");
  const field = c.req.param("field") ?? "";
  if (!tag || tag.length > 128 || /[\u0000-\u001f]/.test(tag)) return c.json({ error: "bad_request", detail: "invalid tag" }, 400);
  if (!FIELD_NAME.test(field) || isPrototypeName(field) || isSystemKey(field) || INGEST_KEYS.has(field) || field === "source") return c.json({ error: "bad_request", detail: "not a removable property" }, 400);
  const limited = perOwner(c, "schema-remove", actor.email, envInt("SCHEMA_REMOVE_PER_MINUTE", 30));
  if (limited) return limited;
  const body = (await c.req.json().catch(() => null)) as { dryRun?: unknown; limit?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "bad_request" }, 400);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return c.json({ error: "bad_request", detail: "dryRun must be boolean" }, 400);
  const dryRun = body.dryRun !== false;
  const limit = body.limit === undefined ? REMOVE_DEFAULT : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > REMOVE_MAX) return c.json({ error: "bad_request", detail: `limit must be 1–${REMOVE_MAX}` }, 400);
  if (LOCKED_TAG(tag)) return c.json({ error: "forbidden", reason: "this tag's schema is managed by Prism" }, 403);
  if (INGEST_TAGS.has(tag)) return c.json({ error: "protected_tag", detail: "values of an ingested tag are never removed in bulk" }, 409);
  const entry = entryFor(c, actor);
  // A dry run may preview the count before the property is deleted; a WRITE needs it deleted first.
  const hints = readHints(entry.id);
  if (!dryRun && own(hints.get(tag), field)?.deleted !== true) return c.json({ error: "not_deleted", detail: "delete (hide) the property first; a visible property's values are never removed" }, 409);

  let schemas: Map<string, TagSchema>;
  let rows: Note[];
  try {
    schemas = await vaultSchemas(entry);
    rows = await vaultClient(entry.id).listNotes({ tags: [tag], includeMetadata: [field, "prism_creator", "prism_visibility", "source"], limit: RAW_MAX });
  } catch (e) {
    return vaultFailure(c, e);
  }
  const holding = rows.filter((n) => { const v = own(n.metadata, field); return v !== undefined && v !== null; });
  // Another tag on the same page declaring this key — in its vault schema OR only in
  // its Prism hints — owns the value too: leave it.
  const sharedBy = (n: Note) => (n.tags ?? []).some((t) => t !== tag && (own(schemas.get(t)?.fields, field) !== undefined || own(hints.get(t), field) !== undefined));
  // A page an integration keeps in sync (by place, by tag, or by its `source`): its
  // metadata is the ingester's, whatever other tag it also carries.
  const ingestOwned = (n: Note) => protectionReason(n) !== null || (n.tags ?? []).some((t) => INGEST_TAGS.has(t)) ||
    (typeof n.metadata?.source === "string" && INGEST_SOURCES.has(n.metadata.source.trim().toLowerCase()));
  const othersPrivate = (n: Note) => n.metadata?.prism_visibility === "private" && String(n.metadata?.prism_creator ?? "").toLowerCase() !== actor.email.toLowerCase();
  const skipped = { trashed: 0, shared: 0, system: 0, ingest: 0, private: 0 };
  const targets: Note[] = [];
  for (const n of holding) {
    if ((n.tags ?? []).includes("prism-trashed")) skipped.trashed++;
    else if (systemNoteReason(n)) skipped.system++;
    else if (ingestOwned(n)) skipped.ingest++;
    else if (othersPrivate(n)) skipped.private++;
    else if (sharedBy(n)) skipped.shared++;
    else targets.push(n);
  }
  const base = { tag, field, total: targets.length, skipped, truncated: rows.length >= RAW_MAX };
  c.header("Cache-Control", "private, no-store");
  if (dryRun) return c.json({ dryRun: true, ...base });

  if (removeRunning) return c.json({ error: "busy", detail: "property values are already being removed; try again when that finishes" }, 409);
  removeRunning = true;
  const out = { removed: 0, conflicts: 0, failed: 0 };
  // One request stays short: it stops at `limit` pages or the time budget, and says
  // `more` — the client asks again (each run re-lists, so nothing is done twice).
  const deadline = Date.now() + envInt("SCHEMA_REMOVE_BUDGET_MS", 20_000);
  let next = 0;
  try {
    const vc = vaultClient(entry.id);
    const batch = targets.slice(0, limit);
    const worker = async () => {
      for (;;) {
        if (Date.now() > deadline) return;
        const n = batch[next++];
        if (!n) return;
        if (!n.updatedAt) { out.conflicts++; continue; } // no revision to compare against: never forced
        try {
          const updated = await vc.updateNote(n.id, { metadata: { [field]: null }, ifUpdatedAt: n.updatedAt });
          if (isDocLive(entry.id, n.id)) {
            const prev = Date.parse(n.updatedAt);
            const after = Date.parse(updated.updatedAt ?? "");
            if (Number.isFinite(prev) && Number.isFinite(after)) markReconciled(docNameFor(entry.id, n.id), prev, after);
          }
          treeUpsertNote(entry, updated);
          out.removed++;
        } catch (e) {
          if (e instanceof VaultConflictError) out.conflicts++;
          else out.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: REMOVE_CONCURRENCY }, worker));
  } finally {
    removeRunning = false;
    evictVaultListings(entry);
  }
  const attempted = Math.min(next, targets.length, limit);
  // Counts and names only — never a value.
  recordAction({
    actorEmail: actor.email, via, origin: "human", action: "schema.remove-values", vaultId: entry.id,
    target: { tag, field, ...out, total: targets.length }, status: out.failed ? "failed" : "ok",
  });
  return c.json({ dryRun: false, ...base, ...out, remaining: Math.max(0, targets.length - out.removed), more: targets.length > attempted });
});

// ── query ────────────────────────────────────────────────────────────────────

// Read per call so an operator (and tests) can tune without a restart.
const envInt = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
/** Rows evaluated per query (after permission filtering, review M2). */
const scanMax = () => envInt("QUERY_SCAN_MAX", 20_000);
/** Hard cap on one vault listing (the gateway's own list cap). */
const RAW_MAX = 50_000;
const LIST_TTL_MS = Number(process.env.QUERY_LIST_TTL_MS ?? 4_000);
const PERMISSION_KEYS = ["prism_creator", "prism_visibility"];
// `source` / `source_id` / `calendarEventId` say an integration owns the row (the calendar view will not drag it).
const ROW_META = ["title", "type", "prism_type", "icon", "cover", "coverY", WRITER_KEY, WRITER_AT_KEY, "source", "source_id", "calendarEventId"];

/**
 * Listing cache (review H1): ONE canonical listing per (vault, tag) — the tag's
 * schema keys + row/permission keys, or whole metadata for a tag with no schema —
 * so `fields` only shapes the response and can never force a fresh vault list.
 * LRU-bounded by entries AND total rows.
 */
interface ListEntry { expires: number; value: Promise<Note[]>; rows: number }
const listCache = new Map<string, ListEntry>();
let listRows = 0;
let limits: { entries: number; rows: number } | null = null;
const cacheLimits = () => limits ?? { entries: envInt("QUERY_CACHE_MAX_ENTRIES", 24), rows: envInt("QUERY_CACHE_MAX_ROWS", 150_000) };
export function setQueryCacheLimitsForTests(l: { entries: number; rows: number } | null): void {
  limits = l;
}
function evictListing(k: string) {
  const e = listCache.get(k);
  if (!e) return;
  listRows -= e.rows;
  listCache.delete(k);
}

async function canonicalListing(entry: VaultEntry, tag: string): Promise<Note[]> {
  const k = `${entry.id}\u0000${tag}`;
  const hit = listCache.get(k);
  if (hit && hit.expires > Date.now()) {
    listCache.delete(k); // LRU touch
    listCache.set(k, hit);
    return hit.value;
  }
  if (hit) evictListing(k);
  const schema = (await vaultSchemas(entry)).get(tag);
  const schemaKeys = Object.keys(schema?.fields ?? {});
  // + the assignee spellings "assigned to me" reads (my-tasks.ts); `assigned` is in the task schema.
  const keys = schemaKeys.length ? [...new Set([...schemaKeys, ...ROW_META, ...PERMISSION_KEYS, "assigned", "assignee", "assigneeEmail", "assignee_email"])] : undefined;
  const value = vaultClient(entry.id).listNotes({ tags: [tag], includeContent: false, includeMetadata: keys, orderBy: "updated_at", limit: RAW_MAX });
  const e: ListEntry = { expires: Date.now() + LIST_TTL_MS, value, rows: 0 };
  listCache.set(k, e);
  value.then((notes) => {
    if (listCache.get(k) !== e) return;
    e.rows = notes.length;
    listRows += notes.length;
    const { entries, rows } = cacheLimits();
    for (const key of listCache.keys()) {
      if (listCache.size <= entries && listRows <= rows) break;
      if (key !== k) evictListing(key);
    }
  }, () => { if (listCache.get(k) === e) listCache.delete(k); });
  const { entries } = cacheLimits();
  for (const key of listCache.keys()) {
    if (listCache.size <= entries) break;
    if (key !== k) evictListing(key);
  }
  return value;
}

databasesApi.post("/query", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const owner = isAdmin(actor);
  const who = actor.kind === "user" ? `u:${actor.email}` : actor.kind === "link" ? `l:${actor.capabilityId}` : "anon";
  const wait = consumeRateLimit(`db-query:${who}`, envInt("QUERY_RATE_PER_MINUTE", owner ? 600 : 120), 60_000);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }
  const parsed = validateQuerySpec(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  const spec = parsed.spec;
  const entry = entryFor(c, actor);
  const empty = () => c.json({ rows: [], next: null, total: 0, limited: true, truncated: false });
  // Non-admins may only list tags they can already see (memory-only check) —
  // anything else is an empty answer that costs the vault nothing.
  if (!owner) {
    let seen: Set<string>;
    try {
      seen = await visibleTags(actor, entry);
    } catch (e) {
      return vaultFailure(c, e);
    }
    if (!spec.tags.every((t) => seen.has(t))) return empty();
  }
  let notes: Note[];
  try {
    notes = await canonicalListing(entry, spec.tags[0]!);
  } catch (e) {
    return vaultFailure(c, e);
  }
  // "Assigned to me" (wave 3): the caller's own identity narrows the rows. A link
  // has no account, so it has no tasks. Only ever removes rows the caller could see.
  let mine: MyIdentity | null = null;
  let ownerUnset = false;
  if (spec.assignedToMe) {
    if (actor.kind !== "user") return empty();
    mine = await myIdentity(actor, entry);
    // The server owner with no owner identity set (review low 6): the previous
    // behaviour — every task — and `identity: "unset"` so the UI can say why.
    if (mine.ownerUnset) { ownerUnset = true; mine = null; }
  }
  const cap = scanMax();
  const stamp = actor.kind === "user" && !owner;
  const visible: QueryInput[] = [];
  // Trashed pages are not rows of any view (unless the view asks for the trash tag).
  const wantsTrash = spec.tags.includes("prism-trashed");
  // Who edited a row (writer-stamp.ts): a signed-in viewer sees a display name
  // (resolved BEFORE the engine, so it sorts/filters/searches by name); a
  // capability link sees no identity key at all — not even through a filter.
  // Emails are for owners/admins only (review M-A/M-B): everyone else gets a display
  // name or nothing — for the writer AND the creator — and never the raw change kind.
  const names = actor.kind === "user" ? writerNames(owner) : null;
  const present = (n: Note): Note => {
    const meta = n.metadata;
    if (!meta) return n;
    if (!names) return { ...n, metadata: stripIdentity(stripWriterMeta(meta)) };
    if (!owner && !(WRITER_KEY in meta) && !(WRITER_AT_KEY in meta) && !("prism_creator" in meta) && !(CHANGE_KEY in meta)) return n;
    if (owner && !(WRITER_KEY in meta) && !(WRITER_AT_KEY in meta)) return n;
    const { [WRITER_AT_KEY]: _at, [WRITER_KEY]: _w, ...rest } = meta;
    const who = resolveWriter(meta, n.updatedAt, names);
    const out: Record<string, unknown> = who ? { ...rest, [WRITER_KEY]: who } : rest;
    if (!owner) {
      delete out[CHANGE_KEY];
      if (typeof out.prism_creator === "string") {
        const creator = creatorNameFor(out.prism_creator);
        if (creator) out.prism_creator = creator;
        else delete out.prism_creator;
      }
    }
    return { ...n, metadata: out };
  };
  // Nor is a page TEMPLATE a row of a view that did not ask for templates (the engine
  // has the same rule; here it also keeps templates out of the scan cap).
  const wantsTemplates = spec.tags.includes("template");
  for (const n of notes) {
    if (!wantsTrash && (n.tags ?? []).includes("prism-trashed")) continue;
    if (!wantsTemplates && (n.tags ?? []).includes("template")) continue;
    if (mine && !assignedToMe(n.metadata, mine)) continue;
    if (owner) {
      visible.push({ ...present(n), canEdit: true });
      continue;
    }
    const caps = capsFor(actor, ref(n));
    if (!caps.has("view")) continue;
    visible.push({ ...present(n), canEdit: caps.has("edit"), ...(stamp ? { _caps: [...caps] } : {}) });
  }
  // The cut happens AFTER permission filtering (review M2) on a deterministic
  // updated_at-desc order, so a non-owner's "truncated" counts only rows they see.
  const truncated = visible.length > cap || (owner && notes.length >= RAW_MAX);
  try {
    const page = runQuery(visible.slice(0, cap), spec, { limited: !owner, truncated });
    // Whether a person page stands for the caller (else only their address matched).
    if (mine) page.identity = mine.person ? "person" : "account";
    else if (ownerUnset) page.identity = "unset";
    // Permission keys are read for the filter above, never returned unless asked for.
    for (const r of page.rows) for (const k of PERMISSION_KEYS) if (actor.kind === "link" || (spec.fields ? !spec.fields.includes(k) : !owner)) delete r.metadata[k];
    c.header("Cache-Control", "private, no-store");
    return c.json(page);
  } catch (e) {
    if (e instanceof CursorMismatchError) return c.json({ error: "bad_request", detail: e.message }, 400);
    throw e;
  }
});

// ── property writes ──────────────────────────────────────────────────────────

const MAX_PROPS = 20;
const MAX_VALUE_BYTES = 16_384;

function validValue(v: unknown): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= 10_000;
  if (Array.isArray(v)) return v.length <= 200 && v.every((x) => typeof x === "number" ? Number.isFinite(x) : typeof x === "string" && x.length <= 2_000);
  return false;
}
/** JSON equality on the stored shape; a missing key equals null. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Outcome of one property write (shared by the single and the batch route). */
type WriteOutcome =
  | { ok: true; id: string; updatedAt: string | null; metadata: Record<string, unknown> }
  | { ok: false; id: string; status: 400 | 403 | 404 | 409 | 423 | 502; error: string; reason?: string; fields?: string[]; current?: Record<string, unknown>; updatedAt?: string | null };

/** Validate a `{set, expect}` pair. Returns the error text, or the parsed write. */
function parseWrite(set: unknown, expect: unknown): { error: string } | { entries: Array<[string, unknown]>; expected: Array<[string, unknown]> } {
  if (!set || typeof set !== "object" || Array.isArray(set)) return { error: "set must be an object" };
  const entries = Object.entries(set as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_PROPS) return { error: `set 1–${MAX_PROPS} properties` };
  for (const [k, v] of entries) {
    if (!isFieldKey(k) || isSystemKey(k) && k !== "title" && k !== "icon") return { error: `not a property: ${k}` };
    if (!validValue(v) || JSON.stringify(v).length > MAX_VALUE_BYTES) return { error: `unsupported value for ${k}` };
  }
  if (expect !== undefined && (typeof expect !== "object" || expect === null || Array.isArray(expect))) return { error: "expect must be an object" };
  const expected = Object.entries((expect ?? {}) as Record<string, unknown>).filter(([k]) => Object.prototype.hasOwnProperty.call(set, k));
  return { entries, expected };
}

/**
 * One metadata-only property write: strict id, view → 404, edit → 403, lock → 423,
 * per-field CAS → 409, vault `if_updated_at` retried once, writer stamp,
 * `markReconciled` for a live doc. Leaves listing-cache eviction to the caller.
 */
async function writeProperties(actor: Actor, entry: VaultEntry, id: string, entries: Array<[string, unknown]>, expected: Array<[string, unknown]>): Promise<WriteOutcome> {
  const vc = vaultClient(entry.id);
  const patch = stampMetadata(Object.fromEntries(entries), actor)!;
  for (let attempt = 0; attempt < 2; attempt++) {
    let note: Note;
    try {
      note = await vc.getNote(id);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) return { ok: false, id, status: 404, error: "not_found" };
      return { ok: false, id, status: 502, error: "vault_error" };
    }
    if (note.id !== id) return { ok: false, id, status: 404, error: "not_found" };
    if (!isAdmin(actor)) {
      const caps = capsFor(actor, ref(note));
      if (!caps.has("view")) return { ok: false, id, status: 404, error: "not_found" };
      if (!caps.has("edit")) return { ok: false, id, status: 403, error: "forbidden", reason: "editing properties requires edit access" };
      if (entries.some(([k]) => ACCESS_KEYS.has(k))) return { ok: false, id, status: 403, error: "forbidden" };
      // Ingest / skill / merge matching keys are never set by hand (review M1) — same rule as the gateway PATCH.
      if (entries.some(([k, v]) => ingestKeyChanged(k, v, note.metadata?.[k]))) return { ok: false, id, status: 403, error: "forbidden", reason: "That property is set by an integration." };
      // True system notes (agent, alert, governance) are read-only for non-owners;
      // ingest notes (a ClickUp task's status, a meeting's fields) stay editable.
      if (systemNoteReason(note)) return { ok: false, id, status: 403, error: "forbidden", reason: "this is a system note" };
      // A locked page's properties are read-only too (pages lock, owner/admin bypass).
      if (note.metadata?.prism_locked === true) return { ok: false, id, status: 423, error: "locked", reason: "This page is locked." };
    }
    // A trashed page is not a row anywhere; it is restored, not edited.
    if ((note.tags ?? []).includes("prism-trashed")) return { ok: false, id, status: 404, error: "not_found" };
    // Per-field compare-and-set: a property someone else changed since the client
    // read it is a conflict; edits to OTHER fields (or the body) are not.
    const stale = expected.filter(([k, v]) => !same(note.metadata?.[k], v));
    if (stale.length) {
      return {
        ok: false, id, status: 409, error: "conflict",
        fields: stale.map(([k]) => k),
        current: Object.fromEntries(stale.map(([k]) => [k, note.metadata?.[k] ?? null])),
        updatedAt: note.updatedAt,
      };
    }
    let updated: Note;
    try {
      updated = await vc.updateNote(id, { metadata: patch, ifUpdatedAt: note.updatedAt ?? undefined });
    } catch (e) {
      if (e instanceof VaultConflictError && attempt === 0) continue; // the note moved under us — re-read and re-check once
      if (e instanceof VaultConflictError) return { ok: false, id, status: 409, error: "conflict", fields: [], updatedAt: null };
      if (e instanceof VaultError && (e.status === 400 || e.status === 422)) return { ok: false, id, status: 400, error: "vault_rejected" };
      return { ok: false, id, status: 502, error: "vault_error" };
    }
    // A metadata-only write to a LIVE collaborative doc moves the vault's updatedAt
    // without changing its content: tell the reconciler, or its next tick would
    // fold this content-stale copy back over unsaved human typing.
    if (isDocLive(entry.id, id)) {
      const prev = Date.parse(note.updatedAt ?? "");
      const next = Date.parse(updated.updatedAt ?? "");
      if (Number.isFinite(prev) && Number.isFinite(next)) markReconciled(docNameFor(entry.id, id), prev, next);
    }
    treeUpsertNote(entry, updated);
    const metadata: Record<string, unknown> = { ...(actor.kind === "link" ? stripIdentity(updated.metadata ?? {}) : updated.metadata ?? {}) };
    if (!isAdmin(actor)) for (const k of ACCESS_KEYS) delete metadata[k];
    return { ok: true, id: updated.id, updatedAt: updated.updatedAt, metadata };
  }
  return { ok: false, id, status: 409, error: "conflict", fields: [] };
}

const evictVaultListings = (entry: VaultEntry) => {
  for (const k of [...listCache.keys()]) if (k.startsWith(`${entry.id}\u0000`)) evictListing(k);
};
/** Spend `n` units of the actor's per-minute property-write budget; seconds to wait, or null. */
function consumeWriteBudget(a: Actor, n: number): number | null {
  let wait: number | null = null;
  for (let i = 0; i < n; i++) wait = consumeRateLimit(`db-write:${actorKey(a)}`, envInt("PROPERTY_BATCH_ITEMS_PER_MINUTE", isAdmin(a) ? 2000 : 600), 60_000) ?? wait;
  return wait;
}
const actorKey = (a: Actor) => (a.kind === "user" ? `u:${a.email}` : a.kind === "link" ? `l:${a.capabilityId}` : "anon");

// ── batched property writes (bulk edit) ───────────────────────────────────────

const BATCH_MAX = 100;
const BATCH_CONCURRENCY = 4;

/**
 * POST /api/properties/batch {items: [{id, set, expect?}] (1–100)}
 *   → 200 {results: [...]} when every item was written, 207 when some failed.
 * Each item is exactly one `POST /properties/:id` (same view/edit/lock/CAS rules)
 * and its own result — a refusal never stops the others, and nothing is rolled
 * back (each write is its own vault revision; the client's Undo re-applies the
 * previous values with the same CAS). A note the caller cannot view answers
 * `not_found`, exactly like a missing one. Items count against a per-actor rate.
 */
databasesApi.post("/properties/batch", bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
  const items = body?.items;
  if (!Array.isArray(items) || !items.length || items.length > BATCH_MAX) return c.json({ error: "bad_request", detail: `items must be 1–${BATCH_MAX} writes` }, 400);
  const parsed: Array<{ id: string; entries: Array<[string, unknown]>; expected: Array<[string, unknown]> }> = [];
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) {
    const raw = it as { id?: unknown; set?: unknown; expect?: unknown } | null;
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !isNoteId(raw.id)) return c.json({ error: "bad_request", detail: `item ${i + 1}: invalid id` }, 400);
    if (seen.has(raw.id)) return c.json({ error: "bad_request", detail: `item ${i + 1}: duplicate id` }, 400);
    seen.add(raw.id);
    const p = parseWrite(raw.set, raw.expect);
    if ("error" in p) return c.json({ error: "bad_request", detail: `item ${i + 1}: ${p.error}` }, 400);
    parsed.push({ id: raw.id, ...p });
  }
  // Every item counts against the actor's per-minute write budget.
  const wait = consumeWriteBudget(actor, parsed.length);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }
  const entry = entryFor(c, actor);
  const results: WriteOutcome[] = new Array(parsed.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, parsed.length) }, async () => {
    while (next < parsed.length) {
      const i = next++;
      const w = parsed[i]!;
      results[i] = await writeProperties(actor, entry, w.id, w.entries, w.expected);
    }
  }));
  if (results.some((r) => r.ok)) evictVaultListings(entry);
  const out = results.map((r) => {
    if (r.ok) return { id: r.id, ok: true, updatedAt: r.updatedAt, metadata: r.metadata };
    const { status: _s, ...rest } = r;
    return rest;
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ results: out }, results.every((r) => r.ok) ? 200 : 207);
});

databasesApi.post("/properties/:id", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  // A note is named by its id only — never a path/title alias the vault would resolve (review L1).
  const id = c.req.param("id");
  if (!id || !isNoteId(id)) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { set?: unknown; expect?: unknown } | null;
  const parsed = parseWrite(body?.set, body?.expect);
  if ("error" in parsed) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  // One per-actor write budget for single and batched property writes (review L2).
  const wait = consumeWriteBudget(actor, 1);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }
  const entry = entryFor(c, actor);
  const out = await writeProperties(actor, entry, id, parsed.entries, parsed.expected);
  if (out.ok) evictVaultListings(entry);
  if (out.ok) return c.json({ id: out.id, updatedAt: out.updatedAt, metadata: out.metadata });
  const { ok: _ok, id: _id, status, ...rest } = out;
  return c.json(rest, status);
});


// ── CSV import ───────────────────────────────────────────────────────────────

const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_ROWS = 2000;
const IMPORT_MAX_COLS = 60;
const IMPORT_CONCURRENCY = 2;
const SAMPLE_MAX = 50;
const ERRORS_MAX = 100;

const okPrefix = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length <= 200 && !/[\u0000-\u001f\\]/.test(p) &&
  !p.startsWith("/") && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
const safeLeaf = (t: string) => safeTitleLeaf(t);
const keyNorm = (v: unknown) => unwrapLink((Array.isArray(v) ? v.join(",") : v === null || v === undefined ? "" : String(v)).trim()).toLowerCase();

interface ImportRowPlan {
  row: number;
  action: "create" | "update" | "unchanged" | "error";
  title: string;
  id?: string;
  /** Property keys that change (update) or are set (create). */
  changes?: string[];
  error?: string;
}

/**
 * POST /api/databases/import/csv — OWNER/ADMIN only (+ CSRF).
 *   {tag, csv, mapping: {<column header>: "$title" | <property key> | ""},
 *    keyColumn?, pathPrefix, dryRun = true}
 *
 * Rows are matched to existing pages of `tag` by the key column's property
 * (default: the title column) — so re-running the same file converges instead
 * of duplicating. A match is UPDATED with only the cells that differ (one CAS
 * PATCH each, never forced); no match is CREATED at `<pathPrefix>/<title>`.
 * Values are coerced by the tag's vault schema; a value the schema would refuse
 * (not a number, not an option, …) makes that ROW an error, never the file.
 * `dryRun` (the default) plans without writing. Bounded: 2 MB, 2,000 rows,
 * 60 columns; a page the key matches more than once is ambiguous (row error).
 */
databasesApi.post("/databases/import/csv", bodyLimit({ maxSize: IMPORT_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: "too_large", limit: IMPORT_MAX_BYTES }, 413) }), async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  if (actor.kind !== "user" || !isAdmin(actor)) return c.json({ error: "forbidden", reason: "importing is limited to the owner and admins" }, 403);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request", detail: "body must be JSON" }, 400);
  const { csv, mapping, keyColumn, pathPrefix } = body;
  // Canonical (`../tags.ts`): `#agent-skill` must not slip past the managed-tag check.
  const tag = typeof body.tag === "string" ? canonicalTag(body.tag) : body.tag;
  const dryRun = body.dryRun !== false;
  if (typeof tag !== "string" || !tag || tag.length > 128 || /[\u0000-\u001f]/.test(tag)) return c.json({ error: "bad_request", detail: "invalid tag" }, 400);
  if (LOCKED_TAG(tag) || tag === "prism-trashed") return c.json({ error: "forbidden", reason: "this tag is managed by Prism" }, 403);
  if (typeof csv !== "string" || !csv.trim()) return c.json({ error: "bad_request", detail: "csv must be text" }, 400);
  if (csv.length > IMPORT_MAX_BYTES) return c.json({ error: "too_large", limit: IMPORT_MAX_BYTES }, 413);
  if (!okPrefix(pathPrefix)) return c.json({ error: "bad_request", detail: "pathPrefix must be a folder path" }, 400);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return c.json({ error: "bad_request", detail: "mapping must be an object" }, 400);
  const map = new Map<string, string>();
  for (const [col, key] of Object.entries(mapping as Record<string, unknown>)) {
    if (typeof key !== "string" || col.length > 200) return c.json({ error: "bad_request", detail: "invalid mapping" }, 400);
    if (key === "") continue;
    if (key !== "$title" && (!isFieldKey(key) || isSystemKey(key))) return c.json({ error: "bad_request", detail: `not a property: ${key}` }, 400);
    if ([...map.values()].includes(key)) return c.json({ error: "bad_request", detail: `two columns map to ${key}` }, 400);
    map.set(col, key);
  }
  if (![...map.values()].includes("$title")) return c.json({ error: "bad_request", detail: "map one column to the title" }, 400);

  let table: string[][];
  try {
    table = parseCsv(csv, { maxRows: IMPORT_MAX_ROWS + 1, maxCols: IMPORT_MAX_COLS, maxCell: 10_000 });
  } catch (e) {
    return c.json({ error: "bad_request", detail: e instanceof CsvError ? e.message : "the file is not valid CSV" }, 400);
  }
  const header = (table[0] ?? []).map((h) => h.trim());
  const rows = table.slice(1);
  if (!rows.length) return c.json({ error: "bad_request", detail: "the file has no data rows" }, 400);
  for (const col of map.keys()) if (!header.includes(col)) return c.json({ error: "bad_request", detail: `no column named ${col}` }, 400);
  const keyCol = typeof keyColumn === "string" && keyColumn ? keyColumn : [...map.entries()].find(([, k]) => k === "$title")![0];
  const keyProp = map.get(keyCol);
  if (!keyProp) return c.json({ error: "bad_request", detail: "the key column must be mapped" }, 400);

  const who = actorKey(actor);
  const wait = consumeRateLimit(`db-import:${who}`, dryRun ? 30 : 6, 60_000);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }

  const entry = entryFor(c, actor);
  let schema: TagSchema | undefined;
  let existing: Note[];
  try {
    schemaCache.delete(entry.id);
    schema = (await vaultSchemas(entry)).get(tag);
    // A dedicated, fresh, lean listing with EXACTLY the keys the import reads
    // (review M1): the canonical query listing carries only schema keys, so a
    // non-schema key column would never match and every re-run would duplicate.
    const keys = [...new Set(["title", ...[...map.values()].filter((k) => k !== "$title")])];
    existing = (await vaultClient(entry.id).listNotes({ tags: [tag], includeContent: false, includeMetadata: keys, limit: RAW_MAX })).filter((n) => !(n.tags ?? []).includes("prism-trashed"));
  } catch (e) {
    return vaultFailure(c, e);
  }
  const fields = schema?.fields ?? {};
  const readKeyOf = (n: Note) => (keyProp === "$title" ? keyNorm(n.metadata?.title ?? n.path?.split("/").pop() ?? "") : keyNorm(n.metadata?.[keyProp]));
  const byKey = new Map<string, Note[]>();
  for (const n of existing) {
    const k = readKeyOf(n);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), n]);
  }
  const takenPaths = new Set(existing.map((n) => (n.path ?? "").toLowerCase()));
  const seenKeys = new Set<string>();
  const plans: Array<ImportRowPlan & { set?: Record<string, unknown>; note?: Note; path?: string }> = [];
  for (const [i, cells] of rows.entries()) {
    const rowNo = i + 2; // 1-based, after the header
    const values: Record<string, unknown> = {};
    let title = "";
    let error = "";
    for (const [col, key] of map) {
      const raw = cells[header.indexOf(col)] ?? "";
      if (key === "$title") {
        title = raw.trim().slice(0, 500);
        continue;
      }
      const coerced = coerceCsvValue(raw, fields[key]);
      if ("error" in coerced) {
        error = `${col}: ${coerced.error}`;
        break;
      }
      values[key] = coerced.value;
    }
    if (!error && !title) error = "the title is empty";
    const keyValue = keyNorm(keyProp === "$title" ? title : values[keyProp]);
    if (!error && !keyValue) error = `${keyCol} is empty`;
    if (!error && seenKeys.has(keyValue)) error = `${keyCol} repeats an earlier row`;
    if (error) {
      plans.push({ row: rowNo, action: "error", title, error });
      continue;
    }
    seenKeys.add(keyValue);
    const matches = byKey.get(keyValue) ?? [];
    if (matches.length > 1) {
      plans.push({ row: rowNo, action: "error", title, error: `${matches.length} pages already have this ${keyCol}` });
      continue;
    }
    const match = matches[0];
    if (match) {
      const set: Record<string, unknown> = {};
      const curTitle = typeof match.metadata?.title === "string" ? match.metadata.title : null;
      if (title !== curTitle) set.title = title;
      for (const [k, v] of Object.entries(values)) if (!same(match.metadata?.[k], v)) set[k] = v;
      const changes = Object.keys(set);
      plans.push({ row: rowNo, action: changes.length ? "update" : "unchanged", title, id: match.id, changes, set, note: match });
    } else {
      let path = `${pathPrefix}/${safeLeaf(title)}`;
      if (takenPaths.has(path.toLowerCase())) path = `${path} ${rowNo}`;
      takenPaths.add(path.toLowerCase());
      const set: Record<string, unknown> = { title };
      for (const [k, v] of Object.entries(values)) if (v !== null) set[k] = v;
      plans.push({ row: rowNo, action: "create", title, changes: Object.keys(set).filter((k) => k !== "title"), set, path });
    }
  }
  const count = (a: ImportRowPlan["action"]) => plans.filter((p) => p.action === a).length;
  const summary = { create: count("create"), update: count("update"), unchanged: count("unchanged"), error: count("error") };
  const shape = (p: ImportRowPlan) => ({ row: p.row, action: p.action, title: p.title.slice(0, 120), ...(p.id ? { id: p.id } : {}), ...(p.changes ? { changes: p.changes } : {}), ...(p.error ? { error: p.error } : {}) });
  const response = {
    dryRun,
    tag,
    rows: rows.length,
    key: keyCol,
    summary,
    sample: plans.filter((p) => p.action !== "error").slice(0, SAMPLE_MAX).map(shape),
    errors: plans.filter((p) => p.action === "error").slice(0, ERRORS_MAX).map(shape),
  };
  c.header("Cache-Control", "private, no-store");
  if (dryRun) return c.json(response);

  const vc = vaultClient(entry.id);
  const work = plans.filter((p) => p.action === "create" || p.action === "update");
  const failed: Array<{ row: number; error: string }> = [];
  let created = 0;
  let updated = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, work.length) }, async () => {
    while (next < work.length) {
      const p = work[next++]!;
      try {
        if (p.action === "create") {
          const n = await vc.createNote({ content: "", path: p.path!, tags: [tag], metadata: stampMetadata(p.set, actor) });
          treeUpsertNote(entry, n);
          created++;
        } else {
          // CAS against the revision the plan was made from — never forced.
          const n = await vc.updateNote(p.id!, { metadata: stampMetadata(p.set, actor), ifUpdatedAt: p.note!.updatedAt ?? undefined });
          if (isDocLive(entry.id, p.id!)) {
            const prev = Date.parse(p.note!.updatedAt ?? "");
            const nx = Date.parse(n.updatedAt ?? "");
            if (Number.isFinite(prev) && Number.isFinite(nx)) markReconciled(docNameFor(entry.id, p.id!), prev, nx);
          }
          treeUpsertNote(entry, n);
          updated++;
        }
      } catch (e) {
        failed.push({ row: p.row, error: e instanceof VaultConflictError ? "changed since the preview; run the import again" : e instanceof VaultError ? `vault HTTP ${e.status}` : "not written" });
      }
    }
  }));
  evictVaultListings(entry);
  console.log(`[databases] csv import ${tag} (vault ${entry.id}): +${created} ~${updated} !${failed.length} of ${rows.length} rows`);
  return c.json({ ...response, result: { created, updated, failed: failed.sort((a, b) => a.row - b.row).slice(0, ERRORS_MAX) } }, failed.length ? 207 : 200);
});

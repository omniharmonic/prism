/**
 * Typed properties + database views — the server half (mounted into the gateway
 * BEFORE the owner short-circuit, so owners and non-owners both reach these
 * handlers instead of the vault passthrough / the non-owner 403 catch-all).
 *
 *   GET  /api/schemas[?tags=a,b]   tag → {description, fields{type,enum,default,
 *                                  description,indexed,kind,label,colors,hidden}}
 *   PUT  /api/schemas/:tag         owner-only additive schema edit (+ hints)
 *   POST /api/query                lean filtered/sorted/paged rows for a view
 *   POST /api/properties/:id       metadata-only property write with per-field CAS
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
import { Hono, type Context } from "hono";
import { db, resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultConflictError, VaultError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, grantedTags, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { ensureTree, rowRef, treeUpsertNote } from "../tree";
import { docNameFor, isDocLive, markReconciled } from "../collab";
import { mintEphemeralAdminToken } from "../mcp-token";
import { csrfRefusal } from "./actions";
import {
  CursorMismatchError,
  isFieldKey,
  isSystemKey,
  mergeSchemaFields,
  metadataKeysFor,
  runQuery,
  validateQuerySpec,
  validateSchemaPatch,
  type FieldHints,
  type QueryInput,
  type SchemaField,
  type TagSchema,
} from "@prism/core/database";

export const databasesApi = new Hono();

// ── shared helpers ───────────────────────────────────────────────────────────

const ref = (n: Pick<Note, "id" | "tags" | "metadata">): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
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
  schemaCache.clear();
  listCache.clear();
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
  return c.json({ schemas: out });
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

databasesApi.put("/schemas/:tag", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.role !== "owner") return c.json({ error: "forbidden", reason: "changing a schema is owner-only" }, 403);
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const tag = c.req.param("tag");
  if (!tag || tag.length > 128 || /[\u0000-\u001f]/.test(tag)) return c.json({ error: "bad_request", detail: "invalid tag" }, 400);
  const parsed = validateSchemaPatch(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  const { patch } = parsed;
  const entry = entryFor(c, actor);

  let current: TagSchema | undefined;
  try {
    schemaCache.delete(entry.id); // decide against the vault's CURRENT schema
    current = (await vaultSchemas(entry)).get(tag);
  } catch (e) {
    return vaultFailure(c, e);
  }
  const merged = mergeSchemaFields(current?.fields ?? {}, patch.fields ?? {});
  if (!merged.ok) return c.json({ error: "not_additive", detail: merged.error, field: merged.field }, 409);
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
});

// ── query ────────────────────────────────────────────────────────────────────

const SCAN_MAX = Number(process.env.QUERY_SCAN_MAX ?? 20_000);
const LIST_TTL_MS = Number(process.env.QUERY_LIST_TTL_MS ?? 4_000);
const listCache = new Map<string, { expires: number; value: Promise<Note[]> }>();
const PERMISSION_KEYS = ["prism_creator", "prism_visibility"];

function leanList(entry: VaultEntry, tag: string, keys: string[]): Promise<Note[]> {
  const k = `${entry.id}\u0000${tag}\u0000${[...keys].sort().join(",")}`;
  const hit = listCache.get(k);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = vaultClient(entry.id).listNotes({ tags: [tag], includeContent: false, includeMetadata: keys, limit: SCAN_MAX + 1 });
  listCache.set(k, { expires: Date.now() + LIST_TTL_MS, value });
  value.catch(() => listCache.delete(k));
  if (listCache.size > 100) for (const [key, v] of listCache) if (v.expires <= Date.now()) listCache.delete(key);
  return value;
}

databasesApi.post("/query", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const parsed = validateQuerySpec(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: "bad_request", detail: parsed.error }, 400);
  const spec = parsed.spec;
  const entry = entryFor(c, actor);
  const owner = isAdmin(actor);
  let notes: Note[];
  try {
    notes = await leanList(entry, spec.tags[0]!, [...metadataKeysFor(spec), ...PERMISSION_KEYS]);
  } catch (e) {
    return vaultFailure(c, e);
  }
  const truncated = notes.length > SCAN_MAX;
  if (truncated) notes = notes.slice(0, SCAN_MAX);
  const stamp = actor.kind === "user" && !owner;
  const visible: QueryInput[] = [];
  for (const n of notes) {
    if (owner) {
      visible.push(n);
      continue;
    }
    const caps = capsFor(actor, ref(n));
    if (caps.has("view")) visible.push(stamp ? { ...n, _caps: [...caps] } : n);
  }
  try {
    const page = runQuery(visible, spec, { limited: !owner, truncated });
    // Permission keys are read for the filter above, never returned unless asked for.
    for (const r of page.rows) for (const k of PERMISSION_KEYS) if (!spec.fields?.includes(k)) delete r.metadata[k];
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

databasesApi.post("/properties/:id", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { set?: unknown; expect?: unknown } | null;
  const set = body?.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) return c.json({ error: "bad_request", detail: "set must be an object" }, 400);
  const entries = Object.entries(set as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_PROPS) return c.json({ error: "bad_request", detail: `set 1–${MAX_PROPS} properties` }, 400);
  for (const [k, v] of entries) {
    if (!isFieldKey(k) || isSystemKey(k) && k !== "title" && k !== "icon") return c.json({ error: "bad_request", detail: `not a property: ${k}` }, 400);
    if (!validValue(v) || JSON.stringify(v).length > MAX_VALUE_BYTES) return c.json({ error: "bad_request", detail: `unsupported value for ${k}` }, 400);
  }
  const expect = body?.expect;
  if (expect !== undefined && (typeof expect !== "object" || expect === null || Array.isArray(expect))) {
    return c.json({ error: "bad_request", detail: "expect must be an object" }, 400);
  }
  const expected = Object.entries((expect ?? {}) as Record<string, unknown>).filter(([k]) => Object.prototype.hasOwnProperty.call(set, k));

  const entry = entryFor(c, actor);
  const vc = vaultClient(entry.id);
  const id = c.req.param("id");
  const patch = Object.fromEntries(entries);

  for (let attempt = 0; attempt < 2; attempt++) {
    let note: Note;
    try {
      note = await vc.getNote(id);
    } catch (e) {
      return vaultFailure(c, e);
    }
    if (!isAdmin(actor)) {
      const caps = capsFor(actor, ref(note));
      if (!caps.has("view")) return c.json({ error: "not_found" }, 404);
      if (!caps.has("edit")) return c.json({ error: "forbidden", reason: "editing properties requires edit access" }, 403);
      if (entries.some(([k]) => ACCESS_KEYS.has(k))) return c.json({ error: "forbidden" }, 403);
    }
    // Per-field compare-and-set: a property someone else changed since the client
    // read it is a conflict; edits to OTHER fields (or the body) are not.
    const stale = expected.filter(([k, v]) => !same(note.metadata?.[k], v));
    if (stale.length) {
      return c.json({
        error: "conflict",
        fields: stale.map(([k]) => k),
        current: Object.fromEntries(stale.map(([k]) => [k, note.metadata?.[k] ?? null])),
        updatedAt: note.updatedAt,
      }, 409);
    }
    let updated: Note;
    try {
      updated = await vc.updateNote(id, { metadata: patch, ifUpdatedAt: note.updatedAt ?? undefined });
    } catch (e) {
      if (e instanceof VaultConflictError && attempt === 0) continue; // the note moved under us — re-read and re-check once
      if (e instanceof VaultConflictError) return c.json({ error: "conflict", fields: [], updatedAt: null }, 409);
      return vaultFailure(c, e);
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
    for (const k of listCache.keys()) if (k.startsWith(`${entry.id}\u0000`)) listCache.delete(k);
    const metadata: Record<string, unknown> = { ...(updated.metadata ?? {}) };
    if (!isAdmin(actor)) for (const k of ACCESS_KEYS) delete metadata[k];
    return c.json({ id: updated.id, updatedAt: updated.updatedAt, metadata });
  }
  return c.json({ error: "conflict", fields: [] }, 409);
});

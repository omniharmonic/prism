/**
 * React glue for typed properties + database views over the VaultClient seam.
 *
 * Every hook works on every shell: the web client uses the server routes
 * (`getSchemas` / `queryNotes` / `updateProperties`); a shell without them (the
 * legacy desktop, fixtures) falls back to the bundled tag schemas, the shared
 * pure engine over `listNotes`, and a metadata-only `updateNote` with the same
 * per-field compare-and-set done client-side.
 */
import { containerTitle, leafTitle } from "../pages/containerTitle";
import { useCallback } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { PropertyConflictError, VaultRequestError, type PropertyWriteResult, type VaultClient } from "../../data/VaultClient";
import { useAgentChatStore } from "../agent/chatStore";
import { queryKeys } from "../parachute/queries";
import type { Note } from "../types";
import tagSchemas from "../schemas/tag-schemas.json";
import { runQuery, type AggregateGroup, type AggregateGroupBy, type AggregateRequest, type AggregateValues, type QueryPage, type QuerySpec } from "./query";
import { GENERIC_LEAF, type RelationTarget, type SchemaMap, type SchemaPatch, type TagSchema } from "./schema";
import { buildRelationIndex, type RelationCandidate, type RelationIndex } from "./relations";
import type { PropertyBatchItem, PropertyBatchResult } from "./wire";
import { refuseStructuredWrite, StructuredValueError } from "./structured";

/** The active audience (vault/workspace/account) — part of every cache key. */
export function useScope(): string {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  return client.scope?.() ?? audience ?? "";
}

/** The schemas shipped with Prism (tag-schemas.json): the offline/desktop fallback. */
export function bundledSchemas(): SchemaMap {
  const out: SchemaMap = {};
  const tags = (tagSchemas as unknown as { tags: Record<string, { description?: string; fields?: TagSchema["fields"] }> }).tags;
  for (const [tag, entry] of Object.entries(tags)) out[tag] = { description: entry.description ?? null, fields: entry.fields ?? {} };
  return out;
}

/** An older server without the route (never a 403: that is a real refusal, review L4). */
const unsupported = (e: unknown) => e instanceof VaultRequestError && [404, 405, 501].includes(e.status);

export const schemaKey = (scope: string) => ["vault", "schemas", scope] as const;

export function useSchemas() {
  const client = useVaultClient();
  const scope = useScope();
  return useQuery({
    queryKey: schemaKey(scope),
    staleTime: 60_000,
    queryFn: async (): Promise<{ schemas: SchemaMap; live: boolean; canEdit: boolean }> => {
      if (!client.getSchemas) return { schemas: bundledSchemas(), live: false, canEdit: false };
      try {
        const r = await client.getSchemas();
        return { schemas: r.schemas, live: true, canEdit: r.canEdit === true };
      } catch (e) {
        if (unsupported(e)) return { schemas: bundledSchemas(), live: false, canEdit: false };
        throw e;
      }
    },
  });
}

export function useUpdateSchema() {
  const client = useVaultClient();
  const scope = useScope();
  const qc = useQueryClient();
  const available = !!client.updateSchema;
  const update = useCallback(async (tag: string, patch: SchemaPatch) => {
    if (!client.updateSchema) throw new Error("Editing a database's properties needs the Prism Server.");
    const schema = await client.updateSchema(tag, patch);
    qc.setQueryData<{ schemas: SchemaMap; live: boolean; canEdit: boolean }>(schemaKey(scope), (old) =>
      old ? { ...old, schemas: { ...old.schemas, [tag]: schema } } : old);
    void qc.invalidateQueries({ queryKey: schemaKey(scope) });
    return schema;
  }, [client, qc, scope]);
  /** Re-read every schema (a server job changed fields + hints, e.g. a type conversion). */
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: schemaKey(scope) }), [qc, scope]);
  return { available, update, refresh };
}

// ── property writes ──────────────────────────────────────────────────────────

const conflictStatus = (e: unknown) =>
  (e instanceof VaultRequestError && (e.status === 409 || e.status === 428)) || /\b409\b|conflict/i.test(String((e as Error)?.message ?? ""));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Client-side CAS for shells without `updateProperties`. Retries once on a revision race. */
async function fallbackWrite(
  client: VaultClient,
  id: string,
  set: Record<string, unknown>,
  expect: Record<string, unknown>,
  updatedAt: string | null,
  expectedScope?: string,
): Promise<PropertyWriteResult> {
  let rev = updatedAt;
  // This path has no server rule behind it: check the value actually stored.
  const stored = await client.getNote(id, { fresh: true }).catch(() => null);
  if (stored) {
    const refused = refuseStructuredWrite(set, stored.metadata ?? {});
    if (refused.length) throw new StructuredValueError(refused);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const n = await client.updateNote(id, { metadata: set, ifUpdatedAt: rev ?? undefined }, { expectedScope });
      return { id: n.id, updatedAt: n.updatedAt, metadata: n.metadata ?? {} };
    } catch (e) {
      if (!conflictStatus(e) || attempt) throw e;
      const fresh = await client.getNote(id, { fresh: true });
      const stale = Object.keys(expect).filter((k) => !same(fresh.metadata?.[k], expect[k]));
      if (stale.length) throw new PropertyConflictError(stale, Object.fromEntries(stale.map((k) => [k, fresh.metadata?.[k] ?? null])));
      rev = fresh.updatedAt;
    }
  }
  throw new PropertyConflictError([], {});
}

/**
 * Write properties of one note. `expect` holds the values the user saw, so a
 * property changed elsewhere fails with {@link PropertyConflictError} instead of
 * being overwritten. Caches are patched in place, then lists refresh.
 */
export function usePropertyWriter() {
  const client = useVaultClient();
  const scope = useScope();
  const qc = useQueryClient();
  return useCallback(async (
    note: Pick<Note, "id" | "updatedAt">,
    set: Record<string, unknown>,
    expect: Record<string, unknown>,
  ): Promise<PropertyWriteResult> => {
    // A value holding objects is never replaced by an inline edit (`structured.ts`); nothing is sent.
    const refused = refuseStructuredWrite(set, expect);
    if (refused.length) throw new StructuredValueError(refused);
    let result: PropertyWriteResult;
    if (client.updateProperties) {
      try {
        result = await client.updateProperties(note.id, set, expect);
      } catch (e) {
        if (!unsupported(e)) throw e;
        result = await fallbackWrite(client, note.id, set, expect, note.updatedAt, scope || undefined);
      }
    } else {
      result = await fallbackWrite(client, note.id, set, expect, note.updatedAt, scope || undefined);
    }
    qc.setQueryData<Note>(queryKeys.vault.note(note.id), (old) => {
      if (!old) return old;
      // `result.metadata` is the whole stored metadata online, or just the patch
      // when queued offline — merge, then apply this write's deletions.
      const metadata: Record<string, unknown> = { ...(old.metadata ?? {}), ...result.metadata };
      for (const [k, v] of Object.entries(set)) if (v === null) delete metadata[k];
      return { ...old, updatedAt: result.updatedAt ?? old.updatedAt, metadata };
    });
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && q.queryKey[1] === "notes" && typeof q.queryKey[2] !== "string" });
    return result;
  }, [client, qc, scope]);
}

/**
 * Bulk property writes (bulk edit / its Undo). One CAS write per row, one result
 * per row — a refusal or conflict on one row never blocks the others. Uses the
 * server batch route when present; otherwise one `updateProperties` (or the
 * client-side CAS fallback) per row, sequentially.
 */
export function useBatchPropertyWriter() {
  const client = useVaultClient();
  const scope = useScope();
  const qc = useQueryClient();
  return useCallback(async (all: Array<PropertyBatchItem & { updatedAt?: string | null }>): Promise<PropertyBatchResult[]> => {
    // Rows whose value holds objects are left out of the request and reported (`structured.ts`).
    const kept: PropertyBatchResult[] = [];
    const items = all.filter((it) => {
      const refused = refuseStructuredWrite(it.set, it.expect);
      if (refused.length) kept.push({ id: it.id, ok: false, error: "structured_value", fields: refused });
      return !refused.length;
    });
    let results: PropertyBatchResult[] | null = null;
    if (!items.length) results = [];
    if (!results && client.updatePropertiesBatch) {
      try {
        const out: PropertyBatchResult[] = [];
        for (let i = 0; i < items.length; i += 100) out.push(...await client.updatePropertiesBatch(items.slice(i, i + 100).map(({ id, set, expect }) => ({ id, set, ...(expect ? { expect } : {}) }))));
        results = out;
      } catch (e) {
        if (!unsupported(e)) throw e;
      }
    }
    if (!results) {
      results = [];
      for (const it of items) {
        try {
          const r = client.updateProperties
            ? await client.updateProperties(it.id, it.set, it.expect)
            : await fallbackWrite(client, it.id, it.set, it.expect ?? {}, it.updatedAt ?? null, scope || undefined);
          results.push({ id: it.id, ok: true, updatedAt: r.updatedAt, metadata: r.metadata });
        } catch (e) {
          if (e instanceof PropertyConflictError) results.push({ id: it.id, ok: false, error: "conflict", fields: e.fields, current: e.current });
          else if (e instanceof StructuredValueError) results.push({ id: it.id, ok: false, error: "structured_value", fields: e.fields });
          else results.push({ id: it.id, ok: false, error: e instanceof VaultRequestError && e.status === 404 ? "not_found" : e instanceof VaultRequestError && e.status === 403 ? "forbidden" : "vault_error" });
        }
      }
    }
    for (const r of results) {
      if (!r.ok) continue;
      qc.setQueryData<Note>(queryKeys.vault.note(r.id), (old) => (old ? { ...old, updatedAt: r.updatedAt ?? old.updatedAt, metadata: { ...(old.metadata ?? {}), ...r.metadata } } : old));
    }
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && q.queryKey[1] === "notes" && typeof q.queryKey[2] !== "string" });
    return [...results, ...kept];
  }, [client, qc, scope]);
}

/**
 * Pages that link TO `note` through a relation whose schema asks for a reverse
 * display (`reverseLabel`, with `relationTag` naming one of the note's tags).
 * Read-only: computed by a view-filtered query, never written back (the forward
 * relation stays the single source of truth, so nothing can drift).
 */
export function useReverseRelations(note: Pick<Note, "id" | "path" | "tags"> | null, schemas: SchemaMap) {
  const client = useVaultClient();
  const scope = useScope();
  const tags = note?.tags ?? [];
  const specs: Array<{ tag: string; key: string; label: string }> = [];
  for (const [tag, s] of Object.entries(schemas)) {
    for (const [key, f] of Object.entries(s.fields)) {
      if (f.reverseLabel && f.relationTag && tags.includes(f.relationTag)) specs.push({ tag, key, label: f.reverseLabel });
    }
  }
  return useQuery({
    queryKey: ["vault", "notes", { reverse: scope, id: note?.id, path: note?.path, specs }],
    enabled: !!note?.path && specs.length > 0,
    staleTime: 15_000,
    queryFn: async () => {
      const out: Array<{ key: string; tag: string; label: string; rows: Array<{ id: string; path: string | null; title: string }>; more: boolean }> = [];
      for (const s of specs.slice(0, 6)) {
        const spec: QuerySpec = { tags: [s.tag], filter: { match: "all", conditions: [{ key: s.key, op: "eq", value: note!.path! }] }, sort: [{ key: "$title", dir: "asc" }], limit: 25, fields: ["title", s.key] };
        let page: QueryPage;
        if (client.queryNotes) {
          try {
            page = await client.queryNotes(spec);
          } catch (e) {
            if (!unsupported(e)) throw e;
            page = runQuery(await client.listNotes({ tag: s.tag, limit: 5000 }), spec, { limited: false });
          }
        } else page = runQuery(await client.listNotes({ tag: s.tag, limit: 5000 }), spec, { limited: false });
        out.push({ ...s, rows: page.rows.filter((r) => r.id !== note!.id).map((r) => ({ id: r.id, path: r.path, title: (typeof r.metadata.title === "string" && r.metadata.title) || leafTitle(r.path, r.metadata) || r.id })), more: !!page.next });
      }
      return out;
    },
  });
}

// ── database rows ────────────────────────────────────────────────────────────

/** Rows for a view, page by page. Key lives under ["vault","notes",…] so the
 *  invalidation channel refreshes it like any note list. */
export function useDatabaseRows(spec: QuerySpec | null) {
  const client = useVaultClient();
  const scope = useScope();
  return useInfiniteQuery({
    queryKey: ["vault", "notes", { database: scope, spec }],
    enabled: !!spec,
    initialPageParam: null as string | null,
    getNextPageParam: (last: QueryPage) => last.next,
    queryFn: async ({ pageParam }): Promise<QueryPage> => {
      // The caller's zone decides "@today" and which local day a datetime falls on.
      const s = { ...spec!, cursor: pageParam, tzOffset: new Date().getTimezoneOffset() };
      if (client.queryNotes) {
        try {
          return await client.queryNotes(s);
        } catch (e) {
          if (!unsupported(e)) throw e;
        }
      }
      // Fallback (shells without the route): the same engine over the shell's own,
      // already permission-scoped, bounded listing.
      const notes = await client.listNotes({ tag: spec!.tags[0], limit: 5000 });
      const limited = notes.some((n) => Array.isArray(n._caps));
      return runQuery(notes, s, { limited });
    },
  });
}

/** The answer to a view's calculations: figures over every matching row the viewer can see. */
export interface DatabaseAggregates {
  total: number;
  truncated: boolean;
  aggregates: AggregateValues;
  groups: AggregateGroup[] | null;
  /** Some groups are missing from `groups` (or incomplete): never read a missing one as empty. */
  groupsCapped: boolean;
  /** The server is older than calculations: it answered the rows but no figures. */
  unsupported: boolean;
}

/**
 * A view's calculations (NP-DB-26). `spec` is the view's ROW query: the figures
 * use exactly its tags, filter, search and `fields` (the fields decide what a
 * search reads), never its page size — so they cover the whole view. A separate,
 * one-row request: changing a calculation never reloads the rows, and on the
 * server it reuses the listing the rows came from. Keyed under
 * ["vault","notes",…] so every row change refreshes it with the rows.
 */
export function useDatabaseAggregates(spec: QuerySpec | null, aggregates: AggregateRequest[], groupBy: AggregateGroupBy | undefined) {
  const client = useVaultClient();
  const scope = useScope();
  const base = spec ? { tags: spec.tags, ...(spec.filter ? { filter: spec.filter } : {}), ...(spec.search ? { search: spec.search } : {}), ...(spec.fields ? { fields: spec.fields } : {}) } : null;
  return useQuery({
    queryKey: ["vault", "notes", { databaseCalc: scope, spec: base, aggregates, groupBy: groupBy ?? null }],
    enabled: !!base && aggregates.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<DatabaseAggregates> => {
      const s: QuerySpec = { ...base!, limit: 1, tzOffset: new Date().getTimezoneOffset(), aggregates, ...(groupBy ? { groupBy } : {}) };
      let page: QueryPage | null = null;
      if (client.queryNotes) {
        try {
          page = await client.queryNotes(s);
        } catch (e) {
          if (!unsupported(e)) throw e;
        }
      }
      if (!page) {
        const notes = await client.listNotes({ tag: s.tags[0], limit: 5000 });
        page = runQuery(notes, s, { limited: notes.some((n) => Array.isArray(n._caps)) });
      }
      return { total: page.total, truncated: page.truncated, aggregates: page.aggregates ?? {}, groups: page.groups ?? null, groupsCapped: page.groupsCapped === true, unsupported: page.aggregates === undefined };
    },
  });
}

/** A relation's target as the pickers use it: a tag name (older callers) or a target spec. */
const targetSpec = (t: string | RelationTarget | null): RelationTarget | null => (typeof t === "string" ? (t ? { tag: t } : null) : t);
const candidateOf = (n: { id: string; path: string | null; metadata: Record<string, unknown> | null }): RelationCandidate => {
  const m = n.metadata ?? {};
  const strings = (...vs: unknown[]) => vs.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((x): x is string => typeof x === "string" && !!x.trim());
  const leaf = n.path?.split("/").pop() ?? "";
  const parent = n.path?.split("/").slice(-2, -1)[0];
  return {
    id: n.id,
    path: n.path,
    // A container-named note (`…/opencivics/PROJECT`) is named like everywhere else: title → name → its folder made readable.
    title: (typeof m.title === "string" && m.title.trim()) || containerTitle(n.path, m) || (GENERIC_LEAF.test(leaf) && parent ? parent : leaf.replace(/\.md$/i, "")) || n.id,
    aliases: strings(m.aliases, m.alias),
    emails: strings(m.email, m.emails, m.contact, m.contact_emails, (m.channels && typeof m.channels === "object" ? (m.channels as Record<string, unknown>).email : undefined)),
  };
};
/** Notes under a folder, from the (permission-filtered) tree. */
async function underFolder(client: VaultClient, prefix: string): Promise<RelationCandidate[]> {
  const lower = `${prefix.toLowerCase()}/`;
  return (await client.listTree()).filter((n) => !!n.path && n.path.toLowerCase().startsWith(lower)).map(candidateOf);
}

/**
 * Search notes to link to (person/relation pickers): ONLY the relation's target —
 * pages with its tag, or pages under its folder — listed on open, narrowed as you
 * type. Without a target (an old relation nobody pointed anywhere) it searches
 * every page, as before. Lean when the server can.
 */
export function useLinkCandidates(target: string | RelationTarget | null, search: string, enabled: boolean) {
  const client = useVaultClient();
  const scope = useScope();
  const spec = targetSpec(target);
  return useQuery({
    queryKey: ["vault", "search", "link-candidates", scope, spec, search],
    enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<RelationCandidate[]> => {
      const needle = search.trim().toLowerCase();
      if (spec && "pathPrefix" in spec) {
        return (await underFolder(client, spec.pathPrefix))
          .filter((c) => !needle || c.title.toLowerCase().includes(needle) || (c.path ?? "").toLowerCase().includes(needle))
          .sort((a, b) => a.title.localeCompare(b.title))
          .slice(0, 20);
      }
      const tag = spec?.tag ?? null;
      if (tag && client.queryNotes) {
        try {
          const page = await client.queryNotes({ tags: [tag], search: search || undefined, limit: 20, sort: [{ key: "$title", dir: "asc" }], fields: ["title", "name"] });
          return page.rows.map(candidateOf);
        } catch (e) {
          if (!unsupported(e)) throw e;
        }
      }
      if (search.trim()) return (await client.search(search, tag ? [tag] : undefined, 20)).map(candidateOf);
      if (tag) return (await client.listNotes({ tag, limit: 20 })).map(candidateOf);
      return [];
    },
  });
}

export const relationIndexKey = (scope: string, spec: RelationTarget | null) => ["vault", "search", "relation-index", scope, spec] as const;
const INDEX_PAGES = 4;
/**
 * Every note of a relation's target (title, aliases, addresses — no bodies), to READ
 * stored values in any of their four encodings (`resolveRelationValue`). One query
 * per target, shared by every chip of a column; ≤ 2,000 notes (beyond that, values
 * past the cut simply stay unresolved — shown as their text).
 */
export function useRelationIndex(target: string | RelationTarget | null, enabled: boolean) {
  const client = useVaultClient();
  const scope = useScope();
  const spec = targetSpec(target);
  return useQuery({
    queryKey: relationIndexKey(scope, spec),
    enabled: enabled && !!spec,
    staleTime: 60_000,
    queryFn: () => loadRelationIndex(client, spec!),
  });
}

export async function loadRelationIndex(client: VaultClient, spec: RelationTarget): Promise<RelationIndex> {
  if ("pathPrefix" in spec) return buildRelationIndex(await underFolder(client, spec.pathPrefix));
  if (client.queryNotes) {
    try {
      const rows: RelationCandidate[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < INDEX_PAGES; i++) {
        const page: QueryPage = await client.queryNotes({ tags: [spec.tag], limit: 500, sort: [{ key: "$title", dir: "asc" }], fields: ["title", "name", "aliases", "alias", "email", "emails", "contact"], ...(cursor ? { cursor } : {}) });
        rows.push(...page.rows.map(candidateOf));
        cursor = page.next;
        if (!cursor) break;
      }
      return buildRelationIndex(rows);
    } catch (e) {
      if (!unsupported(e)) throw e;
    }
  }
  return buildRelationIndex((await client.listNotes({ tag: spec.tag, limit: 2000 })).map(candidateOf));
}

/**
 * What the CALLER may do with a note, from the server's own answer: `_caps` for
 * signed-in non-owners, `_level` for capability links, and nothing at all for
 * owners/admins (the passthrough) and the desktop — who may edit (review L5).
 */
export function noteAccess(note: { _caps?: string[]; _level?: string } | null | undefined): { edit: boolean; create: boolean; organize: boolean } {
  if (Array.isArray(note?._caps)) {
    const caps = new Set(note!._caps);
    return { edit: caps.has("edit"), create: caps.has("create"), organize: caps.has("organize") };
  }
  if (typeof note?._level === "string") {
    const edit = note._level === "edit" || note._level === "own";
    return { edit, create: false, organize: false };
  }
  return { edit: true, create: true, organize: true };
}

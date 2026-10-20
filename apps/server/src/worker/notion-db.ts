/**
 * Notion DATABASE ⇄ vault sync, server-side (Client parity B). The port of the
 * legacy desktop's `sync/adapters/notion_db.rs` + `commands/notion_db_cmds.rs`:
 * each database row ⇄ one vault note tagged `parachute_tag` under
 * `path_prefix`, property values ⇄ note metadata through a PropertyMapping list.
 * Pure HTTP (Bearer integration token + Notion-Version 2022-06-28) with the
 * vault's stored `notion` credential, to api.notion.com ONLY.
 *
 * Preserved (pinned by test/notion-db.test.ts): auto-discovered mappings, the
 * property extract/transform/reverse-transform tables, `should_overwrite`
 * (notion-wins / parachute-wins / newer-wins, unparseable timestamps → overwrite),
 * the no-op skip before the strategy gate (`metadata_unchanged` subset semantics
 * + identical content), pull-then-push for bidirectional, `notion_page_id` +
 * `title` stamped into metadata, created notes at `<prefix>/<slugify(title)>`.
 *
 * Deliberate changes (write less / refuse more):
 *  - vault updates carry `if_updated_at` (the note version the strategy judged);
 *    a 409 counts as a conflict, never a blind overwrite;
 *  - the push SKIPS a page whose properties already equal what it would send
 *    (the desktop re-PATCHed every page every run), and honours the strategy:
 *    a page edited in Notion since the last sync is not overwritten under
 *    notion-wins, nor under newer-wins when Notion is newer;
 *  - both phases judge "since the last sync" against the time the run STARTED
 *    (the desktop advanced last_synced inside pull, so push never saw changes);
 *  - push lists notes by tag and filters the path prefix on a segment boundary
 *    (the desktop passed the prefix as an exact path, so push found nothing);
 *  - `status` properties are read and written (the desktop logged them unknown);
 *  - a created note whose path is taken gets a `-<page id>` suffix instead of an
 *    error; created page/note ids are validated before use in a URL;
 *  - Notion requests are rate-limited to NOTION_DB_RPS (3/s) per token, with
 *    Retry-After honoured on 429.
 */
import { createHash } from "node:crypto";
import type { Note } from "../parachute";
import { VaultConflictError } from "../parachute";
import type { NotionConflict, NotionDbConfig, NotionDirection, PropertyMapping } from "./sync-store";
import { isReservedMetaKey } from "./sync-reserved";

// ── pure helpers (desktop parity) ────────────────────────────────────────────

/** Rust slugify: lowercase, whitespace runs → "-", keep alphanumerics and "-". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .replace(/[^\p{Alphabetic}\p{N}-]/gu, "");
}

export function titleCase(input: string): string {
  return input
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

export function shouldOverwrite(strategy: string, pageEdited: string | null | undefined, noteUpdated: string | null | undefined, lastSynced: string): boolean {
  const parse = (s: string | null | undefined): number | null => {
    if (!s) return null;
    // RFC 3339 only (chrono parse_from_rfc3339): date, "T", time, offset.
    if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s)) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  if (strategy === "parachute-wins") {
    const note = parse(noteUpdated);
    const synced = parse(lastSynced);
    if (note !== null && synced !== null) {
      if (note > synced) return false;
      const page = parse(pageEdited);
      return page === null ? true : page > synced;
    }
    return true;
  }
  if (strategy === "newer-wins") {
    const page = parse(pageEdited);
    const note = parse(noteUpdated);
    if (page !== null && note !== null) return page > note;
    return true;
  }
  return true;
}

export function metadataUnchanged(mapped: Record<string, unknown>, existing: Record<string, unknown> | null | undefined): boolean {
  if (!existing || typeof existing !== "object") return false;
  return Object.entries(mapped).every(([k, v]) => JSON.stringify(existing[k]) === JSON.stringify(v) && k in existing);
}

export function extractPropertyValue(property: any, propType: string): string {
  switch (propType) {
    case "title":
    case "rich_text": {
      const arr = property?.[propType];
      return Array.isArray(arr) ? arr.map((t: any) => (typeof t?.plain_text === "string" ? t.plain_text : "")).join("") : "";
    }
    case "select":
    case "status":
      return typeof property?.[propType]?.name === "string" ? property[propType].name : "";
    case "multi_select":
      return Array.isArray(property?.multi_select) ? property.multi_select.map((s: any) => s?.name).filter((x: unknown) => typeof x === "string").join(", ") : "";
    case "date":
      return typeof property?.date?.start === "string" ? property.date.start : "";
    case "people":
      return Array.isArray(property?.people) ? property.people.map((p: any) => p?.name).filter((x: unknown) => typeof x === "string").join(", ") : "";
    case "checkbox":
      return property?.checkbox === true ? "true" : "false";
    case "number":
      return typeof property?.number === "number" ? String(property.number) : "";
    case "url":
      return typeof property?.url === "string" ? property.url : "";
    case "relation":
      return Array.isArray(property?.relation) ? property.relation.map((r: any) => r?.id).filter((x: unknown) => typeof x === "string").join(", ") : "";
    default:
      return "";
  }
}

const PASS = new Set(["identity", "date_extract", "people_extract", "relation_to_links"]);

export function applyTransform(value: string, transform: string, valueMap: Record<string, string>): string {
  if (PASS.has(transform)) return value;
  if (transform === "slugify") return slugify(value);
  if (transform === "value_map") return Object.prototype.hasOwnProperty.call(valueMap, value) ? valueMap[value]! : slugify(value);
  return value;
}

export function reverseTransform(value: string, transform: string, valueMap: Record<string, string>): string {
  if (PASS.has(transform)) return value;
  if (transform === "slugify") return titleCase(value);
  if (transform === "value_map") {
    const hit = Object.entries(valueMap).find(([, v]) => v === value);
    return hit ? hit[0] : titleCase(value);
  }
  return value;
}

/** Desktop build_notion_properties: note metadata → Notion property values. */
export function buildNotionProperties(meta: Record<string, unknown>, mappings: PropertyMapping[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const m of mappings) {
    if (!(m.parachuteField in meta)) continue;
    const rawV = meta[m.parachuteField];
    if (rawV === undefined) continue;
    const raw = typeof rawV === "string" ? rawV : JSON.stringify(rawV);
    const v = reverseTransform(raw, m.transform, m.valueMap ?? {});
    let json: unknown;
    switch (m.notionType) {
      case "rich_text":
        json = { rich_text: [{ text: { content: v } }] };
        break;
      case "select":
        json = { select: { name: v } };
        break;
      case "status":
        if (!v) continue;
        json = { status: { name: v } };
        break;
      case "multi_select":
        json = { multi_select: v.split(", ").filter(Boolean).map((s) => ({ name: s.trim() })) };
        break;
      case "date":
        if (!v) continue;
        json = { date: { start: v } };
        break;
      case "checkbox":
        json = { checkbox: v === "true" };
        break;
      case "number": {
        const n = Number(v);
        if (!v.trim() || !Number.isFinite(n)) continue;
        json = { number: n };
        break;
      }
      case "url":
        if (!v) continue;
        json = { url: v };
        break;
      case "relation":
        json = { relation: v.split(", ").filter(Boolean).map((id) => ({ id: id.trim() })) };
        break;
      default:
        continue; // title is separate; people/formula/rollup are read-only
    }
    props[m.notionProperty] = json;
  }
  return props;
}

export function withTitle(titleProp: string, title: string, props: Record<string, unknown>): Record<string, unknown> {
  return { ...props, [titleProp]: { title: [{ text: { content: title } }] } };
}

const WRITABLE = new Set(["rich_text", "select", "status", "multi_select", "date", "checkbox", "number", "url", "relation"]);

/** Does `page` already represent the note? Compared in the VAULT's vocabulary
 *  (each mapped Notion value forward-transformed, as a re-pull would store it),
 *  so a lossy reverse transform (slugify → title case) can never make the push
 *  rename a Notion option on every run. */
export function pageMatchesNote(
  page: any,
  cfg: Pick<NotionDbConfig, "titleProperty" | "propertyMap">,
  meta: Record<string, unknown>,
  title: string,
): boolean {
  const props = page?.properties ?? {};
  if (!props[cfg.titleProperty] || extractPropertyValue(props[cfg.titleProperty], "title") !== title) return false;
  for (const m of cfg.propertyMap) {
    if (!WRITABLE.has(m.notionType) || !(m.parachuteField in meta)) continue;
    const want = meta[m.parachuteField];
    const wantS = typeof want === "string" ? want : JSON.stringify(want);
    const cur = props[m.notionProperty];
    if (!cur) return false;
    const have = applyTransform(extractPropertyValue(cur, m.notionType), m.transform, m.valueMap ?? {});
    if (m.notionType === "number" ? Number(have) !== Number(wantS) : have !== wantS) return false;
  }
  return true;
}

export function extractSelectOptions(prop: any, type: string): string[] {
  if (type !== "select" && type !== "multi_select" && type !== "status") return [];
  const opts = prop?.[type]?.options;
  return Array.isArray(opts) ? opts.map((o: any) => o?.name).filter((x: unknown): x is string => typeof x === "string") : [];
}

export interface PropertySchema {
  name: string;
  propertyType: string;
  options: string[];
}

export function autoDiscoverMappings(schema: PropertySchema[]): PropertyMapping[] {
  const out: PropertyMapping[] = [];
  for (const p of schema) {
    if (p.propertyType === "formula" || p.propertyType === "rollup") continue;
    const lower = p.name.toLowerCase();
    if (p.propertyType === "title" || lower === "name" || lower === "title") continue;
    let field: string;
    let transform: string;
    switch (lower) {
      case "status":
        [field, transform] = ["status", "slugify"];
        break;
      case "priority":
        [field, transform] = ["priority", "slugify"];
        break;
      case "due":
      case "due date":
      case "deadline":
        [field, transform] = ["due", "date_extract"];
        break;
      case "assignee":
      case "assigned":
      case "owner":
        [field, transform] = ["assignee", "people_extract"];
        break;
      case "project":
        [field, transform] = ["project", p.propertyType === "relation" ? "relation_to_links" : "identity"];
        break;
      case "url":
      case "link":
        [field, transform] = ["url", "identity"];
        break;
      case "tags":
      case "labels":
      case "category":
        [field, transform] = ["category", "identity"];
        break;
      default:
        [field, transform] = [slugify(p.name), "identity"];
    }
    out.push({ notionProperty: p.name, notionType: p.propertyType, parachuteField: field, transform, valueMap: {}, relationshipType: null });
  }
  return out;
}

// ── input normalization (desktop + both UI vocabularies) ─────────────────────

export function normDirection(s: unknown): NotionDirection | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "bidirectional" || v === "both") return "bidirectional";
  if (v === "pull" || v === "notion-to-parachute" || v === "notion-to-prism") return "pull";
  if (v === "push" || v === "parachute-to-notion" || v === "prism-to-notion") return "push";
  return null;
}

export function normNotionConflict(s: unknown): NotionConflict | null {
  const v = String(s ?? "").toLowerCase().replace(/_/g, "-");
  if (v === "notion-wins" || v === "notion") return "notion-wins";
  if (v === "parachute-wins" || v === "parachute" || v === "prism" || v === "prism-wins") return "parachute-wins";
  if (v === "newer-wins" || v === "newer") return "newer-wins";
  return null;
}

const TRANSFORM_ALIASES: Record<string, string> = {
  identity: "identity",
  none: "identity",
  slugify: "slugify",
  slug: "slugify",
  value_map: "value_map",
  date_extract: "date_extract",
  "date-iso": "date_extract",
  people_extract: "people_extract",
  relation_to_links: "relation_to_links",
};

const FIELD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Accepts the desktop shape and the old modal's ("metadata.status", "(skip)",
 *  "content", transform "none"/"slug"/…). Returns the mappings plus a content
 *  property picked through a `content` mapping. Invalid rows are dropped. */
export function normalizeMappings(raw: unknown): { mappings: PropertyMapping[]; contentProperty: string | null } {
  const mappings: PropertyMapping[] = [];
  let contentProperty: string | null = null;
  if (!Array.isArray(raw)) return { mappings, contentProperty };
  for (const r of raw.slice(0, 200)) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const notionProperty = String(o.notionProperty ?? o.notion_property ?? "").slice(0, 200);
    const notionType = String(o.notionType ?? o.notion_type ?? o.type ?? "").slice(0, 40);
    let field = String(o.parachuteField ?? o.parachute_field ?? "").trim();
    if (!notionProperty || !notionType || !field || field === "(skip)" || field === "skip") continue;
    if (field === "title") continue; // the title property is configured separately
    if (field === "content") {
      contentProperty = notionProperty;
      continue;
    }
    if (field === "metadata.custom") field = slugify(notionProperty);
    field = field.replace(/^metadata\./, "");
    // Reserved keys (prism_*, gov_*, runner, enabled, skillName, type, …) are what the
    // server's schedulers/governance/sharing read — never writable from Notion (review M4).
    if (!FIELD_RE.test(field) || isReservedMetaKey(field)) continue;
    const transform = TRANSFORM_ALIASES[String(o.transform ?? "identity")] ?? "identity";
    const vm = (o.valueMap ?? o.value_map) as unknown;
    const valueMap: Record<string, string> = {};
    if (vm && typeof vm === "object" && !Array.isArray(vm)) {
      for (const [k, v] of Object.entries(vm as Record<string, unknown>)) if (typeof v === "string") valueMap[k.slice(0, 200)] = v.slice(0, 200);
    }
    const rel = o.relationshipType ?? o.relationship_type;
    mappings.push({ notionProperty, notionType, parachuteField: field, transform, valueMap, relationshipType: typeof rel === "string" ? rel.slice(0, 100) : null });
  }
  return { mappings, contentProperty };
}

export const NOTION_ID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

// ── rate-limited client (api.notion.com ONLY) ────────────────────────────────

type FetchLike = typeof fetch;
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const nextSlot = new Map<string, number>(); // token hash → earliest next request time

export class NotionDbApiError extends Error {
  constructor(
    readonly status: number,
    op: string,
    detail?: string,
  ) {
    super(`notion ${op} → ${status}${detail ? ` (${detail})` : ""}`);
  }
}

export class NotionDbClient {
  private key: string;
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.key = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  }

  private async throttle(): Promise<void> {
    const rps = Number(process.env.NOTION_DB_RPS ?? 3);
    const gap = rps > 0 ? Math.ceil(1000 / rps) : 0;
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(this.key) ?? 0);
    nextSlot.set(this.key, at + gap);
    if (at > now) await this.sleep(at - now);
  }

  private async req(op: string, method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const r = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error",
      });
      if (r.status === 429 && attempt < 3) {
        const ra = Number(r.headers.get("retry-after") ?? "1");
        await this.sleep(Math.min(Math.max(Number.isFinite(ra) ? ra : 1, 0.2), 30) * 1000);
        continue;
      }
      let j: any = null;
      try {
        j = await r.json();
      } catch {
        /* empty */
      }
      if (!r.ok) {
        // Notion's short `code` only — never the message (it can quote the request).
        throw new NotionDbApiError(r.status, op, typeof j?.code === "string" ? j.code.slice(0, 60) : undefined);
      }
      return j;
    }
  }

  async listDatabases(): Promise<Array<{ id: string; title: string; propertyCount: number }>> {
    const out: Array<{ id: string; title: string; propertyCount: number }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body: Record<string, unknown> = { filter: { value: "database", property: "object" }, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const j = await this.req("search", "POST", "/search", body);
      for (const db of Array.isArray(j?.results) ? j.results : []) {
        if (typeof db?.id !== "string") continue;
        const t = Array.isArray(db.title) && typeof db.title[0]?.plain_text === "string" ? db.title[0].plain_text : "Untitled";
        out.push({ id: db.id, title: t, propertyCount: db.properties && typeof db.properties === "object" ? Object.keys(db.properties).length : 0 });
      }
      if (!j?.has_more || typeof j?.next_cursor !== "string") break;
      cursor = j.next_cursor;
    }
    return out;
  }

  async schema(databaseId: string): Promise<PropertySchema[]> {
    if (!NOTION_ID_RE.test(databaseId)) throw new NotionDbApiError(400, "schema", "invalid database id");
    const j = await this.req("schema", "GET", `/databases/${databaseId}`);
    const props = j?.properties && typeof j.properties === "object" ? (j.properties as Record<string, any>) : {};
    return Object.entries(props).map(([name, p]) => {
      const type = typeof p?.type === "string" ? p.type : "unknown";
      return { name, propertyType: type, options: extractSelectOptions(p, type) };
    });
  }

  async queryAll(databaseId: string, maxPages = 100): Promise<any[]> {
    if (!NOTION_ID_RE.test(databaseId)) throw new NotionDbApiError(400, "query", "invalid database id");
    const rows: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const j = await this.req("query", "POST", `/databases/${databaseId}/query`, body);
      rows.push(...(Array.isArray(j?.results) ? j.results : []));
      if (!j?.has_more || typeof j?.next_cursor !== "string") break;
      cursor = j.next_cursor;
    }
    return rows;
  }

  async createPage(databaseId: string, properties: Record<string, unknown>): Promise<string> {
    const j = await this.req("create-page", "POST", "/pages", { parent: { database_id: databaseId }, properties });
    if (typeof j?.id !== "string" || !NOTION_ID_RE.test(j.id)) throw new NotionDbApiError(502, "create-page", "missing id");
    return j.id;
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    if (!NOTION_ID_RE.test(pageId)) throw new NotionDbApiError(400, "update-page", "invalid page id");
    await this.req("update-page", "PATCH", `/pages/${pageId}`, { properties });
  }
}

// ── the sync run ─────────────────────────────────────────────────────────────

export interface NotionDbVault {
  listNotes(opts: { tags?: string[]; pathPrefix?: string; includeContent?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
}

export interface NotionDbSyncResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  /** Rows / notes already identical (no write made). */
  unchanged: number;
  /** Mapped notes/pages left alone: moved out of scope, private, or archived in Notion. */
  skipped: number;
  errors: string[];
}

const underPrefix = (p: string | null, prefix: string) => {
  const base = prefix.replace(/\/+$/, "");
  return !!p && (p === base || p.startsWith(`${base}/`));
};

/** One run (desktop notion_db_sync): pull and/or push per direction. Returns the
 *  updated id map; the caller persists it with lastSynced = the run's start time. */
export async function runNotionDbSync(
  client: NotionDbClient,
  vault: NotionDbVault,
  cfg: NotionDbConfig,
  /** Review M1: notes the config's creator may view (never others' private notes). */
  canView: (n: Note) => boolean = () => true,
): Promise<{ result: NotionDbSyncResult; idMap: Record<string, string> }> {
  const result: NotionDbSyncResult = { created: 0, updated: 0, deleted: 0, conflicts: 0, unchanged: 0, skipped: 0, errors: [] };
  const idMap = { ...cfg.idMap };
  const prevSynced = cfg.lastSynced;
  // Defense in depth for configs stored before the reserved-name rules (review M4).
  const mappings = cfg.propertyMap.filter((m) => !isReservedMetaKey(m.parachuteField));
  const live = (p: any) => p && p.archived !== true && p.in_trash !== true;
  const pages = (await client.queryAll(cfg.databaseId)).filter(live);
  const pageById = new Map<string, any>(pages.filter((p) => typeof p?.id === "string").map((p) => [p.id, p]));
  const pullDirs: NotionDirection[] = ["pull", "bidirectional"];
  const pushDirs: NotionDirection[] = ["push", "bidirectional"];
  // Review M3: with no content property the note BODY is not synced at all —
  // never compared, never written (a mapped note keeps whatever body it has).
  const syncsContent = !!cfg.contentProperty;
  const inScope = (n: Note) => underPrefix(n.path, cfg.pathPrefix) && (n.tags ?? []).includes(cfg.parachuteTag) && canView(n);

  if (pullDirs.includes(cfg.syncDirection)) {
    for (const page of pages) {
      const pageId = page?.id;
      const props = page?.properties;
      if (typeof pageId !== "string" || !props || typeof props !== "object") continue;
      try {
        const title = props[cfg.titleProperty] ? extractPropertyValue(props[cfg.titleProperty], "title") : "Untitled";
        const content = syncsContent && props[cfg.contentProperty!] ? extractPropertyValue(props[cfg.contentProperty!], "rich_text") : "";
        const meta: Record<string, unknown> = { notion_page_id: pageId, title };
        for (const m of mappings) {
          if (props[m.notionProperty]) meta[m.parachuteField] = applyTransform(extractPropertyValue(props[m.notionProperty], m.notionType), m.transform, m.valueMap ?? {});
        }
        const noteId = idMap[pageId];
        if (noteId) {
          let note: Note;
          try {
            note = await vault.getNote(noteId);
          } catch (e) {
            result.errors.push(`Read ${pageId} for conflict check: ${(e as Error).message}`);
            continue;
          }
          // The note left the synced folder/tag, or became someone else's private
          // note, since it was mapped: leave it alone (review Low).
          if (!inScope(note)) {
            result.skipped++;
            continue;
          }
          if ((!syncsContent || note.content === content) && metadataUnchanged(meta, note.metadata)) {
            result.unchanged++;
            continue;
          }
          if (!shouldOverwrite(cfg.conflictStrategy, page.last_edited_time, note.updatedAt, prevSynced)) {
            result.conflicts++;
            continue;
          }
          try {
            await vault.updateNote(noteId, { ...(syncsContent ? { content } : {}), metadata: meta, ...(note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}) });
            result.updated++;
          } catch (e) {
            if (e instanceof VaultConflictError) result.conflicts++;
            else result.errors.push(`Update ${pageId}: ${(e as Error).message}`);
          }
        } else {
          const base = `${cfg.pathPrefix.replace(/\/+$/, "")}/${slugify(title) || "untitled"}`;
          let note: Note;
          try {
            note = await vault.createNote({ content, path: base, metadata: meta, tags: [cfg.parachuteTag] });
          } catch (e) {
            if (!(e instanceof VaultConflictError)) throw e;
            note = await vault.createNote({ content, path: `${base}-${pageId.replace(/-/g, "").slice(0, 8)}`, metadata: meta, tags: [cfg.parachuteTag] });
          }
          idMap[pageId] = note.id;
          result.created++;
        }
      } catch (e) {
        result.errors.push(`Pull ${pageId}: ${(e as Error).message}`);
      }
    }
  }

  if (pushDirs.includes(cfg.syncDirection)) {
    const reverse = new Map(Object.entries(idMap).map(([page, note]) => [note, page] as const));
    const notes = (await vault.listNotes({ tags: [cfg.parachuteTag], pathPrefix: cfg.pathPrefix })).filter(inScope);
    const pushCfg = { ...cfg, propertyMap: mappings };
    for (const note of notes) {
      try {
        const meta = note.metadata && typeof note.metadata === "object" ? note.metadata : {};
        const title = typeof meta.title === "string" ? meta.title : (note.path?.split("/").pop() ?? "Untitled");
        const props = withTitle(cfg.titleProperty, title, buildNotionProperties(meta, mappings));
        const pageId = reverse.get(note.id);
        if (pageId) {
          const page = pageById.get(pageId);
          if (!page) {
            // Archived / trashed / deleted in Notion: not an error, and never re-created.
            result.skipped++;
            continue;
          }
          if (pageMatchesNote(page, pushCfg, meta, title)) {
            result.unchanged++;
            continue;
          }
          if (notionWinsPush(cfg.conflictStrategy, page.last_edited_time, note.updatedAt, prevSynced)) {
            result.conflicts++;
            continue;
          }
          await client.updatePage(pageId, props);
          result.updated++;
        } else {
          const id = await client.createPage(cfg.databaseId, props);
          idMap[id] = note.id;
          result.created++;
        }
      } catch (e) {
        result.errors.push(`Push ${note.id}: ${(e as Error).message}`);
      }
    }
  }
  return { result, idMap };
}

/** Should the push leave a page alone because Notion's edit wins? Only when the
 *  page changed in Notion since the last sync (else the vault edit is the news). */
export function notionWinsPush(strategy: string, pageEdited: string | null | undefined, noteUpdated: string | null | undefined, lastSynced: string): boolean {
  const p = pageEdited ? Date.parse(pageEdited) : NaN;
  const s = lastSynced ? Date.parse(lastSynced) : NaN;
  if (!Number.isFinite(p) || !Number.isFinite(s) || p <= s) return false;
  if (strategy === "notion-wins") return true;
  if (strategy === "newer-wins") {
    const n = noteUpdated ? Date.parse(noteUpdated) : NaN;
    return !Number.isFinite(n) || p > n;
  }
  return false;
}

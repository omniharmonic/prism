/**
 * The vault door: which REST door this server talks to on each vault, and the
 * translation at that door. The ONE place that knows Parachute renamed notes to
 * records.
 *
 * Parachute 0.9.1 adds `/vault/<v>/api/records` beside `/api/notes`, with the record
 * shapes of its MCP tools; `/api/notes` answers through 0.9 and is removed at 1.0
 * (Parachute SPEC v2 §2.1 and §5.1). Inside Prism nothing changes: every module keeps
 * the 0.8 note shape (`content`, `metadata`, `tags` listing every name). This module
 * translates at the edge, both ways:
 *
 *   note shape (inside Prism)           record door (wire)
 *   /notes, /notes/:id/...          →   /records, /records/:id/...
 *   ?include_content ?include_metadata → ?include_body ?include_fields
 *   content, metadata, content_edit →   body, fields, body_edit
 *   notes: [...] (a batch)          →   records: [...]
 *   tags (every name)               →   types (the vault's types) + tags (plain labels)
 *   and back: body→content, fields→metadata, record_id→note_id, tags = types + tags
 *   (`types` is kept on the note, so views can read it: `noteNames` in core).
 *
 * Which door: `PRISM_VAULT_DOOR` = `auto` (default) | `notes` | `records`. `auto` asks
 * the vault (`GET /records?limit=1&include_body=false`): only a 2xx JSON array means the
 * record door; a 404/405 means the note door. Only the first call to a vault waits for
 * that answer. After it the known door is used at once and asked again in the background
 * (a note door hourly, a record door every 10 min, an undecided answer after 30 s), so a
 * vault upgraded or rolled back while Prism runs is followed without blocking anyone.
 * On the note door every request and answer is untouched: a 0.8 vault sees exactly the
 * requests it saw before, plus that probe once an hour.
 *
 * `/api/tags`, storage, attachments' own routes, `subscribe`, `history` are unchanged:
 * they keep answering through 0.9. `/api/types` replaces `/api/tags/<type>` in 0.9.1
 * and is only READ here (for the type names a write must send as `types`).
 */
import { config, type VaultEntry } from "./config";

export type Door = "notes" | "records";
type Target = Pick<VaultEntry, "url" | "vault" | "token">;

/** When a known door is asked again (in the background; nobody waits for it). Translation
 *  is per request, so switching doors mid-run is safe. */
const RECORDS_TTL_MS = 10 * 60_000;
const NOTES_TTL_MS = 60 * 60_000;
/** A probe that could not decide (network, 5xx, 401) is asked again this soon. */
const DOOR_RETRY_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Short: a type removed elsewhere must not be recreated by a write that still names it in `types`. */
const TYPES_TTL_MS = 15_000;

/** A caller's own deadline: it ends that caller's wait, never the shared probe or read. */
export interface Bound {
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

const known = new Map<string, { door: Door; until: number }>();
const probing = new Map<string, Promise<Door>>();
const typeNamesCache = new Map<string, { names: Set<string>; until: number }>();
const readingTypes = new Map<string, Promise<Set<string> | null>>();
/** Bumped by `resetVaultDoors`: an answer started before it is never remembered. */
let generation = 0;
/** Per vault, bumped by `forgetTypeNames`: a type list read before a schema write is not kept. */
const typesGeneration = new Map<string, number>();
/** A note route (relative to `/api`): the only routes the door translates. */
const NOTE_ROUTE = /^\/notes(?=$|[/?#])/;

const keyOf = (t: Target) => `${t.url}/vault/${t.vault}`;

/** The configured mode; anything unknown reads as `auto`. */
export function doorMode(): "auto" | Door {
  const m = String(config.vaultDoor ?? "auto").trim().toLowerCase();
  return m === "notes" || m === "records" ? m : "auto";
}

/** Keep what is known but ask again on the next call (tests: a TTL that ran out). */
export function expireVaultDoors(): void {
  for (const v of known.values()) v.until = 0;
  for (const v of typeNamesCache.values()) v.until = 0;
}

/** Forget every cached door and type list (tests). */
export function resetVaultDoors(): void {
  generation++;
  known.clear();
  probing.clear();
  typeNamesCache.clear();
  readingTypes.clear();
}

/**
 * The door to use for this vault right now. Never throws. A known door is returned at
 * once (when it is due, a probe starts in the background). Only the first call to a vault
 * waits: one probe per vault is in flight, with its own 3 s deadline, and a caller with a
 * shorter deadline (or an abort) stops waiting at it and uses the note door, without
 * changing what the probe will find. An answer that decides nothing (401, 5xx, network)
 * keeps the last known door.
 */
export async function vaultDoor(t: Target, bound: Bound = {}): Promise<Door> {
  const mode = doorMode();
  if (mode !== "auto") return mode;
  const hit = known.get(keyOf(t));
  if (hit) {
    if (hit.until <= Date.now()) void startProbe(t);
    return hit.door;
  }
  return withinBound(startProbe(t), bound, "notes");
}

/** The probe in flight for this vault (tests wait on it). */
export function pendingProbe(t: Target): Promise<Door> | undefined {
  return probing.get(keyOf(t));
}

function startProbe(t: Target): Promise<Door> {
  const key = keyOf(t);
  const hit = known.get(key);
  let p = probing.get(key);
  if (!p) {
    const gen = generation;
    const mine: Promise<Door> = probe(t)
      .then(({ door: found, sure }) => {
        const door = sure || !hit ? found : hit.door;
        if (gen === generation) {
          if (door !== hit?.door && (door === "records" || hit)) console.log(`[vault] ${t.vault}: ${door === "records" ? "record door (/api/records)" : "note door (/api/notes)"}`);
          known.set(key, { door, until: Date.now() + (!sure ? DOOR_RETRY_MS : door === "records" ? RECORDS_TTL_MS : NOTES_TTL_MS) });
        }
        return door;
      })
      .finally(() => {
        if (probing.get(key) === mine) probing.delete(key);
      });
    probing.set(key, mine);
    p = mine;
  }
  return p;
}

async function probe(t: Target): Promise<{ door: Door; sure: boolean }> {
  try {
    const r = await fetch(`${t.url}/vault/${t.vault}/api/records?limit=1&include_body=false`, {
      headers: { Authorization: `Bearer ${t.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    if (r.ok) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { door: "notes", sure: true };
      }
      // The record door's list has /api/notes' shape: a JSON array.
      return { door: Array.isArray(body) ? "records" : "notes", sure: true };
    }
    // 404/405: this vault has no record door. Anything else (401, 5xx) says nothing yet.
    return { door: "notes", sure: r.status === 404 || r.status === 405 };
  } catch {
    return { door: "notes", sure: false };
  }
}

/** The type list could not be read, so a write naming tags could not be split: nothing was sent. */
export class TypeListUnavailable extends Error {
  constructor() {
    super("the vault's type list could not be read; nothing was sent");
  }
}

/**
 * A note-route request (path with its query, and body) at this vault's door: the one
 * place the server client and the owner passthrough turn a request into record words.
 * On the note door everything is returned as given. Throws `TypeListUnavailable` when a
 * write names tags and the vault's types cannot be read.
 */
export async function atDoor<B>(t: Target, pathWithQuery: string, body: B, bound: Bound = {}): Promise<{ translate: boolean; path: string; body: B | string }> {
  const door = await vaultDoor(t, bound);
  const translate = door === "records" && isNotePath(pathWithQuery);
  if (!translate) return { translate, path: pathWithQuery, body };
  const path = doorUrlPath(door, pathWithQuery);
  if (typeof body !== "string") return { translate, path, body };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { translate, path, body }; // not JSON: the vault refuses it as it is
  }
  if (!isObj(parsed)) return { translate, path, body };
  let names: ReadonlySet<string> = NO_NAMES;
  if (namesTags(parsed)) {
    const read = await vaultTypeNames(t, bound);
    if (!read) throw new TypeListUnavailable();
    names = read;
  }
  return { translate, path, body: JSON.stringify(toRecordItem(parsed, names)) };
}
const NO_NAMES: ReadonlySet<string> = new Set();

// ---- requests: note shape → the door ---------------------------------------

/** `/notes…` (relative to `/api`) on the record door is `/records…`; every other path is kept. */
export function doorPath(door: Door, path: string): string {
  return door === "records" ? path.replace(NOTE_ROUTE, "/records") : path;
}

/** Is this path (relative to `/api`) a note route, whose bodies the door translates? */
export function isNotePath(path: string): boolean {
  return NOTE_ROUTE.test(path);
}

const PARAM_NAMES: Record<string, string> = { include_content: "include_body", include_metadata: "include_fields" };

/** A note route's query string (with or without `?`) in the door's parameter names.
 *  Pass `path` to leave every other route's query as it is. */
export function doorSearch(door: Door, search: string, path = "/notes"): string {
  if (door !== "records" || !search || !isNotePath(path)) return search;
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out = new URLSearchParams();
  for (const [k, v] of sp) out.append(PARAM_NAMES[k] ?? k, v);
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** A path with its query (`/notes/x?include_content=false`) at the door. */
export function doorUrlPath(door: Door, pathWithQuery: string): string {
  const i = pathWithQuery.indexOf("?");
  if (i < 0) return doorPath(door, pathWithQuery);
  const path = pathWithQuery.slice(0, i);
  return doorPath(door, path) + doorSearch(door, pathWithQuery.slice(i), path);
}

const BODY_KEYS: Record<string, string> = { content: "body", metadata: "fields", content_edit: "body_edit" };

function splitNames(names: unknown, types: ReadonlySet<string>): { tags: unknown; types: string[] } {
  if (!Array.isArray(names)) return { tags: names, types: [] };
  const t: unknown[] = [];
  const ty: string[] = [];
  for (const n of names) (typeof n === "string" && types.has(n) ? ty : t).push(n);
  return { tags: t, types: ty };
}

/** One note-shaped write item (a create, a PATCH, or one item of a batch) in record words. */
export function toRecordItem(item: unknown, types: ReadonlySet<string>): unknown {
  if (!isObj(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "notes" && Array.isArray(v)) out.records = v.map((x) => toRecordItem(x, types));
    else if (k === "tags") continue; // below, after `types`
    else out[BODY_KEYS[k] ?? k] = v;
  }
  if (!("tags" in item)) return out;
  const tags = item.tags;
  if (Array.isArray(tags)) {
    // A create (or a replace): names that are the vault's types travel as `types`, always
    // beside `tags`, so a replace that drops a type drops it as it did on the note door.
    const s = splitNames(tags, types);
    out.tags = s.tags;
    out.types = uniq([...(Array.isArray(out.types) ? (out.types as string[]) : []), ...s.types]);
  } else if (isObj(tags)) {
    // A PATCH: `{add, remove}` on each.
    const add = splitNames(tags.add, types);
    const remove = splitNames(tags.remove, types);
    const tagOp: Record<string, unknown> = { ...tags };
    if ("add" in tags) tagOp.add = add.tags;
    if ("remove" in tags) tagOp.remove = remove.tags;
    out.tags = tagOp;
    if (add.types.length || remove.types.length) {
      const prev = isObj(out.types) ? out.types : {};
      out.types = {
        ...prev,
        ...(add.types.length ? { add: uniq([...(Array.isArray(prev.add) ? (prev.add as string[]) : []), ...add.types]) } : {}),
        ...(remove.types.length ? { remove: uniq([...(Array.isArray(prev.remove) ? (prev.remove as string[]) : []), ...remove.types]) } : {}),
      };
    }
  } else out.tags = tags;
  return out;
}

// ---- responses: the door → note shape --------------------------------------

/** One record as Prism's note: `body`→`content`, `fields`→`metadata`, `tags` = types + tags. */
export function fromRecord(rec: unknown): unknown {
  if (!isObj(rec)) return rec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "body") out.content = v;
    else if (k === "fields") out.metadata = v;
    else if (k === "body_edit") out.content_edit = v;
    else if (k === "record_id") out.note_id = v;
    else if (k === "body_len") out.content_len = v;
    else out[k] = v;
  }
  // The note door's `tags` lists every name, types first; `types` stays beside it.
  if (Array.isArray(rec.types)) out.tags = uniq([...(rec.types as string[]), ...(Array.isArray(rec.tags) ? (rec.tags as string[]) : [])]);
  return out;
}

/**
 * A record-door JSON answer in note shape: a list of records, one record, a batch
 * (`records` → `notes`), version history (`versions`), and the record a conflict
 * carries (`current`, `record` → `note`). Anything else is returned as it is.
 */
export function fromRecordsBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(fromRecord);
  if (!isObj(body)) return body;
  const out = looksLikeRecord(body) ? (fromRecord(body) as Record<string, unknown>) : { ...body };
  if (Array.isArray(body.records)) {
    delete out.records;
    out.notes = body.records.map(fromRecord);
  }
  if (Array.isArray(body.versions)) out.versions = body.versions.map(fromRecord);
  if (isObj(body.current)) out.current = fromRecord(body.current);
  if (isObj(body.record)) {
    delete out.record;
    out.note = fromRecord(body.record);
  }
  return out;
}

/** A record-door answer's text in note shape (unparseable text is kept). */
export function fromRecordsText(text: string): string {
  if (!text) return text;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(fromRecordsBody(body));
}

// ---- the vault's type names (record door only) -----------------------------

/**
 * The vault's type names, for splitting a write's names into `types` and `tags`
 * (the record door refuses a type's name in `tags`). From `GET /types`; when that
 * cannot be read, from `GET /tags` rows that say `kind: "type"`. Cached for a minute
 * (`forgetTypeNames` after a write that may change it); one read in flight per vault.
 * `null` when neither can be read and nothing is known: the caller must not guess.
 */
export async function vaultTypeNames(t: Target, bound: Bound = {}): Promise<Set<string> | null> {
  const key = keyOf(t);
  const hit = typeNamesCache.get(key);
  if (hit && hit.until > Date.now()) return hit.names;
  let p = readingTypes.get(key);
  if (!p) {
    const gen = generation;
    const keyGen = typesGeneration.get(key) ?? 0;
    const mine: Promise<Set<string> | null> = (async () => {
      const names = (await readNames(t, "/types", false)) ?? (await readNames(t, "/tags", true));
      if (names && gen === generation && keyGen === (typesGeneration.get(key) ?? 0)) typeNamesCache.set(key, { names, until: Date.now() + TYPES_TTL_MS });
      // Unreadable now: a list read before is still the best answer; else none.
      return names ?? hit?.names ?? null;
    })().finally(() => {
      if (readingTypes.get(key) === mine) readingTypes.delete(key);
    });
    readingTypes.set(key, mine);
    p = mine;
  }
  return withinBound(p, bound, hit?.names ?? null);
}

/** Does this note-route body (or an item of its batch) carry `tags`? Only then are the
 *  type names needed. A field called `tags` inside `metadata` does not count. */
export function namesTags(body: Record<string, unknown>): boolean {
  if ("tags" in body) return true;
  return Array.isArray(body.notes) && body.notes.some((n) => isObj(n) && "tags" in n);
}

/** After a write that may change which names are types: drop the list, and never keep
 *  one that was being read while the write happened. */
export function forgetTypeNames(t: Target): void {
  const key = keyOf(t);
  typesGeneration.set(key, (typesGeneration.get(key) ?? 0) + 1);
  typeNamesCache.delete(key);
  readingTypes.delete(key);
}

async function readNames(t: Target, path: string, onlyTypes: boolean): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${t.url}/vault/${t.vault}/api${path}`, { headers: { Authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const body: unknown = await r.json();
    const rows: unknown[] = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.types) ? body.types : [];
    const out = new Set<string>();
    for (const row of rows) {
      if (typeof row === "string") {
        if (!onlyTypes) out.add(row);
      } else if (isObj(row)) {
        const name = typeof row.name === "string" ? row.name : typeof row.tag === "string" ? row.tag : null;
        // A row that says what it is counts only as a type; `/types` rows that say nothing
        // are types. (One list of types AND tags, each with its `kind`, is list-types' shape.)
        if (name && (row.kind === "type" || (!onlyTypes && row.kind === undefined))) out.add(name);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** A write to these paths (relative to `/api`) may change which names are types. */
export function changesTypes(path: string): boolean {
  return /^\/(types|tags)(?=$|[/?])/.test(path);
}

// ---- small helpers ----------------------------------------------------------

/** `p`, or `fallback` once the caller's own deadline (`timeoutMs`, `signal`) passes first. */
function withinBound<T>(p: Promise<T>, bound: Bound, fallback: T): Promise<T> {
  const ms = bound.timeoutMs && bound.timeoutMs > 0 ? bound.timeoutMs : 0;
  const signal = bound.signal ?? null;
  if (!ms && !signal) return p;
  if (signal?.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (v: T) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => done(fallback);
    if (ms) timer = setTimeout(() => done(fallback), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(done, () => done(fallback));
  });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One record, or one version row of one (`record_id` + `version_ix`, no `id`). */
function looksLikeRecord(o: Record<string, unknown>): boolean {
  if ("record_id" in o || "version_ix" in o) return true;
  return typeof o.id === "string" && ("body" in o || "fields" in o || "types" in o || "tags" in o);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

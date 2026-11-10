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
 * the vault once (`GET /records?limit=1&include_body=false`, the answer cached): only a
 * 2xx JSON list means the record door; a 404 or anything else means the note door. On
 * the note door every function here returns its input untouched, so a 0.8 vault sees
 * exactly the requests it saw before (plus that one probe).
 *
 * `/api/tags`, storage, attachments' own routes, `subscribe`, `history` are unchanged:
 * they keep answering through 0.9. `/api/types` replaces `/api/tags/<type>` in 0.9.1
 * and is only READ here (for the type names a write must send as `types`).
 */
import { config, type VaultEntry } from "./config";

export type Door = "notes" | "records";
type Target = Pick<VaultEntry, "url" | "vault" | "token">;

/** How long a probe's answer is trusted. A vault upgraded (or rolled back) while Prism
 *  runs is seen within this time; translation is per request, so switching is safe. */
const DOOR_TTL_MS = 10 * 60_000;
/** A probe that could not decide (network, 5xx, 401) is asked again this soon. */
const DOOR_RETRY_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const TYPES_TTL_MS = 60_000;
/** A type list that could not be read is asked for again this soon. */
const TYPES_RETRY_MS = 5_000;

const known = new Map<string, { door: Door; until: number }>();
const probing = new Map<string, Promise<Door>>();
const typeNamesCache = new Map<string, { names: Set<string>; until: number }>();
const readingTypes = new Map<string, Promise<Set<string>>>();

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

/** Forget every cached door and type list (tests; a vault registry change). */
export function resetVaultDoors(): void {
  known.clear();
  probing.clear();
  typeNamesCache.clear();
  readingTypes.clear();
}

/**
 * The door to use for this vault right now. Never throws: an undecided probe is the
 * note door. The probe is bounded by the caller's own deadline (`timeoutMs`, `signal`)
 * as well as its own, so a bounded vault call stays bounded.
 */
export async function vaultDoor(t: Target, bound: { timeoutMs?: number; signal?: AbortSignal | null } = {}): Promise<Door> {
  const mode = doorMode();
  if (mode !== "auto") return mode;
  const key = keyOf(t);
  const hit = known.get(key);
  if (hit && hit.until > Date.now()) return hit.door;
  let p = probing.get(key);
  if (!p) {
    p = probe(t, bound)
      .then(({ door: found, sure }) => {
        // An answer that decides nothing (401, 5xx, network, a caller's deadline) keeps the
        // last known door: a record-door vault must not drop to /api/notes for a hiccup.
        const door = sure || !hit ? found : hit.door;
        if (door !== hit?.door && (door === "records" || hit)) console.log(`[vault] ${t.vault}: ${door === "records" ? "record door (/api/records)" : "note door (/api/notes)"}`);
        known.set(key, { door, until: Date.now() + (sure ? DOOR_TTL_MS : DOOR_RETRY_MS) });
        return door;
      })
      .finally(() => probing.delete(key));
    probing.set(key, p);
  }
  return p;
}

async function probe(t: Target, bound: { timeoutMs?: number; signal?: AbortSignal | null }): Promise<{ door: Door; sure: boolean }> {
  try {
    const r = await fetch(`${t.url}/vault/${t.vault}/api/records?limit=1&include_body=false`, {
      headers: { Authorization: `Bearer ${t.token}` },
      signal: boundSignal(bound),
    });
    const text = await r.text().catch(() => "");
    if (r.ok) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { door: "notes", sure: true };
      }
      const list = Array.isArray(body) || (isObj(body) && Array.isArray(body.records));
      return { door: list ? "records" : "notes", sure: true };
    }
    // 404/405: this vault has no record door. Anything else (401, 5xx) says nothing yet.
    return { door: "notes", sure: r.status === 404 || r.status === 405 };
  } catch {
    return { door: "notes", sure: false };
  }
}

// ---- requests: note shape → the door ---------------------------------------

/** `/notes…` (relative to `/api`) on the record door is `/records…`; every other path is kept. */
export function doorPath(door: Door, path: string): string {
  return door === "records" ? path.replace(/^\/notes(?=$|[/?#])/, "/records") : path;
}

/** Is this path (relative to `/api`) a note route, whose bodies the door translates? */
export function isNotePath(path: string): boolean {
  return /^\/notes(?=$|[/?#])/.test(path);
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

/** A note-route JSON body string in record words. Not JSON (or not an object): sent as it is. */
export function toRecordJson(raw: string, types: ReadonlySet<string>): string {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }
  return isObj(body) ? JSON.stringify(toRecordItem(body, types)) : raw;
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
 * cannot be read, from `GET /tags` rows that say `kind: "type"`. Cached briefly;
 * `forgetTypeNames` after a write that may change the list.
 */
export async function vaultTypeNames(t: Target, bound: { timeoutMs?: number; signal?: AbortSignal | null } = {}): Promise<Set<string>> {
  const key = keyOf(t);
  const hit = typeNamesCache.get(key);
  if (hit && hit.until > Date.now()) return hit.names;
  let p = readingTypes.get(key);
  if (!p) {
    p = (async () => {
      const names = (await readNames(t, "/types", false, bound)) ?? (await readNames(t, "/tags", true, bound));
      // A list that could not be read is not remembered for long: the next write asks again.
      typeNamesCache.set(key, { names: names ?? hit?.names ?? new Set<string>(), until: Date.now() + (names ? TYPES_TTL_MS : TYPES_RETRY_MS) });
      return names ?? hit?.names ?? new Set<string>();
    })().finally(() => readingTypes.delete(key));
    readingTypes.set(key, p);
  }
  return p;
}

/** Does this note-route JSON body name any tags (only then are the type names needed)? */
export function namesTags(raw: string): boolean {
  return raw.includes('"tags"');
}

export function forgetTypeNames(t: Target): void {
  typeNamesCache.delete(keyOf(t));
}

async function readNames(t: Target, path: string, onlyTypes: boolean, bound: { timeoutMs?: number; signal?: AbortSignal | null }): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${t.url}/vault/${t.vault}/api${path}`, { headers: { Authorization: `Bearer ${t.token}` }, signal: boundSignal(bound) });
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
        if (name && (!onlyTypes || row.kind === "type")) out.add(name);
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

/** Our own short deadline, shortened further by the caller's (`timeoutMs`, `signal`). */
function boundSignal(bound: { timeoutMs?: number; signal?: AbortSignal | null }): AbortSignal {
  const ms = bound.timeoutMs && bound.timeoutMs > 0 ? Math.min(bound.timeoutMs, PROBE_TIMEOUT_MS) : PROBE_TIMEOUT_MS;
  return bound.signal ? AbortSignal.any([AbortSignal.timeout(ms), bound.signal]) : AbortSignal.timeout(ms);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function looksLikeRecord(o: Record<string, unknown>): boolean {
  return typeof o.id === "string" && ("body" in o || "fields" in o || "types" in o || "tags" in o);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

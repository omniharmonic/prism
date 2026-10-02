/**
 * A short-lived, per-vault cache of the lean `person` listing (identity keys +
 * links, never content) shared by the identity routes — the duplicates page,
 * every resolve, the owner routes — so paging through duplicates or resolving
 * ten candidates is one vault listing, not ten. 60 s TTL; this module's own
 * writers (job, merge, resolve, owner) invalidate it. Callers get a deep copy.
 */
import type { Note } from "./parachute";

const TTL_MS = 60_000;
interface Entry {
  at: number;
  notes: Note[];
  gen: number;
  derived: Map<string, unknown>;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
let generation = 0;

async function entry(vaultId: string, load: () => Promise<Note[]>, fresh: boolean): Promise<Entry> {
  const hit = cache.get(vaultId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;
  const running = inflight.get(vaultId);
  if (running && !fresh) return running;
  const p = load().then((notes) => {
    const e: Entry = { at: Date.now(), notes: notes.filter((n) => (n.tags ?? []).includes("person")), gen: ++generation, derived: new Map() };
    cache.set(vaultId, e);
    return e;
  });
  inflight.set(vaultId, p);
  try {
    return await p;
  } finally {
    if (inflight.get(vaultId) === p) inflight.delete(vaultId);
  }
}

/** The person listing (a private copy). `fresh` bypasses and refills the cache. */
export async function cachedPeople(vaultId: string, load: () => Promise<Note[]>, opts: { fresh?: boolean } = {}): Promise<Note[]> {
  return structuredClone((await entry(vaultId, load, !!opts.fresh)).notes);
}

/** A value derived from the cached listing (e.g. the duplicate pairs), computed once per listing. */
export async function cachedDerived<T>(vaultId: string, load: () => Promise<Note[]>, key: string, compute: (people: Note[]) => T): Promise<T> {
  const e = await entry(vaultId, load, false);
  if (!e.derived.has(key)) e.derived.set(key, compute(structuredClone(e.notes)));
  return e.derived.get(key) as T;
}

export function invalidatePeople(vaultId?: string): void {
  if (vaultId) cache.delete(vaultId);
  else cache.clear();
}

/** Test-only reset. */
export const _resetPeopleCache = (): void => invalidatePeople();

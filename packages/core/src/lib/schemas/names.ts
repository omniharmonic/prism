/**
 * The names a note answers to. Parachute 0.9 gives each note `types` (names with
 * fields: what the note IS) beside `tags` (plain labels). Through 0.9 the vault's
 * `tags` still lists every name, types included; from the record door on, `tags`
 * holds only plain labels. Views and boards read both, so a note keeps its kind and
 * its databases whichever the vault sends. A 0.8 note has no `types`: these return
 * its tags exactly as before.
 */
export interface Named {
  tags?: string[] | null;
  types?: string[] | null;
}

/** Every name: types first, then tags, each once. With no `types`, the tags as they are. */
export function noteNames(note: Named): string[] {
  const tags = note.tags ?? [];
  const types = note.types;
  if (!types || types.length === 0) return tags;
  return [...new Set([...types, ...tags])];
}

/** Does the note answer to `name` (as a type or a tag)? */
export function hasName(note: Named, name: string): boolean {
  return (note.types ?? []).includes(name) || (note.tags ?? []).includes(name);
}

/**
 * The first entry of `table` (in its own order) that names one of the note's TYPES,
 * else the first that names one of its tags. Kind comes from what a note is before
 * what it is labelled with; on a 0.8 note (no types) this is the old tag scan.
 */
export function typeFirst<T>(note: Named, table: ReadonlyArray<readonly [string, T]>): readonly [string, T] | null {
  for (const names of [note.types, note.tags]) {
    if (!names || names.length === 0) continue;
    const set = new Set(names);
    for (const row of table) if (set.has(row[0])) return row;
  }
  return null;
}

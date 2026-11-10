/**
 * The names a note answers to. Parachute 0.9 gives each note `types` (names with
 * fields: what the note IS) beside `tags` (plain labels). Through 0.9 the vault's
 * `tags` still lists every name, types included (and Prism's vault door keeps it so
 * on the record door); at 1.0 `tags` holds only plain labels. Views and boards read
 * both, so a note keeps its kind and its databases whichever the vault sends. A 0.8
 * note has no `types`: these return what its tags alone returned before.
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
  return (note.tags ?? []).includes(name) || (note.types ?? []).includes(name);
}

/**
 * The first entry of `table` (in the table's own order) that names one of the note's
 * names, types and tags alike. The table's order decides, never which list a name came
 * in: a note's kind must not change with whether `types` was sent (the tree projection
 * and 0.8 notes carry none), because a collab document whose kind flips is stored
 * through the wrong path.
 */
export function firstNamed<T>(note: Named, table: ReadonlyArray<readonly [string, T]>): readonly [string, T] | null {
  const names = noteNames(note);
  if (names.length === 0) return null;
  const set = new Set(names);
  for (const row of table) if (set.has(row[0])) return row;
  return null;
}

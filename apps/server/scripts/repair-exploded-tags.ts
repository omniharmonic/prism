/**
 * Repair notes whose tag ARRAY was written as a STRING and split per character
 * (audit 2026-08-13, F7).
 *
 * Symptom: 41 notes carry tags like `"`, `[`, `]`, `,`, `-`, ` ` and 29 single
 * letters — the characters of a serialized `["agent-dispatch", ...]`. Their real
 * tags are gone, so they are invisible to every tag query, dashboard and filter,
 * even though they still render correctly (their `metadata.type` survived).
 *
 * Repair: drop every junk tag, and restore the structural tag from the note's own
 * `metadata.type`, which is the surviving record of what it was. Legitimate
 * multi-character tags on the same note are left alone.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *   node --env-file=.env --import tsx scripts/repair-exploded-tags.ts [--apply]
 */
import { vault } from "../src/parachute";
import tagSchemas from "../../../packages/core/src/lib/schemas/tag-schemas.json";

const APPLY = process.argv.includes("--apply");

/** A tag that is debris from the per-character split, not a real tag. A real tag
 *  is >1 char and is not pure punctuation. Single-letter tags cannot be recovered
 *  as anything meaningful, and none exist legitimately in this vault. */
function isJunkTag(t: string | null | undefined): boolean {
  if (t == null) return true;
  if (t.trim() === "") return true;
  if (t.length === 1) return true;
  return false;
}

/**
 * The vocabulary we are willing to restore into. A `metadata.type` earns a tag
 * only if that tag is ALREADY REAL — either canonical (declared in
 * tag-schemas.json) or established in this vault (other, healthy notes use it).
 *
 * The conservative half matters: for a type like "signature" or "response" that
 * no other note tags with, restoring it would INVENT vocabulary rather than
 * recover it. We cannot prove what the exploded array said, so those notes get
 * their junk cleaned and keep rendering off `metadata.type` — reported, not
 * guessed at.
 */
async function buildRestoreVocabulary(): Promise<Set<string>> {
  const canonical = Object.keys(
    (tagSchemas as unknown as { tags: Record<string, unknown> }).tags,
  );
  const live = (await vault.getTags())
    .filter((t) => t.tag && t.tag.length > 1 && t.count > 0)
    .map((t) => t.tag);
  return new Set([...canonical, ...live]);
}

async function main() {
  const vocabulary = await buildRestoreVocabulary();
  const notes = await vault.listNotes({});
  const broken = notes.filter((n) => (n.tags ?? []).some(isJunkTag));

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${broken.length} note(s) with exploded tags\n`);
  if (broken.length === 0) {
    console.log("nothing to repair");
    return;
  }

  let repaired = 0;
  let unrecoverable = 0;
  const junkSeen = new Set<string>();

  for (const n of broken) {
    const tags = n.tags ?? [];
    const junk = tags.filter(isJunkTag);
    const keep = tags.filter((t) => !isJunkTag(t));
    junk.forEach((t) => junkSeen.add(t));

    const type = (n.metadata as Record<string, unknown> | null)?.type;
    const restore = typeof type === "string" && vocabulary.has(type) ? type : undefined;
    const add = restore && !keep.includes(restore) ? [restore] : [];

    if (!restore) unrecoverable++;
    console.log(
      `${n.path}\n` +
        `   type=${String(type)}  junk=${junk.length}  keep=[${keep.join(", ")}]  ` +
        `restore=${add.length ? add.join(",") : "(none — type names no known tag)"}`,
    );

    if (APPLY) {
      // Add first, so the note is never momentarily tagless (a tagless note falls
      // out of every tag query, and this runs against the live vault).
      if (add.length) await vault.addTags(n.id, add);
      await vault.removeTags(n.id, junk);
      repaired++;
    }
  }

  console.log(`\njunk tag values encountered (${junkSeen.size}): ${[...junkSeen].sort().map((t) => JSON.stringify(t)).join(" ")}`);
  console.log(`notes left without a structural tag (metadata.type names no established tag — not invented): ${unrecoverable}`);
  console.log(APPLY ? `\n✓ repaired ${repaired} note(s)` : `\n(dry run — re-run with --apply to write)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Classification regression check (audit finding F1, 2026-08-13).
 *
 * Replays EVERY note in the live vault through the real `inferContentType()` and
 * asserts the routing is correct — specifically that a note's structural tag is
 * no longer beaten by an unrecognized `metadata.type`.
 *
 * The old step 1b returned "document" for any metadata.type not in KNOWN_TYPES,
 * short-circuiting before tag inference. That sent 715 notes tagged `task` to the
 * DocumentRenderer. This script re-implements the OLD rule alongside the current
 * one so the delta is explicit and reviewable, and fails if any note moves in a
 * direction we did not intend (i.e. away from its structural tag).
 *
 * Run: node --env-file=.env --import tsx scripts/verify-classification.ts
 */
import { inferContentType } from "../../../packages/core/src/lib/schemas/content-types";
import { vault, type Note } from "../src/parachute";
import tagSchemas from "../../../packages/core/src/lib/schemas/tag-schemas.json";

const KNOWN_TYPES = new Set<string>([
  "document", "note", "presentation", "code", "email",
  "message-thread", "task-board", "task", "event",
  "project", "spreadsheet", "website", "canvas", "briefing",
  "dashboard", "messages-dashboard",
]);

const TAG_ORDER: Array<[string, string]> = Object.entries(
  (tagSchemas as unknown as { tags: Record<string, { contentType: string; precedence: number }> }).tags,
)
  .sort(([, a], [, b]) => a.precedence - b.precedence)
  .map(([tag, e]) => [tag, e.contentType]);

/** The pre-fix rule, kept verbatim so the delta is provable rather than asserted. */
function inferContentTypeOld(note: Note): string {
  const meta = note.metadata;
  if (meta && typeof meta.prism_type === "string" && KNOWN_TYPES.has(meta.prism_type)) return meta.prism_type;
  if (meta && typeof meta.type === "string") {
    if (KNOWN_TYPES.has(meta.type)) return meta.type;
    if (meta.type.length > 0) return "document"; // ← the short-circuit being fixed
  }
  const tags = new Set(note.tags ?? []);
  for (const [tag, ct] of TAG_ORDER) if (tags.has(tag)) return ct;
  return "document";
}

/** The structural type a note's own tags claim, independent of metadata. */
function tagType(note: Note): string | null {
  const tags = new Set(note.tags ?? []);
  for (const [tag, ct] of TAG_ORDER) if (tags.has(tag)) return ct;
  return null;
}

async function main() {
  const notes = await vault.listNotes({ limit: 50_000 });
  console.log(`replaying ${notes.length} notes\n`);

  const moved: Array<{ note: Note; from: string; to: string }> = [];
  const regressions: string[] = [];

  for (const n of notes) {
    // The real function, exactly as the renderers call it. Content is omitted
    // here (the lean list payload has none) — same as Canvas.tsx's tab path.
    const now = inferContentType(n);
    const before = inferContentTypeOld(n);
    if (now === before) continue;
    moved.push({ note: n, from: before, to: now });

    // The ONLY movement we sanction: toward the note's own structural tag.
    const claimed = tagType(n);
    if (now !== claimed) {
      regressions.push(`${n.id} (${n.path}): ${before} → ${now}, but its tags claim ${claimed ?? "nothing"}`);
    }
  }

  const byTarget = new Map<string, number>();
  for (const m of moved) byTarget.set(m.to, (byTarget.get(m.to) ?? 0) + 1);

  console.log(`notes whose renderer changed: ${moved.length}`);
  for (const [ct, n] of [...byTarget].sort((a, b) => b[1] - a[1])) {
    console.log(`  → ${ct.padEnd(14)} ${n}`);
  }

  console.log("\nsample (5):");
  for (const m of moved.slice(0, 5)) {
    console.log(`  ${m.from} → ${m.to}  ${m.note.path}  tags=[${(m.note.tags ?? []).join(", ")}] type=${(m.note.metadata as Record<string, unknown>)?.type}`);
  }

  // Nothing may move AWAY from a structural tag, and nothing may lose a renderer.
  if (regressions.length) {
    console.error(`\n✗ ${regressions.length} unsanctioned move(s):`);
    for (const r of regressions.slice(0, 20)) console.error(`   ${r}`);
    process.exit(1);
  }

  // Every note must still resolve to something renderable.
  const unresolved = notes.filter((n) => !inferContentType(n));
  if (unresolved.length) {
    console.error(`\n✗ ${unresolved.length} note(s) resolved to no content type`);
    process.exit(1);
  }

  console.log(`\n✓ every changed note moved TO its own structural tag's renderer`);
  console.log(`✓ all ${notes.length} notes resolve to a renderer`);
  console.log("\nCLASSIFICATION CHECK PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

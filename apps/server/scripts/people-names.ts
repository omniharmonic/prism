/**
 * Person notes without a usable display name (src/person-name.ts) — a READ-ONLY report, plus the
 * repair the owner approved: a person note with NO `metadata.name` gets `metadata.name` = the name its
 * heading gives. Never `metadata.title` (job titles live there), never a body, never a name made from
 * the path alone, never a tombstone or a non-human note (src/people-name-repair.ts).
 *
 * Report (default): counts per problem + the note IDS (never a name, a path or any content):
 *   no-name-field      metadata.name is missing / unusable (the display name comes from the heading or path)
 *   markup-in-field    metadata.name holds HTML or markdown (reported; not rewritten)
 *   markup-in-display  the vault's displayTitle is raw HTML (what used to show as a contact title)
 *   no-name-at-all     nothing usable anywhere
 *
 *   node --env-file=.env --import tsx scripts/people-names.ts [--vault <id>] [--ids]
 *   node --env-file=.env --import tsx scripts/people-names.ts --repair              # dry run
 *   node --env-file=.env --import tsx scripts/people-names.ts --repair --apply [--limit N] [--pace-ms 500]
 *   node --env-file=.env --import tsx scripts/people-names.ts --undo <batchId | undo-log.json> [--pace-ms 500]
 *
 * Apply: batch id nr_…, undo log ~/.prism/people-names/<batchId>.json (0600; an intent entry is saved
 * before each write), compare-and-set on a fresh read, each write read back, paced. Re-running skips
 * notes that now have a name. --undo removes the name only where it is still exactly what was written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TREE_SUBSCRIBE = "0";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const { vaultRegistry, config } = await import("../src/config");
  const { vaultClient } = await import("../src/parachute");
  const repair = await import("../src/people-name-repair");
  const { recordAction } = await import("../src/actions/store");
  const vaultId = arg("vault") ?? vaultRegistry[0]!.id;
  const vault = vaultClient(vaultId, { timeoutMs: 30_000 });
  const paceMs = Math.max(0, Number(arg("pace-ms") ?? 500) || 0);
  const dir = path.join(os.homedir(), ".prism", "people-names");
  const audit = (op: string, target: Record<string, unknown>, failed: boolean) =>
    recordAction({ actorEmail: config.ownerEmail, via: "cli", origin: "human", action: `people.name-repair-${op}`, vaultId, target, idempotencyKey: null, status: failed ? "failed" : "ok", error: null });

  if (arg("undo")) {
    const ref = arg("undo")!;
    const log = repair.readRepairLog(/^nr_[0-9a-z_]+$/.test(ref) ? path.join(dir, `${ref}.json`) : path.resolve(ref));
    if (log.vaultId !== vaultId) throw new Error(`the undo log is for vault "${log.vaultId}"`);
    const out = await repair.undoNameRepair(vault, log, { paceMs });
    console.log(`undo ${log.batchId}: ${JSON.stringify(out)}  (changed = edited since the repair: left as it is)`);
    audit("undo", { batchId: log.batchId, ...out }, out.failed > 0);
    return out.failed ? 1 : 0;
  }

  const { notes, problems, todo } = await repair.surveyNames(vault, { paceMs: Math.min(paceMs, 200) });
  console.log(`person notes: ${notes.length}`);
  for (const p of ["no-name-field", "markup-in-field", "markup-in-display", "no-name-at-all"]) {
    const ids = problems.get(p) ?? [];
    console.log(`  ${p.padEnd(18)} ${ids.length}`);
    if (flag("ids") && ids.length) console.log(`    ${ids.join(" ")}`);
  }
  if (!flag("repair")) {
    console.log(`\n(read-only; --ids prints the ids, --repair shows what the repair would set)`);
    return 0;
  }
  const limit = arg("limit") !== undefined ? Math.max(0, Number(arg("limit")) || 0) : todo.length;
  console.log(`\nrepair: ${todo.length} note(s) have no metadata.name and would get one from their heading or path${flag("apply") ? ` (this run: at most ${limit})` : " (dry run — add --apply)"}`);
  // The exact list, for the owner to read before --apply (names: the owner's own machine only).
  for (const r of todo.slice(0, limit)) console.log(`  ${r.note.id} → ${r.name}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const proposed = path.join(dir, "proposed.json");
  fs.writeFileSync(proposed, JSON.stringify(todo.map((r) => ({ id: r.note.id, name: r.name })), null, 1), { mode: 0o600 });
  console.log(`(the same list: ${proposed}, 0600 — never into a repository)`);
  if (!flag("apply")) return 0;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const batchId = `nr_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
  const logPath = path.join(dir, `${batchId}.json`);
  const log = { batchId, vaultId, at: new Date().toISOString(), entries: [] };
  const save = (l: unknown) => fs.writeFileSync(logPath, JSON.stringify(l, null, 1), { mode: 0o600 });
  save(log);
  const out = await repair.applyNameRepair(vault, todo, log, { save, paceMs, limit });
  console.log(`repair ${batchId}: ${JSON.stringify(out)}\nundo log: ${logPath}\nundo with: --undo ${batchId}`);
  audit("apply", { batchId, ...out }, out.failed > 0);
  return out.failed ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Batch contact tidy for Comms' "People to Tidy" (src/comms/tidy-batch.ts has the rules).
 *
 *   A  strong key held by exactly one person      → link (the tidy route's own write, compare-and-set)
 *   B  new, frequent two-way contact, real name   → create a person note (source "comms-tidy") + link
 *   C  ambiguous key / same name as people        → a question in Prism's people review queue (no person write)
 *   D  the rest                                   → left alone (or ignored with --ignore-low)
 * A and B also give each of the counterpart's DM message-thread notes a `messages-with` edge to the
 * person (links-only writes — never a body, metadata or title — compare-and-set, each re-read to
 * verify, recorded for undo). Persons are never merged.
 *
 * DRY RUN BY DEFAULT: prints counts per tier and per network and a sample of
 * "display name → person" pairs (names only), and writes the plan file. Nothing else is written.
 *
 *   node --env-file=.env --import tsx scripts/comms-batch-tidy.ts [--dry-run] [--plan <file>]
 *        [--min-total 10] [--min-owner 3] [--dm-min-owner 3] [--ignore-low] [--sample 20]
 *        [--promote-exact-names] [--exclude-name "<display name>" …] [--skip-network <net> …] [--allow-email]
 *   node --env-file=.env --import tsx scripts/comms-batch-tidy.ts --apply [--plan <file>]
 *        [--pace-ms 1000] [--limit N (default 200, max 1000 per run)] [--max-writes N] [--max-age-hours 24]
 *   node --env-file=.env --import tsx scripts/comms-batch-tidy.ts --undo <batchId> [--pace-ms 1000]
 *   node --env-file=.env --import tsx scripts/comms-batch-tidy.ts --status <batchId>
 *
 * --apply executes the plan file EXACTLY: its hash is checked, and a fresh plan is computed — if any
 * entry not yet done would now be decided differently the apply refuses (exit 3; run the dry run
 * again). Resumable: re-running --apply with the same plan skips what this batch already did.
 * Rate-limited: --pace-ms between vault writes; --limit N acts on at most N entries per run.
 * Every action is a comms_tidy_actions row with the batch id; --undo <batchId> undoes them all
 * (newest first, refusing anything edited since — reported, never overwritten).
 *
 * Runs on the server host against the server's database and vault (the server's .env). The plan
 * file holds names and handles: it is written 0600 under ~/.prism/comms-batch-tidy/ by default and
 * must never go into a repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TREE_SUBSCRIBE = "0"; // no vault socket from a CLI

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** Every value of a repeatable flag (`--exclude-name "A" --exclude-name "B"`). */
const argsOf = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
const num = (name: string, def: number): number => {
  const v = arg(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number ≥ 0`);
  return n;
};

const DEFAULT_PER_RUN = 200;
const MAX_PER_RUN = 1000;
const DEFAULT_DIR = path.join(os.homedir(), ".prism", "comms-batch-tidy");
const planPath = path.resolve(arg("plan") ?? path.join(DEFAULT_DIR, "plan.json"));

async function main(): Promise<number> {
  const { config, vaultRegistry } = await import("../src/config");
  const batch = await import("../src/comms/tidy-batch");
  const { recordAction } = await import("../src/actions/store");
  const vaultId = arg("vault") ?? vaultRegistry[0]!.id;
  const actor = { email: config.ownerEmail, via: "cli:comms-batch-tidy" };
  const audit = (op: string, target: Record<string, unknown>, status: "ok" | "failed" | "refused", error?: string) =>
    recordAction({ actorEmail: config.ownerEmail, via: "cli", origin: "human", action: `comms.tidy.batch-${op}`, vaultId, target, idempotencyKey: null, status, error: error ?? null });
  const paceMs = num("pace-ms", 1000);

  if (arg("status")) {
    const { db } = await import("../src/db");
    const rows = db.prepare(`SELECT kind, COUNT(*) AS n, SUM(undone_at IS NOT NULL) AS u FROM comms_tidy_actions WHERE batch_id = ? GROUP BY kind`).all(arg("status")) as { kind: string; n: number; u: number }[];
    console.log(`batch ${arg("status")}:`);
    for (const r of rows) console.log(`  ${r.kind.padEnd(10)} ${r.n} (undone ${r.u})`);
    if (!rows.length) console.log("  no actions");
    return 0;
  }

  if (arg("undo")) {
    const batchId = arg("undo")!;
    if (!/^tb_[0-9a-f]{16}$/.test(batchId)) throw new Error("--undo takes a batch id (tb_ + 16 hex)");
    console.log(`UNDO batch ${batchId} (pace ${paceMs} ms)`);
    const r = await batch.undoBatch(vaultId, batchId, { paceMs, log: (l) => console.log(`  ${l}`) });
    console.log(`undone:   ${JSON.stringify(r.undone)}`);
    console.log(`refused:  ${JSON.stringify(r.refused)}  (edited since / already decided — left as they are)`);
    console.log(`already undone: ${r.alreadyUndone}`);
    audit("undo", { batchId, undone: r.undone, refused: r.refused }, Object.keys(r.refused).length ? "failed" : "ok");
    return 0;
  }

  if (flag("apply")) {
    const raw = JSON.parse(fs.readFileSync(planPath, "utf8")) as unknown;
    const plan = batch.checkPlanIntegrity(raw);
    if (plan.vaultId !== vaultId) throw new Error(`the plan is for vault "${plan.vaultId}", not "${vaultId}" (pass --vault)`);
    // A hard cap per run (owner: "very carefully"): 200 by default, never more than MAX_PER_RUN.
    const limit = Math.min(MAX_PER_RUN, arg("limit") !== undefined ? num("limit", 0) : DEFAULT_PER_RUN);
    const maxAgeMs = num("max-age-hours", 24) * 3_600_000;
    console.log(`APPLY batch ${plan.batchId} from ${planPath} (plan of ${plan.createdAt}; pace ${paceMs} ms, at most ${limit} entries this run)`);
    try {
      const maxWrites = arg("max-writes") !== undefined ? num("max-writes", 0) : undefined;
      const r = await batch.applyPlan(plan, { actor, paceMs, limit, maxWrites, maxAgeMs, log: (l) => console.log(`  ${l}`) });
      console.log(`done:     link ${r.done.link} · create ${r.done.create} · review question ${r.done.recommend} · ignore ${r.done.ignore}`);
      console.log(`thread notes: messages-with added ${r.threadLinks.added} (each re-read and verified) · already there ${r.threadLinks.existing} · failed ${r.threadLinks.failed}`);
      console.log(`skipped:  ${JSON.stringify(r.skipped)}`);
      console.log(`already done (resume): ${r.alreadyDone}${r.retried ? ` (failed thread-note links retried for ${r.retried})` : ""} · vault writes this run: ${r.writes}`);
      if (r.undoneEarlier) console.log(`NOTE: ${r.undoneEarlier} entr${r.undoneEarlier === 1 ? "y was" : "ies were"} undone earlier — this plan never redoes them. Make a new plan (dry run) to act on them again.`);
      if (r.stoppedEarly) console.log(`stopped early (${r.stoppedEarly}); ${r.remaining} left — run --apply again with the same plan to resume`);
      console.log(`undo with: --undo ${r.batchId}`);
      audit("apply", { batchId: r.batchId, done: r.done, skipped: r.skipped, remaining: r.remaining }, r.stoppedEarly && r.stoppedEarly !== "limit" ? "failed" : "ok");
      return 0;
    } catch (e) {
      if (e instanceof batch.StalePlanError) {
        console.error(e.why === "too_old" ? "REFUSED: the plan is older than --max-age-hours. Run the dry run again."
          : e.why === "vault" ? "REFUSED: the plan was made against another vault."
          : `REFUSED: the plan is stale — ${e.stale} entr${e.stale === 1 ? "y is" : "ies are"} now decided differently. Run the dry run again and review the new plan.`);
        audit("apply", { batchId: plan.batchId, stale: e.stale, why: e.why }, "refused", "stale_plan");
        return 3;
      }
      throw e;
    }
  }

  // ── dry run ──
  const options = {
    minTotal: num("min-total", batch.DEFAULT_BATCH_OPTIONS.minTotal),
    minOwner: num("min-owner", batch.DEFAULT_BATCH_OPTIONS.minOwner),
    dmMinOwner: num("dm-min-owner", batch.DEFAULT_BATCH_OPTIONS.dmMinOwner),
    ignoreLow: flag("ignore-low"),
    // Owner-approved (2026-11-23): link exact full-name single-candidate matches; never create excluded names.
    ...(flag("promote-exact-names") ? { promoteExactNames: true } : {}),
    ...(argsOf("exclude-name").length ? { excludeNames: argsOf("exclude-name") } : {}),
    // Email is never promoted / created from unless --allow-email; --skip-network leaves a network out.
    ...(argsOf("skip-network").length ? { skipNetworks: argsOf("skip-network") } : {}),
    ...(flag("allow-email") ? { allowEmail: true } : {}),
  };
  let plan;
  try {
    plan = await batch.buildPlan(vaultId, options, { allowNoOwnerPerson: flag("allow-no-owner-person") });
  } catch (e) {
    if (e instanceof batch.NoOwnerPersonError) { console.error(`REFUSED: ${e.message}. (--allow-no-owner-person plans anyway; his ghosts / addresses are still excluded.)`); return 4; }
    throw e;
  }
  const s = batch.summarize(plan, num("sample", 20));
  console.log(`DRY RUN — nothing written except the plan file. People to Tidy: ${s.total}`);
  console.log(`rules: only DMs with exactly ONE counterpart (owner ghosts / addresses and bots removed); the owner's own person is never a target.`);
  console.log(`      A = that one counterpart's key is held by exactly one person whose given name agrees (else C).`);
  console.log(`      B = a full name (≥ 2 name tokens, no business / nickname words) and ≥ ${options.dmMinOwner} messages from you in the DM`);
  console.log(`          (every candidate is a DM, so --dm-min-owner is the bar; --min-total/--min-owner add a second way in: ≥ ${options.minTotal} with ≥ ${options.minOwner} from you).`);
  console.log(`      D ${options.ignoreLow ? "WILL be ignored (--ignore-low)" : "is left in People to Tidy"}\n`);
  const label = { A: "A link to existing person", B: "B create person + link", C: "C review question (no write)", D: "D leave" } as const;
  for (const t of batch.TIERS) console.log(`${label[t].padEnd(32)} ${String(s.tiers[t]).padStart(6)}   ${Object.entries(s.reasons[t]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`\nper network            A      B      C      D`);
  for (const [net, c] of Object.entries(s.byNetwork).sort()) console.log(`${net.padEnd(16)} ${batch.TIERS.map((t) => String(c[t]).padStart(6)).join(" ")}`);
  const f = plan.forecast;
  if (f?.known) {
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
    console.log(`\nthread notes with a person link (link health thread.person): now ${f.withPersonNow}/${f.threadNotes} (${pct(f.withPersonNow, f.threadNotes)}) → after A+B ${f.withPersonAfter}/${f.threadNotes} (${pct(f.withPersonAfter, f.threadNotes)})`);
    console.log(`per platform     notes   linked now   would gain`);
    for (const [p, c] of Object.entries(f.byPlatform).sort()) console.log(`${p.padEnd(14)} ${String(c.notes).padStart(7)} ${String(c.withPersonNow).padStart(12)} ${String(c.gain).padStart(12)}`);
    console.log(`(a full count over every message-thread note. Prism's link-health check samples the most recently UPDATED notes, and every`);
    console.log(` link this batch writes bumps a note's updated_at — so right after an apply link health over-reports. Judge by re-running this dry run.)`);
  } else if (f) console.log(`\n(thread-link forecast unavailable: the message-thread listing failed)`);
  // The two owner-approved lists, in full (names only — the owner's own machine).
  const promoted = plan.entries.filter((e) => e.reason === "exact-name");
  if (promoted.length) {
    console.log(`\nA exact-name promotions (--promote-exact-names), all ${promoted.length}:`);
    for (const e of promoted) console.log(`  ${e.displayName} → ${e.personName}   [${e.network}]`);
  }
  const creates = plan.entries.filter((e) => e.tier === "B");
  if (creates.length) {
    console.log(`\nB creates, all ${creates.length}:`);
    for (const e of creates) console.log(`  ${e.displayName} → (new) ${e.name}   [${e.network}]`);
  }
  const excluded = plan.entries.filter((e) => e.reason === "excluded-by-owner");
  if (excluded.length) console.log(`\nexcluded by --exclude-name: ${excluded.map((e) => e.displayName).join(", ")}`);
  for (const t of batch.TIERS) {
    if (!s.samples[t].length) continue;
    console.log(`\nsample ${label[t]} (first ${s.samples[t].length}):`);
    for (const line of s.samples[t]) console.log(`  ${line}`);
  }
  fs.mkdirSync(path.dirname(planPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 1), { mode: 0o600 });
  fs.chmodSync(planPath, 0o600);
  console.log(`\nplan ${plan.batchId} written to ${planPath}`);
  const multi: Record<string, number> = {};
  for (const e of plan.entries) if (e.reason === "not-one-counterpart") multi[e.network] = (multi[e.network] ?? 0) + 1;
  if (Object.keys(multi).length) console.log(`"DMs" with more than one counterpart (skipped, never linked): ${Object.entries(multi).map(([n, c]) => `${n} ${c}`).join(", ")}`);
  console.log(`apply with: --apply --plan ${planPath} --limit 25    (undo later with --undo ${plan.batchId})`);
  console.log(`the plan file holds names and handles: delete it once the batch is signed off.`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

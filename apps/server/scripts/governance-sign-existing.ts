/**
 * Sign every existing governance-* note in a vault with GOVERNANCE_SIGNING_SECRET
 * (WP0.3 governance integrity). OWNER-RUN, once per vault, BEFORE (or right as)
 * the server starts with the secret set — otherwise every unsigned governance
 * note is ignored and the constitution appears to vanish.
 *
 *   node --import tsx scripts/governance-sign-existing.ts --env <file> [--apply] [--vault <name>]
 *
 *   --env <file>   REQUIRED. The env file to read PARACHUTE_URL / PARACHUTE_VAULT /
 *                  PARACHUTE_TOKEN / GOVERNANCE_SIGNING_SECRET from. There is no
 *                  default — the script never falls back to apps/server/.env, so
 *                  pointing it at production is always a deliberate act.
 *   --apply        Write. Without it this is a DRY RUN that only lists the plan.
 *   --vault <name> Override PARACHUTE_VAULT (the vault NAME, e.g. "default").
 *
 * Idempotent: notes that already verify are skipped, so a second --apply writes
 * nothing. Notes with a stale/invalid signature are re-signed; notes carrying two
 * governance tags are skipped for a human to fix.
 *
 * REVIEW THE ROSTER before --apply: signing blesses every note as legitimate. If
 * a membership or vote is listed that nobody granted/cast through Prism, delete
 * it from the vault first — it may be a forgery written with a vault token.
 *
 * Never prints tokens or secrets, and never prints note content.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Note } from "../src/parachute";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function die(msg: string): never {
  console.error(`governance-sign-existing: ${msg}`);
  process.exit(2);
}

async function main() {
  if (process.execArgv.some((a) => a.startsWith("--env-file"))) {
    die("do not pass --env-file to node; name the env file explicitly with --env <file>.");
  }
  const envPath = arg("--env");
  if (!envPath) die("refusing to run without an explicit --env <file> (there is deliberately no default).");
  const abs = resolve(envPath);
  if (!existsSync(abs)) die(`env file not found: ${abs}`);
  process.loadEnvFile(abs);

  const apply = process.argv.includes("--apply");
  const url = (process.env.PARACHUTE_URL ?? "").replace(/\/+$/, "");
  const vaultName = arg("--vault") ?? process.env.PARACHUTE_VAULT ?? "";
  const token = process.env.PARACHUTE_TOKEN ?? "";
  const secret = process.env.GOVERNANCE_SIGNING_SECRET ?? "";
  if (!url || !vaultName || !token) die(`${abs} must define PARACHUTE_URL, PARACHUTE_VAULT (or --vault) and PARACHUTE_TOKEN.`);

  // Imported AFTER the env file is loaded (config.ts reads env at import time).
  const { MIN_SECRET_LENGTH } = await import("../src/governance-integrity");
  const { signExistingGovernance } = await import("../src/governance-migrate");
  if (!secret) die(`${abs} does not define GOVERNANCE_SIGNING_SECRET.`);
  if (secret.length < MIN_SECRET_LENGTH) die(`GOVERNANCE_SIGNING_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`);

  const base = `${url}/vault/${encodeURIComponent(vaultName)}/api`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const vault = {
    async listNotes(opts: { tags?: string[]; includeContent?: boolean }): Promise<Note[]> {
      const sp = new URLSearchParams({ limit: "50000", sort: "desc" });
      if (opts.includeContent) sp.set("include_content", "true");
      for (const t of opts.tags ?? []) sp.append("tag", t);
      const r = await fetch(`${base}/notes?${sp}`, { headers });
      if (!r.ok) throw new Error(`GET /notes → ${r.status}`);
      return (await r.json()) as Note[];
    },
    async updateNote(id: string, params: { metadata?: Record<string, unknown> }): Promise<Note> {
      const r = await fetch(`${base}/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ...params, force: true }),
      });
      if (!r.ok) throw new Error(`PATCH /notes/${id} → ${r.status}`);
      return (await r.json()) as Note;
    },
  };

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — vault "${vaultName}" at ${url}`);
  const res = await signExistingGovernance(vault, { secret, apply });

  const counts = new Map<string, number>();
  for (const i of res.plan) counts.set(i.action, (counts.get(i.action) ?? 0) + 1);
  console.log(`\n${res.plan.length} governance note(s): ${[...counts].map(([a, n]) => `${n} ${a}`).join(", ") || "none"}`);
  for (const i of res.plan) {
    console.log(`  ${i.action.padEnd(14)} ${i.tag.padEnd(22)} ${i.id}  ${i.summary}`);
  }
  console.log(
    "\nReview memberships and votes above: signing blesses them. Delete anything nobody granted/cast through Prism BEFORE --apply.",
  );
  if (!apply) {
    console.log("\nDry run only — re-run with --apply to write.");
    return;
  }
  console.log(`\nsigned ${res.written.length} note(s); ${res.remaining} still pending after re-check.`);
  if (res.remaining !== 0) process.exit(1);
}

main().catch((e) => {
  console.error(`governance-sign-existing failed: ${(e as Error).message}`);
  process.exit(1);
});

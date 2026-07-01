/**
 * LIVE check of the Phase-3 Fathom path: desktop key → secret store round-trip →
 * FathomClient → ingest recent meeting transcripts into a THROWAWAY vault → verify
 * transcript notes. Proves the server-side write path before the prod cutover.
 * Safe: only writes to a freshly-created vault `fathom-e2e` (removed at the end);
 * reads Fathom in read-only fashion. Fetches the user's own recent recordings
 * (deleted with the test vault).
 *
 *   DB_PATH=/tmp/fathom-e2e.db node --import tsx scripts/verify-fathom-ingest.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import crypto from "node:crypto";

process.env.DB_PATH = process.env.DB_PATH ?? "/tmp/fathom-e2e.db";
process.env.SECRETS_KEY = process.env.SECRETS_KEY ?? crypto.randomBytes(32).toString("base64");

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

function restVault(url: string, vault: string, token: string) {
  const base = `${url}/vault/${vault}/api`;
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async listNotes({ tags, includeContent }: { tags?: string[]; includeContent?: boolean }) {
      const sp = new URLSearchParams({ limit: "1000" });
      if (includeContent) sp.set("include_content", "true");
      for (const t of tags ?? []) sp.append("tag", t);
      const r = await fetch(`${base}/notes?${sp}`, { headers: h });
      if (!r.ok) throw new Error(`list ${r.status}`);
      return r.json() as Promise<any[]>;
    },
    async createNote(p: any) {
      const r = await fetch(`${base}/notes`, { method: "POST", headers: h, body: JSON.stringify(p) });
      if (!r.ok) throw new Error(`create ${r.status} ${await r.text()}`);
      return r.json();
    },
    async updateNote(id: string, p: any) {
      const r = await fetch(`${base}/notes/${encodeURIComponent(id)}`, { method: "PATCH", headers: h, body: JSON.stringify({ ...p, force: true }) });
      if (!r.ok) throw new Error(`update ${r.status}`);
      return r.json();
    },
  };
}

async function main() {
  const { putSecret, getSecret } = await import("../src/secrets.js");
  const { FathomClient, ingestFathom } = await import("../src/worker/fathom.js");

  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const apiKey = String(cfg.fathom_api_key);
  ok("found fathom_api_key", !!apiKey);

  putSecret("fathom-e2e", "owner@test", "fathom", JSON.stringify({ apiKey }));
  const back = JSON.parse(getSecret("fathom-e2e", "owner@test", "fathom") ?? "{}");
  ok("secret round-trips", back.apiKey === apiKey);

  const client = new FathomClient(back.apiKey);
  const meetings = await client.listMeetings(new Date(Date.now() - 7 * 86_400_000).toISOString());
  ok("Fathom API reachable (list meetings)", Array.isArray(meetings), `last 7d: ${meetings.length} meetings`);

  console.log("=== provision throwaway vault + ingest ===");
  execFileSync("parachute-vault", ["create", "fathom-e2e", "--no-mirror", "--json"], { encoding: "utf8" });
  const token = execFileSync("parachute", ["auth", "mint-token", "--scope", "vault:fathom-e2e:write", "--expires-in", "86400"], { encoding: "utf8" }).trim();
  const vault = restVault("http://localhost:1940", "fathom-e2e", token);
  const res = await ingestFathom(client, vault as any);
  console.log(`  ingested: created ${res.created}, skipped ${res.skipped} (of ${res.meetings} meetings)`);

  const notes = await vault.listNotes({ tags: ["transcript"], includeContent: true });
  if (meetings.length === 0) {
    ok("no meetings in the last 7d — connection proven, nothing to ingest (not a failure)", true);
  } else {
    ok("ingest created transcript notes", res.created > 0 || notes.length > 0, `notes=${notes.length}`);
    if (notes[0]) ok("note tagged fathom + has source_id", (notes[0].tags ?? []).includes("fathom") && !!notes[0].metadata?.source_id, `source_id=${notes[0].metadata?.source_id}`);
  }

  console.log(`\n=== ${fail === 0 ? "PASS — server-side Fathom write path works" : "see failures above"} ===`);
  try { execFileSync("parachute-vault", ["remove", "fathom-e2e", "--yes"]); console.log("  removed test vault"); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("crashed:", e);
  try { execFileSync("parachute-vault", ["remove", "fathom-e2e", "--yes"]); } catch { /* */ }
  process.exit(1);
});

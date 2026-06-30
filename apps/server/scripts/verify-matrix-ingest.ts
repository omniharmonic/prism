/**
 * LIVE end-to-end check of the Phase-3 Matrix path (run on the machine that has
 * the local Synapse + Prism desktop config):
 *   desktop creds → per-tenant secret store (encrypt+round-trip) → MatrixClient
 *   → ingest real messages into a THROWAWAY vault → verify message-thread notes.
 *
 * Safe: writes only to a freshly-created vault `matrix-e2e` (removed at the end);
 * never touches the prod `default` vault. Reads Matrix in read-only fashion.
 *
 * Run:  DB_PATH=/tmp/matrix-e2e.db node --import tsx scripts/verify-matrix-ingest.ts
 * (SECRETS_KEY is generated in-process if unset.)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import crypto from "node:crypto";

process.env.DB_PATH = process.env.DB_PATH ?? "/tmp/matrix-e2e.db";
process.env.SECRETS_KEY = process.env.SECRETS_KEY ?? crypto.randomBytes(32).toString("base64");

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

interface IngestVaultLike {
  listNotes(o: { tags?: string[]; includeContent?: boolean }): Promise<any[]>;
  createNote(p: any): Promise<any>;
  updateNote(id: string, p: any): Promise<any>;
}
function restVault(url: string, vault: string, token: string): IngestVaultLike {
  const base = `${url}/vault/${vault}/api`;
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async listNotes({ tags, includeContent }) {
      const sp = new URLSearchParams({ limit: "1000" });
      if (includeContent) sp.set("include_content", "true");
      for (const t of tags ?? []) sp.append("tag", t);
      const r = await fetch(`${base}/notes?${sp}`, { headers: h });
      if (!r.ok) throw new Error(`list ${r.status}`);
      return r.json();
    },
    async createNote(p) {
      const r = await fetch(`${base}/notes`, { method: "POST", headers: h, body: JSON.stringify(p) });
      if (!r.ok) throw new Error(`create ${r.status} ${await r.text()}`);
      return r.json();
    },
    async updateNote(id, p) {
      const r = await fetch(`${base}/notes/${encodeURIComponent(id)}`, { method: "PATCH", headers: h, body: JSON.stringify({ ...p, force: true }) });
      if (!r.ok) throw new Error(`update ${r.status}`);
      return r.json();
    },
  };
}

async function main() {
  const { putSecret, getSecret } = await import("../src/secrets.ts");
  const { MatrixClient, ingestMatrix } = await import("../src/worker/matrix.ts");

  console.log("=== 1. read desktop Matrix creds ===");
  const cfgPath = `${homedir()}/Library/Application Support/prism/prism-config.json`;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const creds = { homeserver: cfg.matrix_homeserver as string, accessToken: cfg.matrix_access_token as string };
  ok("found homeserver + token", !!creds.homeserver && !!creds.accessToken, creds.homeserver);

  console.log("\n=== 2. per-tenant secret store round-trip ===");
  putSecret("matrix-e2e", "owner@test", "matrix", JSON.stringify(creds));
  const back = JSON.parse(getSecret("matrix-e2e", "owner@test", "matrix") ?? "{}");
  ok("secret encrypts + decrypts to the same creds", back.accessToken === creds.accessToken && back.homeserver === creds.homeserver);

  console.log("\n=== 3. MatrixClient.whoami (creds from the secret store) ===");
  const client = new MatrixClient(back);
  const who = await client.whoami();
  ok("token valid", who.startsWith("@"), who);

  console.log("\n=== 4. provision a throwaway vault ===");
  execFileSync("parachute-vault", ["create", "matrix-e2e", "--no-mirror", "--json"], { encoding: "utf8" });
  const token = execFileSync("parachute", ["auth", "mint-token", "--scope", "vault:matrix-e2e:write", "--expires-in", "86400"], { encoding: "utf8" }).trim();
  ok("vault + token minted", token.startsWith("ey"), `aud should be vault.matrix-e2e`);

  console.log("\n=== 5. ingest real messages (cap 5 rooms for speed) ===");
  const vault = restVault("http://localhost:1940", "matrix-e2e", token);
  const res = await ingestMatrix(client, vault, { maxRooms: 5 });
  console.log(`  ingested: ${res.messages} messages across ${res.rooms} rooms (created ${res.created}, updated ${res.updated})`);
  ok("ingest created message-thread notes", res.created > 0, `created=${res.created}`);
  ok("nextBatch returned for incremental resume", res.nextBatch.length > 0);

  console.log("\n=== 6. verify notes landed in the vault ===");
  const notes = await vault.listNotes({ tags: ["message-thread"], includeContent: true });
  ok("message-thread notes present", notes.length > 0, `count=${notes.length}`);
  const sample = notes[0];
  ok("note has platform + matrixRoomId metadata", !!sample?.metadata?.platform && !!sample?.metadata?.matrixRoomId, `platform=${sample?.metadata?.platform}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);

  console.log("=== 7. teardown ===");
  try {
    execFileSync("parachute-vault", ["remove", "matrix-e2e", "--yes"], { encoding: "utf8" });
    console.log("  removed test vault matrix-e2e");
  } catch (e) {
    console.log("  (teardown note:", (e as Error).message, ")");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-matrix-ingest crashed:", e);
  // best-effort teardown
  try {
    execFileSync("parachute-vault", ["remove", "matrix-e2e", "--yes"]);
  } catch {
    /* ignore */
  }
  process.exit(1);
});

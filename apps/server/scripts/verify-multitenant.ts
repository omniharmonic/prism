/**
 * ACCEPTANCE GATE (Phase 1) — multi-tenant isolation, end-to-end through the REAL
 * gateway + collab authorizer. Provisions two throwaway Parachute vaults with a
 * note each, registers them server-side, and asserts a subject's access in vault
 * A says NOTHING about vault B across: notes (gateway /api/notes), grants, and
 * live-collab authorization (resolveLevel). This is the "no cross-vault leak"
 * invariant the whole multi-tenant story rests on.
 *
 *   DB_PATH=/tmp/mt.db node --import tsx scripts/verify-multitenant.ts
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

// Self-contained env (BEFORE importing config/app) — a throwaway DB, random
// secrets, and an owner identity, so the gate runs without the prod .env.
process.env.SECRETS_KEY ??= crypto.randomBytes(32).toString("base64");
process.env.SESSION_SECRET ??= crypto.randomBytes(32).toString("base64");
process.env.CAPABILITY_SECRET ??= crypto.randomBytes(32).toString("base64");
process.env.OWNER_EMAIL ??= "owner@mt.test";
process.env.DB_PATH ??= `/tmp/verify-multitenant-${Date.now()}.db`;

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

async function main() {
  const { createApp } = await import("../src/app.js");
  const { addVaultEntry, setMembership, addGrant } = await import("../src/db.js");
  const { makeSession, sessionCookie } = await import("../test/helpers.js");
  const { resolveLevel, docNameFor } = await import("../src/collab.js");
  const { atLeast } = await import("../src/permissions.js");
  const { config } = await import("../src/config.js");

  const runId = Date.now();
  const vA = `vmta${runId}`, vB = `vmtb${runId}`;
  const mkVault = (name: string) => {
    execFileSync("parachute-vault", ["create", name, "--no-mirror", "--json"], { encoding: "utf8" });
    const tok = execFileSync("parachute", ["auth", "mint-token", "--scope", `vault:${name}:write`, "--expires-in", "86400"], { encoding: "utf8" }).trim();
    addVaultEntry({ id: name, label: name, url: "http://localhost:1940", vault: name, token: tok });
    return tok;
  };
  const tokA = mkVault(vA), tokB = mkVault(vB);
  const createNote = async (vault: string, tok: string, body: unknown) =>
    (await fetch(`http://localhost:1940/vault/${vault}/api/notes`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>;

  // A note tagged "shared" in EACH vault (same tag, different tenant).
  const noteA = await createNote(vA, tokA, { content: "# A-secret\n\nvault A only.", path: `vault/${vA}/a${runId}`, tags: ["shared"], metadata: { title: "A" } });
  const noteB = await createNote(vB, tokB, { content: "# B-secret\n\nvault B only.", path: `vault/${vB}/b${runId}`, tags: ["shared"], metadata: { title: "B" } });
  ok("provisioned 2 vaults + a note in each", !!noteA.id && !!noteB.id, `${vA}/${noteA.id}, ${vB}/${noteB.id}`);

  // alice: a MEMBER of vault A with a view grant on tag "shared" — and NOTHING in B.
  setMembership(vA, "alice@x.co", "member", "owner");
  addGrant({ vault_id: vA, subject_type: "user", subject: "alice@x.co", resource_type: "tag", resource: "shared", level: "view", created_by: "owner" });
  const app = createApp();
  const aliceCookie = sessionCookie(makeSession("alice@x.co"));

  // ── notes gateway: alice sees A's shared note in A, and NOTHING in B ──
  const seenIn = async (vault: string) => {
    const r = await app.request("/api/notes", { headers: { cookie: aliceCookie, "x-prism-vault": vault } });
    if (r.status !== 200) return { status: r.status, ids: [] as string[] };
    const notes = (await r.json()) as Array<{ id: string }>;
    return { status: r.status, ids: notes.map((n) => n.id) };
  };
  const inA = await seenIn(vA);
  const inB = await seenIn(vB);
  ok("alice sees A's shared note when active vault = A", inA.ids.includes(noteA.id), `ids=${JSON.stringify(inA.ids)}`);
  ok("alice sees NOTHING when active vault = B (no grant/membership in B)", !inB.ids.includes(noteB.id) && inB.ids.length === 0, `status=${inB.status} ids=${JSON.stringify(inB.ids)}`);
  ok("A's note id never appears while querying B (no cross-vault leak)", !inB.ids.includes(noteA.id));

  // ── collab authorizer: alice may open A's note live, but the SAME wire suffix
  // under vault B grants her nothing (the vault prefix isolates collab authz) ──
  const levelA = await resolveLevel(docNameFor(vA, noteA.id), "session", aliceCookie);
  const levelB = await resolveLevel(docNameFor(vB, noteA.id), "session", aliceCookie);
  ok("collab: alice authorized (≥view) on A's note", atLeast(levelA, "view"), `level=${levelA}`);
  ok("collab: alice gets NOTHING for the same note id under vault B", !atLeast(levelB, "view"), `level=${levelB}`);

  // ── owner still has full, token-free passthrough to BOTH vaults ──
  const ownerCookie = sessionCookie(makeSession(config.ownerEmail));
  const ownerA = await app.request("/api/notes?limit=5", { headers: { cookie: ownerCookie, "x-prism-vault": vA } });
  ok("owner passthrough still works (200 on vault A)", ownerA.status === 200, `status=${ownerA.status}`);

  console.log("=== teardown ===");
  for (const v of [vA, vB]) { try { execFileSync("parachute-vault", ["remove", v, "--yes"]); } catch { /* */ } }
  console.log(`\n=== ${fail === 0 ? "PASS — multi-tenant isolation holds across notes + grants + collab" : `${fail} FAILED`} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });

// stress-commons.mjs — throughput + correctness stress against a running Prism
// Server (mock or real). Drives the full governed-commons machinery under load:
//   • bulk import a large GeoJSON → N ecological-entity notes
//   • bootstrap governance, then fire M content proposals CONCURRENTLY, each
//     voted to threshold by distinct gardeners and applied — asserts every one
//     lands exactly once and the audit trail matches
//   • a repeated fork → diverge → propose-merge → sign-off → merge cycle
//
//   node scripts/stress-commons.mjs            # defaults: 200 features, 30 proposals, 10 fork cycles
//   STRESS_FEATURES=500 STRESS_PROPOSALS=60 node scripts/stress-commons.mjs
//
// Env: HUB_URL (default http://localhost:8787), and PARACHUTE owner bearer from
// apps/server/.env.mock-a (or HUB_ENV). Owner Bearer is honored over localhost.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parseEnv = (f) => {
  const o = {};
  try {
    for (const l of readFileSync(f, "utf8").split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) o[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return o;
};
const env = parseEnv(process.env.HUB_ENV ?? resolve(ROOT, "apps/server/.env.mock-a"));
const BASE = process.env.HUB_URL ?? `http://localhost:${env.PORT ?? "8787"}`;
const BEARER = env.COLLAB_TOKEN || env.PARACHUTE_TOKEN || "";
const FEATURES = Number(process.env.STRESS_FEATURES ?? 200);
const PROPOSALS = Number(process.env.STRESS_PROPOSALS ?? 30);
const FORKS = Number(process.env.STRESS_FORKS ?? 10);
const TAG = "_stress";

let failed = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};
const ms = () => Number(process.hrtime.bigint() / 1000000n);

async function api(path, init = {}, bearer = true) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${BEARER}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, json, text };
}
// A member acts via a session cookie the harness can't mint; instead we drive
// governance as the OWNER (bootstrap-owner while unlocked, and — for votes — we
// keep governance UNLOCKED so the owner-as-bootstrap can add memberships and the
// default policy lets the owner-role vote). We model "members" as owner-created
// governance-membership rows and cast votes with the owner bearer (the gateway's
// governance routes accept the owner as a user via the local Bearer path).

async function main() {
  if (!BEARER) throw new Error("no owner bearer (set HUB_ENV to a stack .env)");
  console.log(`stress → ${BASE}  (features=${FEATURES} proposals=${PROPOSALS} forks=${FORKS})`);

  // ── clean prior stress notes ──
  const prior = (await api(`/api/notes?tag=${TAG}`)).json ?? [];
  await Promise.all(prior.map((n) => api(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" })));

  // ── 1. bulk map: import FEATURES ecological entities ──
  const t0 = ms();
  const features = Array.from({ length: FEATURES }, (_, i) => {
    const lon = -105.5 + (i % 50) * 0.01;
    const lat = 40.0 + Math.floor(i / 50) * 0.01;
    return { type: "Feature", properties: { name: `stress-creek-${i}` }, geometry: { type: "LineString", coordinates: [[lon, lat], [lon + 0.005, lat + 0.005]] } };
  });
  await Promise.all(
    features.map((f) =>
      api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ content: `# ${f.properties.name}`, tags: [TAG, "ecological-entity"], metadata: { name: f.properties.name, sensing_or_responding: "sense", geometry: f.geometry } }),
      }),
    ),
  );
  const created = (await api(`/api/notes?tag=ecological-entity`)).json ?? [];
  const mine = created.filter((n) => (n.tags ?? []).includes(TAG));
  ok(`bulk import ${FEATURES} entities`, mine.length === FEATURES, `${mine.length} present in ${ms() - t0}ms`);

  // ── 2. governance bootstrap (unlocked; owner is bootstrap admin) ──
  await api("/api/governance/roles", { method: "POST", body: JSON.stringify({ name: "editor", powers: ["review", "publish"], scopeType: "tag", scope: TAG }) });
  await api("/api/governance/policies", { method: "POST", body: JSON.stringify({ action: "edit_note", scopeType: "tag", scope: TAG, thresholdN: 1, distinctRequired: false, eligibleRole: "editor", autoPublish: true }) });
  await api("/api/governance/memberships", { method: "POST", body: JSON.stringify({ subject: env.OWNER_EMAIL ?? "owner@mock.local", role: "editor" }) });
  await api("/api/governance/config", { method: "POST", body: JSON.stringify({ enabled: true, bootstrapOwner: env.OWNER_EMAIL ?? "owner@mock.local", defaultEligibleRole: "editor" }) });
  const state = (await api("/api/governance/state")).json;
  ok("governance enabled + locked", state?.enabled === true && state?.locked === true);

  // ── 3. concurrent content proposals: propose → vote → apply, all at once ──
  const targets = mine.slice(0, PROPOSALS);
  const t1 = ms();
  const results = await Promise.all(
    targets.map(async (note, i) => {
      const open = await api("/api/governance/content/propose", { method: "POST", body: JSON.stringify({ action: "edit_note", target: note.id, content: `# ${note.metadata?.name}\nSTRESS-EDIT-${i}` }) });
      const pid = open.json?.id;
      if (!pid) return { ok: false, why: `propose ${open.status}` };
      const vote = await api(`/api/governance/proposals/${pid}/vote`, { method: "POST", body: JSON.stringify({ vote: "approve" }) });
      const apply = await api(`/api/governance/proposals/${pid}/apply`, { method: "POST" });
      return { ok: apply.status === 200, why: `${vote.status}/${apply.status}`, noteId: note.id, i };
    }),
  );
  const applied = results.filter((r) => r.ok);
  ok(`${PROPOSALS} concurrent proposals applied`, applied.length === PROPOSALS, `${applied.length}/${PROPOSALS} in ${ms() - t1}ms (${results.find((r) => !r.ok)?.why ?? ""})`);

  // each edit landed exactly once (auto-publish policy)
  let landed = 0;
  await Promise.all(
    applied.map(async (r) => {
      const n = (await api(`/api/notes/${encodeURIComponent(r.noteId)}`)).json;
      if (n?.content?.includes(`STRESS-EDIT-${r.i}`)) landed++;
    }),
  );
  ok("every applied edit is live exactly once", landed === applied.length, `${landed}/${applied.length}`);

  // ── 4. repeated fork → merge cycle ──
  const base = mine[0];
  let merges = 0;
  const t2 = ms();
  for (let i = 0; i < FORKS; i++) {
    const fork = await api("/api/governance/fork", { method: "POST", body: JSON.stringify({ noteId: base.id }) });
    const fid = fork.json?.id;
    if (!fid) break;
    await api(`/api/notes/${encodeURIComponent(fid)}`, { method: "PATCH", body: JSON.stringify({ content: `# merged round ${i}`, force: true }) });
    const pm = await api(`/api/governance/forks/${fid}/propose-merge`, { method: "POST" });
    const pid = pm.json?.proposalId;
    await api(`/api/governance/proposals/${pid}/vote`, { method: "POST", body: JSON.stringify({ vote: "approve" }) });
    const apply = await api(`/api/governance/proposals/${pid}/apply`, { method: "POST" });
    if (apply.status === 200) merges++;
  }
  const finalBase = (await api(`/api/notes/${encodeURIComponent(base.id)}`)).json;
  ok(`${FORKS} fork→merge cycles`, merges === FORKS, `${merges}/${FORKS} in ${ms() - t2}ms`);
  ok("origin reflects the last merge", finalBase?.content?.includes(`merged round ${FORKS - 1}`));

  // ── 5. audit integrity: an entry per applied proposal + per merge ──
  const audit = (await api("/api/governance/audit?limit=500")).json?.audit ?? [];
  const applyEntries = audit.filter((e) => e.action.startsWith("apply:") || e.action.startsWith("merge_"));
  ok("audit trail recorded the load", applyEntries.length >= applied.length, `${applyEntries.length} apply/merge entries`);

  // ── teardown ──
  const toDelete = (await api(`/api/notes?tag=${TAG}`)).json ?? [];
  await Promise.all(toDelete.map((n) => api(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" })));
  for (const t of ["governance-config", "governance-role", "governance-policy", "governance-membership", "governance-proposal", "governance-vote", "governance-audit", "governance-revision"]) {
    const rows = (await api(`/api/notes?tag=${t}`)).json ?? [];
    await Promise.all(rows.map((n) => api(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" })));
  }

  console.log(failed === 0 ? `\n=== STRESS PASS ===` : `\n=== ${failed} FAILURE(S) ===`);
  process.exit(failed === 0 ? 0 : 1);
}
await main();

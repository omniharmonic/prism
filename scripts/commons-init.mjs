// commons-init.mjs — provision a bioregional knowledge commons vault end to end.
//
//   node scripts/commons-init.mjs --config docs/commons.config.example.json [--enable] [--dry-run]
//
// Steps (each verified):
//   1. SCHEMA   — seed the full canonical tag schema (incl. parent_names) into
//                 the vault (idempotent; additive).
//   2. GOVERN   — create roles, policies, memberships from the config, wire the
//                 constitution's amend policy, and (only with --enable, or
//                 config.governance.enable) throw the bootstrap lock.
//   3. INGEST   — run each configured data source through the importers and
//                 write the notes (with a provenance tag).
//   4. VERIFY   — assert schema present, governance state, and ingested counts.
//
// Config for WHERE: HUB_ENV (default apps/server/.env) supplies the vault
// coordinates (PARACHUTE_URL/VAULT/TOKEN — for the schema seed, which talks to
// the vault directly) and the gateway owner Bearer (COLLAB_TOKEN — for the
// governance + ingest steps, which go through the Prism Server). HUB_URL
// overrides the gateway origin.
//
// Safe by default: governance is NOT locked unless you pass --enable (locking is
// irreversible without a passed amendment). --dry-run prints the plan only.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTagSchemas } from "../apps/server/scripts/lib/seed-tag-schemas.ts";
import { IMPORTERS } from "../apps/server/src/importers/transform.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const DRY = has("dry-run");

function parseEnv(f) {
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
}

const configPath = arg("config");
if (!configPath) {
  console.error("--config <path> required (see docs/commons.config.example.json)");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(resolve(process.cwd(), configPath), "utf8"));
const env = parseEnv(process.env.HUB_ENV ?? resolve(ROOT, "apps/server/.env"));
const HUB = process.env.HUB_URL ?? `http://localhost:${env.PORT ?? "8787"}`;
const BEARER = env.COLLAB_TOKEN || env.PARACHUTE_TOKEN || "";
const VAULT_URL = (env.PARACHUTE_URL ?? "http://localhost:1940").replace(/\/+$/, "");
const VAULT = env.PARACHUTE_VAULT ?? "default";
const VAULT_TOKEN = env.PARACHUTE_TOKEN ?? "";

let failed = 0;
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};
const step = (n) => console.log(`\n▸ ${n}`);

async function gw(path, init = {}) {
  const r = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER}`, ...(init.headers ?? {}) },
  });
  const t = await r.text();
  let json = null;
  try {
    json = t ? JSON.parse(t) : null;
  } catch {}
  return { status: r.status, json, text: t };
}

console.log(`Commons: ${cfg.name}`);
console.log(`Gateway: ${HUB}   Vault: ${VAULT_URL} (${VAULT})${DRY ? "   [DRY-RUN]" : ""}`);
if (!BEARER && !DRY) throw new Error("no owner bearer — set HUB_ENV to a server .env with COLLAB_TOKEN/PARACHUTE_TOKEN");

// ── 1. SCHEMA ─────────────────────────────────────────────────────────────────
step("1. Schema — seed canonical tag schemas (incl. parent_names)");
if (DRY) {
  console.log("  [dry] would seed the canonical tag schema into", `${VAULT_URL}/vault/${VAULT}`);
} else {
  const res = await seedTagSchemas({ vaultUrl: VAULT_URL, vault: VAULT, token: VAULT_TOKEN, log: () => {} });
  ok("schema seeded", true, `${res.created.length} created, ${res.updated.length} updated, ${res.unchanged.length} unchanged`);
  // idempotency: a second run makes no changes
  const res2 = await seedTagSchemas({ vaultUrl: VAULT_URL, vault: VAULT, token: VAULT_TOKEN, log: () => {} });
  ok("schema idempotent", res2.created.length === 0 && res2.updated.length === 0, `2nd run: ${res2.unchanged.length} unchanged`);
}

// ── 2. GOVERNANCE ─────────────────────────────────────────────────────────────
step("2. Governance — roles, policies, members, constitution");
const g = cfg.governance ?? {};
if (DRY) {
  console.log(`  [dry] would create ${g.roles?.length ?? 0} roles, ${g.policies?.length ?? 0} policies, ${g.members?.length ?? 0} members`);
  console.log(`  [dry] would ${g.enable || has("enable") ? "ENABLE + LOCK" : "leave UNLOCKED"} governance`);
} else {
  for (const r of g.roles ?? []) {
    const res = await gw("/api/governance/roles", { method: "POST", body: JSON.stringify(r) });
    ok(`role ${r.name}`, res.status === 200, res.status !== 200 ? res.json?.detail : "");
  }
  // create policies; capture the amend policy id to wire into the constitution
  let amendPolicyId = "";
  for (const p of g.policies ?? []) {
    const res = await gw("/api/governance/policies", { method: "POST", body: JSON.stringify(p) });
    ok(`policy ${p.action}${p.scope ? `#${p.scope}` : ""}`, res.status === 200, res.status !== 200 ? res.json?.detail : "");
    if (p.action === (g.config?.amendPolicyAction ?? "amend_governance") && p.scopeType === "global" && res.json?.note?.id) amendPolicyId = res.json.note.id;
  }
  for (const m of g.members ?? []) {
    const res = await gw("/api/governance/memberships", { method: "POST", body: JSON.stringify(m) });
    ok(`member ${m.subject}→${m.role}`, res.status === 200, res.status !== 200 ? res.json?.detail : "");
  }
  const enable = g.enable || has("enable");
  const configBody = {
    enabled: enable,
    bootstrapOwner: env.OWNER_EMAIL ?? g.config?.bootstrapOwner ?? "",
    amendPolicy: amendPolicyId,
    defaultThresholdN: g.config?.defaultThresholdN ?? 2,
    defaultEligibleRole: g.config?.defaultEligibleRole ?? "gardener",
  };
  const res = await gw("/api/governance/config", { method: "POST", body: JSON.stringify(configBody) });
  ok(`constitution written${enable ? " (ENABLED + LOCKED)" : " (unlocked)"}`, res.status === 200, res.status !== 200 ? res.json?.detail : "");
  const state = (await gw("/api/governance/state")).json;
  ok("governance state reads back", !!state, `enabled=${state?.enabled} roles=${state?.roles?.length} policies=${state?.policies?.length}`);
}

// ── 3. INGEST ─────────────────────────────────────────────────────────────────
step("3. Ingest — data sources → typed notes");
for (const src of cfg.dataSources ?? []) {
  const data = src.file
    ? JSON.parse(readFileSync(resolve(ROOT, src.file), "utf8"))
    : src.url
      ? await (await fetch(src.url)).json()
      : null;
  if (!data) {
    ok(`${src.source}`, false, "no file/url");
    continue;
  }
  const opts = {};
  if (src.tag) opts.tag = src.tag;
  if (src.kind) opts.ecologicalKind = src.kind;
  if (src.sensing) opts.sensing = src.sensing;
  if (src.nameProp) opts.nameProp = src.nameProp;
  let drafts = IMPORTERS[src.source](data, opts);
  if (src.extraTag) drafts = drafts.map((d) => ({ ...d, tags: [src.extraTag, ...d.tags] }));
  if (DRY) {
    ok(`${src.source}`, true, `[dry] ${drafts.length} notes`);
    continue;
  }
  let created = 0;
  for (const d of drafts) {
    const res = await gw("/api/notes", { method: "POST", body: JSON.stringify(d) });
    if (res.status === 200 || res.status === 201) created++;
  }
  ok(`${src.source}`, created === drafts.length, `${created}/${drafts.length} notes`);
}

// ── 4. VERIFY ─────────────────────────────────────────────────────────────────
if (!DRY) {
  step("4. Verify");
  const tagList = (await gw(`/api/notes?tag=ecological-entity`)).json ?? [];
  ok("ecological entities present", Array.isArray(tagList) && tagList.length > 0, `${tagList.length}`);
  const state = (await gw("/api/governance/state")).json;
  ok("governance provisioned", (state?.roles?.length ?? 0) >= (g.roles?.length ?? 0));
}

console.log(failed === 0 ? `\n=== COMMONS PROVISIONED (${DRY ? "dry-run" : "live"}) — ALL OK ===` : `\n=== ${failed} ISSUE(S) ===`);
process.exit(failed === 0 ? 0 : 1);

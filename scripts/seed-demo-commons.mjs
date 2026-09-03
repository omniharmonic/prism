// Seed a small, coherent DEMO bioregional commons into a vault, so /bioregion
// and /governance have real content to walk through. All notes are tagged
// `demo-commons` so they can be removed in one sweep.
//
//   node scripts/seed-demo-commons.mjs            # seed (reads apps/server/.env)
//   node scripts/seed-demo-commons.mjs --clean    # remove all demo-commons notes
//
// Env: PARACHUTE_URL, PARACHUTE_VAULT, PARACHUTE_TOKEN (falls back to
// apps/server/.env, worktree-aware). This talks to the vault REST API directly
// (same surface the server uses) — it does NOT touch governance state.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const candidates = [resolve(ROOT, "apps/server/.env")];
  try {
    const main = execSync("git worktree list --porcelain", { cwd: ROOT }).toString().split("\n").find((l) => l.startsWith("worktree "));
    if (main) candidates.push(resolve(main.slice("worktree ".length).trim(), "apps/server/.env"));
  } catch {
    /* not a worktree */
  }
  const out = {};
  for (const path of candidates) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in out)) out[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const fileEnv = loadEnv();
const env = (k, d = "") => process.env[k] ?? fileEnv[k] ?? d;
const URL_ = env("PARACHUTE_URL", "http://localhost:1940").replace(/\/+$/, "");
const VAULT = env("PARACHUTE_VAULT", "default");
const TOKEN = env("PARACHUTE_TOKEN");
if (!TOKEN) {
  console.error("PARACHUTE_TOKEN not found (apps/server/.env). Aborting.");
  process.exit(1);
}
const API = `${URL_}/vault/${VAULT}/api`;
const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const DEMO = "demo-commons";

async function listByTag(tag) {
  const r = await fetch(`${API}/notes?tag=${encodeURIComponent(tag)}`, { headers });
  return r.ok ? r.json() : [];
}
async function del(id) {
  await fetch(`${API}/notes/${encodeURIComponent(id)}`, { method: "DELETE", headers });
}
async function create(content, tags, metadata) {
  const r = await fetch(`${API}/notes`, { method: "POST", headers, body: JSON.stringify({ content, tags: [DEMO, ...tags], metadata }) });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
}

async function clean() {
  const notes = await listByTag(DEMO);
  for (const n of notes) await del(n.id);
  console.log(`removed ${notes.length} demo-commons notes.`);
}

async function seed() {
  await clean(); // idempotent
  const notes = [
    ["# Boulder Creek", ["ecological-entity"], { name: "Boulder Creek", ecological_kind: "creek", sensing_or_responding: "respond", status: "threatened", geometry: { type: "LineString", coordinates: [[-105.30, 40.00], [-105.24, 40.03], [-105.18, 40.02], [-105.10, 40.05]] } }],
    ["# St. Vrain Creek", ["ecological-entity"], { name: "St. Vrain Creek", ecological_kind: "creek", sensing_or_responding: "respond", status: "healthy", geometry: { type: "LineString", coordinates: [[-105.20, 40.15], [-105.10, 40.17], [-105.02, 40.16]] } }],
    ["# St. Vrain Watershed", ["watershed"], { hucName: "Saint Vrain", huc12: "101900050101", hucLevel: 12, sensing_or_responding: "sense", boundaryGeometry: { type: "Polygon", coordinates: [[[-105.55, 39.92], [-104.98, 39.92], [-104.98, 40.32], [-105.55, 40.32], [-105.55, 39.92]]] } }],
    ["# Yarrow\nA hardy medicinal in the Front Range foothills.", ["species"], { scientificName: "Achillea millefolium", vernacularName: "Yarrow", family: "Asteraceae", gbifTaxonKey: 3120060, sensing_or_responding: "sense", rangeGeometry: { type: "MultiPolygon", coordinates: [[[[-105.6, 39.9], [-104.9, 39.9], [-104.9, 40.4], [-105.6, 40.4], [-105.6, 39.9]]]] } }],
    ["# Yarrow — wound wash\nCrush fresh leaves; apply to stop minor bleeding.", ["herbal-use"], { species: "[[Yarrow]]", scientificName: "Achillea millefolium", ethnobotanicalUse: "styptic / wound wash", plantPart: "leaf", biologicalActivity: "Hemostatic", license: "CC0", sensing_or_responding: "respond" }],
    ["# Regenerate Boulder Farm", ["organization"], { name: "Regenerate Boulder Farm", sensing_or_responding: "respond", geo: { lat: 40.06, lon: -105.21 } }],
    ["# Proposed foothills rezoning", ["signal"], { title: "Proposed foothills rezoning", signal_kind: "policy", severity: "high", status: "active", sensing_or_responding: "sense", geo: { lat: 40.09, lon: -105.27 }, affects: ["[[Boulder Creek]]", "[[St. Vrain Watershed]]"] }],
    ["# Watershed monitoring playbook\nHow neighbors sample and log creek water quality monthly.", ["recipe"], { objective: "Community water-quality monitoring", recipe_kind: "coordination", governance: "consent", sensing_or_responding: "respond" }],
    ["# Spring creek cleanup", ["event"], { name: "Spring creek cleanup", event_kind: "gathering", startDate: "2026-04-18", sensing_or_responding: "respond", location: "[[Boulder Creek]]" }],
    ["# Rainwater catchment resource", ["resource"], { name: "Rainwater catchment kits", resource_kind: "water", sensing_or_responding: "respond" }],
  ];
  for (const [content, tags, metadata] of notes) await create(content, tags, metadata);
  console.log(`seeded ${notes.length} demo-commons notes into vault "${VAULT}".`);
  console.log("Open /bioregion to see them on the map, /governance to run the constitution.");
  console.log("Remove later with:  node scripts/seed-demo-commons.mjs --clean");
}

if (process.argv.includes("--clean")) await clean();
else await seed();

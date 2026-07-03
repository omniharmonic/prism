// Import authoritative open data into the bioregional commons as typed notes.
//
//   node scripts/import-bioregion.mjs --source <name> (--file F | --url U) [options]
//
// Sources:
//   gbif-species      GBIF species search JSON  → species notes
//   geojson-entities  a GeoJSON FeatureCollection → ecological-entity notes
//                     (--kind creek --sensing respond --name-prop gnis_name)
//   wbd-watersheds    USGS WBD GeoJSON          → watershed notes
//
// Options:
//   --file PATH        read the source data from a local JSON/GeoJSON file
//   --url URL          fetch the source data (needs network egress)
//   --dry-run          print what WOULD be created; write nothing
//   --tag TAG          override the note tag (geojson-entities)
//   --kind K           ecological_kind (geojson-entities)
//   --sensing S        sense|respond|both (geojson-entities; default sense)
//   --name-prop P      which GeoJSON property to use as the name
//   --extra-tag T      add an extra tag to every created note (e.g. demo-commons)
//
// Vault config comes from apps/server/.env (worktree-aware), like the other
// scripts. Notes are created via the vault REST API; governance is not involved
// (import is owner-side provisioning).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { IMPORTERS } from "../apps/server/src/importers/transform.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

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

const source = arg("source");
if (!source || !(source in IMPORTERS)) {
  console.error(`--source must be one of: ${Object.keys(IMPORTERS).join(", ")}`);
  process.exit(1);
}

async function readData() {
  const file = arg("file");
  const url = arg("url");
  if (file) return JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
  if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
    return r.json();
  }
  throw new Error("provide --file PATH or --url URL");
}

const opts = {};
if (arg("tag")) opts.tag = arg("tag");
if (arg("kind")) opts.ecologicalKind = arg("kind");
if (arg("sensing")) opts.sensing = arg("sensing");
if (arg("name-prop")) opts.nameProp = arg("name-prop");

const data = await readData();
let drafts = IMPORTERS[source](data, opts);
const extraTag = arg("extra-tag");
if (extraTag) drafts = drafts.map((d) => ({ ...d, tags: [extraTag, ...d.tags] }));

console.log(`${source}: ${drafts.length} note(s) from the source.`);

if (has("dry-run")) {
  for (const d of drafts) console.log(`  [dry] ${d.tags.join(",")} — ${d.metadata.name ?? d.metadata.scientificName ?? d.metadata.hucName}`);
  console.log("dry-run: nothing written.");
  process.exit(0);
}

const env = (k, d = "") => process.env[k] ?? loadEnv()[k] ?? d;
const URL_ = env("PARACHUTE_URL", "http://localhost:1940").replace(/\/+$/, "");
const VAULT = env("PARACHUTE_VAULT", "default");
const TOKEN = env("PARACHUTE_TOKEN");
if (!TOKEN) {
  console.error("PARACHUTE_TOKEN not found (apps/server/.env). Use --dry-run to preview without a vault.");
  process.exit(1);
}
const API = `${URL_}/vault/${VAULT}/api`;
const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

let created = 0;
for (const d of drafts) {
  const r = await fetch(`${API}/notes`, { method: "POST", headers, body: JSON.stringify(d) });
  if (r.ok) created++;
  else console.error(`  create failed (${r.status}): ${await r.text()}`);
}
console.log(`created ${created}/${drafts.length} notes in vault "${VAULT}".`);

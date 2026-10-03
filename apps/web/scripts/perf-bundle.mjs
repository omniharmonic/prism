/**
 * NP-PF-08: initial vs lazy JavaScript of a production build, gzip.
 *
 *   npx vite build            (in apps/web; or `npm run build -w @prism/web`)
 *   node apps/web/scripts/perf-bundle.mjs [--dist apps/web/dist] [--budget 600] [--json out.json]
 *
 * "Initial" = the entry scripts in index.html plus every chunk they import STATICALLY
 * (transitively) — what the browser must download and parse before the app can start.
 * The entry is a tiny loader that import()s the app, so the loader's dynamic imports
 * are initial too.
 * Everything else is lazy (reached only through `import()`). No build manifest needed:
 * rollup's output keeps static imports as `import … from "./x.js"` / `import "./x.js"`.
 * Exit code 1 when the initial JS is over budget (KB gzip).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(arg("dist", path.join(here, "../dist")));
const budgetKb = Number(arg("budget", "600"));
if (!existsSync(path.join(dist, "index.html"))) {
  console.error(`No build at ${dist} — run \`npx vite build\` in apps/web first.`);
  process.exit(2);
}
const html = readFileSync(path.join(dist, "index.html"), "utf8");
const entries = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link[^>]+href="\/?(assets\/[^"]+\.css)"/g)].map((m) => m[1]);

const cache = new Map();
const read = (rel) => {
  if (!cache.has(rel)) {
    const buf = readFileSync(path.join(dist, rel));
    cache.set(rel, { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, text: rel.endsWith(".js") ? buf.toString("utf8") : "" });
  }
  return cache.get(rel);
};
/** Static imports of a built chunk (minified: `import{a}from"./x.js"`, `import"./x.js"`, `export*from"./x.js"`). */
const staticImports = (rel) => {
  const out = new Set();
  const text = read(rel).text;
  for (const m of text.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[^"'()]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    out.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
  return [...out];
};
/** CSS a chunk pulls in when it loads (vite's `__vite__mapDeps` preload list names them). */
const dynamicTargets = (rel) => {
  const out = new Set();
  for (const m of read(rel).text.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+\.js)["']\s*\)/g)) out.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  return [...out];
};

const initial = new Set();
const walk = (rel) => {
  if (initial.has(rel)) return;
  initial.add(rel);
  for (const dep of staticImports(rel)) walk(dep);
};
entries.forEach(walk);
// The HTML entry is a small LOADER (src/bootstrap.ts): its only job is to import() the app
// and show "Prism couldn't start" if that fails. What it imports is the app's real initial
// JS, so a loader's own dynamic imports count as initial.
const LOADER_MAX = 16 * 1024;
const loaders = entries.filter((e) => read(e).raw <= LOADER_MAX);
for (const loader of loaders) dynamicTargets(loader).forEach(walk);

const all = readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => `assets/${f}`);
const lazy = all.filter((f) => !initial.has(f));
const kb = (n) => (n / 1024).toFixed(1).padStart(8);
const sum = (files, key) => files.reduce((a, f) => a + read(f)[key], 0);
const row = (f) => `${kb(read(f).gzip)} KB gzip ${kb(read(f).raw)} KB raw  ${f.replace("assets/", "")}`;

const initialList = [...initial].sort((a, b) => read(b).gzip - read(a).gzip);
console.log(`Build: ${dist}\n`);
console.log(`INITIAL JS (${initialList.length} chunks, loaded before the app starts)`);
for (const f of initialList) console.log("  " + row(f));
const initGzip = sum(initialList, "gzip");
console.log(`  ${kb(initGzip)} KB gzip ${kb(sum(initialList, "raw"))} KB raw  TOTAL   (budget ${budgetKb} KB gzip → ${initGzip / 1024 <= budgetKb ? "PASS" : "MISS"})`);
if (css.length) console.log(`\nINITIAL CSS\n${css.map((f) => "  " + row(f)).join("\n")}`);

// Which feature chunks are lazy (the row names editor, database, canvas, graph, map).
const FEATURES = {
  editor: /^(DocumentRenderer|CollabEditor|CollabDoc|editor|tiptap|prosemirror)/i,
  database: /^(DatabaseRenderer|DatabaseBlock|database)/i,
  canvas: /^(CanvasRenderer|CollabCanvas|excalidraw|percentages|subset-shared)/i,
  graph: /^(GraphCanvas3D|GraphRenderer|graph)/i,
  map: /^(MapRenderer|CommonsMap|maplibre|map)/i,
  code: /^(CodeRenderer|CollabCodeEditor|codemirror)/i,
  spreadsheet: /^(SpreadsheetRenderer|CollabSpreadsheet)/i,
};
console.log("\nFEATURE CHUNKS");
const features = {};
for (const [name, re] of Object.entries(FEATURES)) {
  const base = (f) => f.replace("assets/", "");
  const lz = lazy.filter((f) => re.test(base(f)));
  const eager = initialList.filter((f) => re.test(base(f)));
  features[name] = { lazy: lz.map(base), eager: eager.map(base) };
  console.log(`  ${name.padEnd(12)} ${lz.length ? `lazy (${lz.length} chunk${lz.length > 1 ? "s" : ""}, ${kb(sum(lz, "gzip")).trim()} KB gzip): ${lz.slice(0, 4).map(base).join(", ")}${lz.length > 4 ? ", …" : ""}` : "NO lazy chunk of its own"}${eager.length ? `  | eager: ${eager.map(base).join(", ")}` : ""}`);
}
// Is a library inside the initial chunks? (a marker string that survives minification)
const MARKERS = {
  "tiptap/prosemirror (editor)": "ProseMirror-",
  "yjs (collab)": "Unexpected end of array",
  "hocuspocus provider": "HocuspocusProvider",
  "codemirror": "cm-editor",
  "excalidraw": "excalidraw",
  "maplibre": "maplibregl-ctrl",
  "three / force-graph": "THREE.WebGLRenderer",
  "lowlight / highlight.js": "hljs",
  "marked": "marked",
  "turndown": "turndown",
  "emoji-picker": "epr-",
  "katex": "katex",
  "mermaid": "mermaid",
};
const initialText = initialList.map((f) => read(f).text).join("\n");
console.log("\nLIBRARIES FOUND IN THE INITIAL CHUNKS (marker strings)");
const libs = {};
for (const [name, marker] of Object.entries(MARKERS)) {
  libs[name] = initialText.includes(marker);
  console.log(`  ${libs[name] ? "IN INITIAL" : "lazy/absent"}  ${name}`);
}
const lazyTop = lazy.sort((a, b) => read(b).gzip - read(a).gzip);
console.log(`\nLAZY JS (${lazy.length} chunks, ${kb(sum(lazy, "gzip")).trim()} KB gzip in all) — largest 15`);
for (const f of lazyTop.slice(0, 15)) console.log("  " + row(f));
const firstHop = new Set(initialList.flatMap(dynamicTargets).filter((f) => !initial.has(f)));
console.log(`\n${firstHop.size} lazy chunks are reachable by one import() from the initial set.`);

const out = arg("json");
if (out) {
  writeFileSync(out, JSON.stringify({
    dist, budgetKb,
    initial: { gzip: initGzip, raw: sum(initialList, "raw"), chunks: initialList.map((f) => ({ file: f, gzip: read(f).gzip, raw: read(f).raw })) },
    lazy: { count: lazy.length, gzip: sum(lazy, "gzip") }, features, libs,
  }, null, 2));
}
process.exitCode = initGzip / 1024 <= budgetKb ? 0 : 1;

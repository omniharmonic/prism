/**
 * NP-PF-08 helper: what does the app's ENTRY reach through STATIC imports?
 * Bundler-independent (an esbuild metafile, a few seconds — a production `vite build`
 * takes minutes): everything statically reachable from src/bootstrap.ts → src/main.tsx
 * has to be downloaded before the app starts, whatever the chunking.
 *
 *   node apps/web/scripts/perf-static-graph.mjs            # totals by package
 *   node apps/web/scripts/perf-static-graph.mjs --why maplibre-gl   # one import chain to it
 *   node apps/web/scripts/perf-static-graph.mjs --files --top 40    # largest first-party modules in the static set
 *   node apps/web/scripts/perf-static-graph.mjs --edges 'node_modules/(@tiptap|prosemirror|yjs)'   # who imports it directly
 *
 *   node apps/web/scripts/perf-static-graph.mjs --frontier '(@tiptap|prosemirror)'   # modules just outside the heavy set
 *   node apps/web/scripts/perf-static-graph.mjs --from core/shell.ts --reaches '@tiptap'   # which direct imports lead there
 *   node apps/web/scripts/perf-static-graph.mjs --assert-lazy @tiptap,prosemirror-view     # exit 1 if any is static (check:initial)
 *
 * Sizes are esbuild-minified bytes per package (not gzip, not rollup's exact output);
 * use scripts/perf-bundle.mjs on a real build for the budget number.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const why = process.argv.includes("--why") ? process.argv[process.argv.indexOf("--why") + 1] : null;
const top = Number(process.argv.includes("--top") ? process.argv[process.argv.indexOf("--top") + 1] : 40);
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/bootstrap.ts"],
  bundle: true, splitting: true, format: "esm", minify: true, write: false, metafile: true, outdir: "out",
  jsx: "automatic", logLevel: "silent", target: "es2020",
  define: { "import.meta.env.VITE_PRISM_NATIVE": "undefined", "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"' },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".json": "json", ".wasm": "empty" },
  alias: {
    "@tauri-apps/api/core": path.join(root, "src/tauri-shim/core.ts"),
    "@tauri-apps/api/event": path.join(root, "src/tauri-shim/event.ts"),
  },
  external: ["virtual:*"],
  // Stylesheets (and package CSS exports esbuild cannot resolve) are not JavaScript: empty.
  plugins: [{ name: "no-css", setup(b) { b.onResolve({ filter: /\.css(\?.*)?$/ }, (a) => ({ path: a.path, namespace: "no-css" })); b.onLoad({ filter: /.*/, namespace: "no-css" }, () => ({ contents: "", loader: "js" })); } }],
});
const inputs = result.metafile.inputs;
const entry = Object.keys(inputs).find((k) => k.endsWith("src/bootstrap.ts"));
// The bootstrap only exists to import() the app: follow dynamic imports of the entry file itself.
const reach = new Map([[entry, null]]);
const queue = [entry];
while (queue.length) {
  const file = queue.shift();
  for (const imp of inputs[file]?.imports ?? []) {
    if (imp.external || !inputs[imp.path]) continue;
    const isStatic = imp.kind === "import-statement" || imp.kind === "require-call";
    if (!isStatic && file !== entry) continue;
    if (!reach.has(imp.path)) { reach.set(imp.path, file); queue.push(imp.path); }
  }
}
// Bytes each input contributes to the outputs.
const bytes = new Map();
for (const out of Object.values(result.metafile.outputs)) for (const [file, v] of Object.entries(out.inputs)) bytes.set(file, (bytes.get(file) ?? 0) + v.bytesInOutput);
const group = (p) => {
  const m = p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (m) return m[m.length - 1].replace("node_modules/", "");
  const c = p.match(/packages\/core\/src\/([^/]+\/[^/]+)/);
  if (c) return "core/" + c[1];
  const w = p.match(/src\/([^/]+)/);
  return w ? "web/" + w[1] : p;
};
if (process.argv.includes("--assert-lazy")) {
  // Guard (NP-PF-08): none of these may be statically reachable from the entry. Exit 1 with one chain each.
  const names = process.argv[process.argv.indexOf("--assert-lazy") + 1].split(",");
  let bad = 0;
  for (const name of names) {
    const hit = [...reach.keys()].find((k) => k.includes(name));
    if (!hit) continue;
    bad++;
    const chain = [];
    for (let f = hit; f; f = reach.get(f)) chain.push(f);
    console.error(`"${name}" is in the app's initial JavaScript:\n  ` + chain.reverse().join("\n  → ") + "\n");
  }
  if (bad) { console.error("Boot-path modules import `@prism/core/shell`, never `@prism/core`; editor code is import()ed."); process.exit(1); }
  console.log(`Lazy as required: ${names.join(", ")}`);
  process.exit(0);
}
if (why) {
  const hit = [...reach.keys()].find((k) => k.includes(why));
  if (!hit) { console.log(`"${why}" is NOT statically reachable from the entry (it is lazy or unused).`); process.exit(0); }
  const chain = [];
  for (let f = hit; f; f = reach.get(f)) chain.push(f);
  console.log(`"${why}" is reached statically:\n  ` + chain.reverse().join("\n  → "));
  process.exit(0);
}
if (process.argv.includes("--edges")) {
  // Every FIRST-PARTY module in the static set that directly imports something matching
  // the pattern (a regex over module paths) — the edges to cut to make that code lazy.
  const pattern = new RegExp(process.argv[process.argv.indexOf("--edges") + 1]);
  const rows = new Map();
  for (const file of reach.keys()) {
    if (file.includes("node_modules")) continue;
    for (const imp of inputs[file]?.imports ?? []) {
      if (imp.external || !reach.has(imp.path)) continue;
      if (imp.kind !== "import-statement" && imp.kind !== "require-call") continue;
      if (!pattern.test(imp.path) || (!imp.path.includes("node_modules") && pattern.test(file))) continue;
      const k = file.replace("../../packages/core/src/", "core/");
      rows.set(k, [...(rows.get(k) ?? []), group(imp.path)]);
    }
  }
  for (const [f, to] of [...rows].sort()) console.log(`${f}\n      → ${[...new Set(to)].join(", ")}`);
  console.log(`\n${rows.size} first-party modules in the static set import /${pattern.source}/ directly.`);
  process.exit(0);
}
if (process.argv.includes("--frontier")) {
  // First-party modules that import the pattern DIRECTLY form the "heavy" set; print every
  // static-set module OUTSIDE that set which imports a member (the places a lazy boundary can go).
  const pattern = new RegExp(process.argv[process.argv.indexOf("--frontier") + 1]);
  const statics = (file) => (inputs[file]?.imports ?? []).filter((i) => !i.external && reach.has(i.path) && (i.kind === "import-statement" || i.kind === "require-call")).map((i) => i.path);
  const short = (f) => f.replace("../../packages/core/src/", "core/");
  const heavy = new Set([...reach.keys()].filter((f) => !f.includes("node_modules") && statics(f).some((i) => i.includes("node_modules") && pattern.test(i))));
  const rows = new Map();
  for (const file of reach.keys()) {
    if (file.includes("node_modules") || heavy.has(file)) continue;
    const to = statics(file).filter((i) => heavy.has(i)).map(short);
    if (to.length) rows.set(short(file), to);
  }
  for (const [f, to] of [...rows].sort()) console.log(`${f}\n      → ${to.join(", ")}`);
  console.log(`\n${heavy.size} modules import /${pattern.source}/ directly; ${rows.size} other modules import one of those.`);
  process.exit(0);
}
if (process.argv.includes("--from")) {
  // Which DIRECT static imports of one module lead (transitively, statically) to the pattern?
  //   --from core/index.ts --reaches '@tiptap|prosemirror'
  const from = process.argv[process.argv.indexOf("--from") + 1];
  const pattern = new RegExp(process.argv[process.argv.indexOf("--reaches") + 1]);
  const statics = (file) => (inputs[file]?.imports ?? []).filter((i) => !i.external && inputs[i.path] && (i.kind === "import-statement" || i.kind === "require-call")).map((i) => i.path);
  const memo = new Map();
  const leads = (file) => {
    if (memo.has(file)) return memo.get(file);
    memo.set(file, null);
    let hit = file.includes("node_modules") && pattern.test(file) ? file : null;
    if (!hit && !file.includes("node_modules")) for (const i of statics(file)) { const h = leads(i); if (h) { hit = `${i.replace("../../packages/core/src/", "core/")}`; break; } }
    memo.set(file, hit);
    return hit;
  };
  for (const start of Object.keys(inputs).filter((k) => k.replace("../../packages/core/src/", "core/").endsWith(from))) {
    console.log(start);
    for (const i of statics(start)) { const h = leads(i); if (h) console.log(`   ${i.replace("../../packages/core/src/", "core/")}   (via ${h})`); }
  }
  process.exit(0);
}
if (process.argv.includes("--files")) {
  // The largest first-party modules in the static set (candidates for React.lazy / import()).
  const rows = [...reach.keys()].filter((f) => !f.includes("node_modules")).map((f) => [f, bytes.get(f) ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [f, n] of rows) console.log(`${(n / 1024).toFixed(1).padStart(7)} KB  ${f.replace("../../packages/core/src/", "core/")}`);
  process.exit(0);
}
const by = new Map();
let total = 0;
for (const file of reach.keys()) { const n = bytes.get(file) ?? 0; total += n; by.set(group(file), (by.get(group(file)) ?? 0) + n); }
const all = [...bytes.values()].reduce((a, b) => a + b, 0);
console.log(`Statically reachable from the entry: ${reach.size} modules, ${(total / 1024).toFixed(0)} KB minified (of ${(all / 1024).toFixed(0)} KB in the whole app).\n`);
for (const [g, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(n / 1024).toFixed(0).padStart(6)} KB ${((100 * n) / total).toFixed(1).padStart(5)}%  ${g}`);

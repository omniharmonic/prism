/**
 * The Prism Client's third-party licence list — pure parts (no process spawning, no network).
 * generate.mjs runs `cargo metadata` and reads the native web build's module list, then calls these.
 *
 *  - rustCrates(metadata, platform): crates linked into the app for one target (normal dependency
 *    edges from the root crate; build-script and dev-only dependencies are not shipped).
 *  - npmPackages(modules, repoRoot): the npm packages whose files rendered into apps/web/dist-native.
 *  - parseSpdx / judge: an SPDX expression against policy.json (allowed, listed, denied, unknown).
 *  - render: THIRD-PARTY-LICENSES.md — the component table, one text per licence family, the
 *    copyright lines of every component, licence texts that differ from the family text, and every
 *    NOTICE file in full.
 * Dependency-free (node:fs, node:path, node:crypto).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicen[cs]e|copyright)([._-].*)?$/i;
const CODE_FILE = /\.(m?js|cjs|ts|rs|py|sh|json|toml|ya?ml|html?)$/i;
const NOTICE_FILE = /^notice([._-].*)?$/i;
const MAX_FILE = 512 * 1024;

/** Licence and notice files at the top of a package directory, sorted by name. */
export function licenceFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!LICENCE_FILE.test(name) || CODE_FILE.test(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE) continue;
    const text = readFileSync(p, "utf8").replace(/\r\n?/g, "\n").trim();
    if (text) out.push({ name, text, notice: NOTICE_FILE.test(name) });
  }
  return out;
}

// ── SPDX expressions ────────────────────────────────────────────────────────────────────────────

/**
 * Parse an SPDX licence expression into {op: "or"|"and", args} / {id, exception?}.
 * Accepts the legacy forms crates and npm packages still use: "MIT/Apache-2.0" (= OR), lower-case
 * operators, and npm's "(MIT OR Apache-2.0)". Throws on anything it cannot read.
 */
export function parseSpdx(input) {
  const src = String(input ?? "").trim();
  if (!src) throw new Error("empty licence expression");
  const tokens = src
    .replace(/\s*\/\s*/g, " OR ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const isOp = (t, op) => typeof t === "string" && t.toUpperCase() === op;
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of "${src}"`);
    if (t === "(") {
      const e = orExpr();
      if (next() !== ")") throw new Error(`missing ")" in "${src}"`);
      return e;
    }
    if (t === ")" || isOp(t, "AND") || isOp(t, "OR") || isOp(t, "WITH")) throw new Error(`unexpected "${t}" in "${src}"`);
    if (!/^[A-Za-z0-9.+:-]+$/.test(t)) throw new Error(`not a licence id: "${t}" in "${src}"`);
    const leaf = { id: t };
    if (isOp(peek(), "WITH")) {
      next();
      const ex = next();
      if (!ex || !/^[A-Za-z0-9.+-]+$/.test(ex)) throw new Error(`missing exception after WITH in "${src}"`);
      leaf.exception = ex;
    }
    return leaf;
  }
  function andExpr() {
    const args = [primary()];
    while (isOp(peek(), "AND")) {
      next();
      args.push(primary());
    }
    return args.length === 1 ? args[0] : { op: "and", args };
  }
  function orExpr() {
    const args = [andExpr()];
    while (isOp(peek(), "OR")) {
      next();
      args.push(andExpr());
    }
    return args.length === 1 ? args[0] : { op: "or", args };
  }
  const tree = orExpr();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}" in "${src}"`);
  return tree;
}

const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/** One licence id (with its exception) under the policy: allowed | listed | denied | unknown. */
export function classifyId(leaf, policy) {
  const id = leaf.id;
  if ((policy.denied ?? []).some((g) => globToRe(g).test(id))) return { status: "denied", why: `${id} is a copyleft licence` };
  if (leaf.exception && !(policy.exceptions ?? {})[leaf.exception]) return { status: "unknown", why: `unknown licence exception ${leaf.exception}` };
  if ((policy.allowed ?? {})[id]) return { status: "allowed" };
  if ((policy.listed ?? {})[id]) return { status: "listed" };
  return { status: "unknown", why: `${id} is not in the licence policy` };
}

const RANK = { allowed: 0, listed: 1, unknown: 2, denied: 3 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/**
 * Judge an expression: the licences the component is USED UNDER (for an OR, the policy's preferred
 * acceptable branch), and the overall status (the worst licence that must be honoured).
 */
export function judge(expression, policy) {
  let tree;
  try {
    tree = parseSpdx(expression);
  } catch (e) {
    return { status: "unknown", chosen: [], why: e.message };
  }
  const prefer = policy.prefer ?? [];
  const pref = (ids) => Math.min(...ids.map((id) => (prefer.indexOf(id) < 0 ? prefer.length : prefer.indexOf(id))));
  const walk = (n) => {
    if (n.id) {
      const c = classifyId(n, policy);
      return { status: c.status, chosen: [n.exception ? `${n.id} WITH ${n.exception}` : n.id], why: c.why };
    }
    const parts = n.args.map(walk);
    if (n.op === "and") {
      return {
        status: parts.map((p) => p.status).reduce(worst),
        chosen: [...new Set(parts.flatMap((p) => p.chosen))],
        why: parts.map((p) => p.why).filter(Boolean).join("; ") || undefined,
      };
    }
    // OR: the best status; among equals, the policy's preferred licences.
    const best = Math.min(...parts.map((p) => RANK[p.status]));
    const ties = parts.filter((p) => RANK[p.status] === best).sort((a, b) => pref(a.chosen) - pref(b.chosen));
    return ties[0];
  };
  const r = walk(tree);
  return { status: r.status, chosen: r.chosen, why: r.status === "allowed" || r.status === "listed" ? undefined : r.why };
}

/** The base licence id of a "chosen" entry ("Apache-2.0 WITH LLVM-exception" → "Apache-2.0"). */
export const familyOf = (chosen) => chosen.split(" WITH ")[0];

// ── Rust crates ─────────────────────────────────────────────────────────────────────────────────

/**
 * Crates linked into the app for one target, from `cargo metadata --filter-platform <target>`.
 * Follows only NORMAL dependency edges from the root (build-dependencies run at build time and
 * dev-dependencies only in tests; neither ships). Path/workspace crates (no registry source) are
 * Prism's own and are left out.
 */
export function rustCrates(metadata, platform) {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const root = metadata.resolve.root;
  if (!root || !nodes.has(root)) throw new Error("cargo metadata has no root package");
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      if ((d.dep_kinds ?? []).some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  const out = [];
  for (const id of seen) {
    const p = byId.get(id);
    if (!p || id === root || !p.source) continue;
    const dir = dirname(p.manifest_path);
    let expression = p.license ?? null;
    let files = licenceFiles(dir);
    if (p.license_file) {
      const f = join(dir, p.license_file);
      if (existsSync(f) && !files.some((x) => join(dir, x.name) === f)) {
        files = [...files, { name: p.license_file, text: readFileSync(f, "utf8").replace(/\r\n?/g, "\n").trim(), notice: false }];
      }
    }
    out.push({
      kind: "crate",
      name: p.name,
      version: p.version,
      expression,
      homepage: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
      platforms: [platform],
      files,
    });
  }
  return out;
}

/** Merge per-platform crate lists (same name@version → one entry with both platforms). */
export function mergePlatforms(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const c of list) {
      const k = `${c.kind}:${c.name}@${c.version}`;
      const have = map.get(k);
      if (have) have.platforms = [...new Set([...have.platforms, ...c.platforms])];
      else map.set(k, { ...c, platforms: [...c.platforms] });
    }
  }
  return [...map.values()];
}

// ── npm packages ────────────────────────────────────────────────────────────────────────────────

function declared(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && "type" in pkg.license) return String(pkg.license.type);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => String(l?.type ?? "?")).join(" OR ");
  return null;
}

/** The package directory of a file under node_modules (the segment after the LAST node_modules/). */
export function packageDirOf(file) {
  const at = file.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const rest = file.slice(at + "node_modules/".length).split("/");
  const n = rest[0]?.startsWith("@") ? 2 : 1;
  if (rest.length <= n) return null;
  return file.slice(0, at + "node_modules/".length) + rest.slice(0, n).join("/");
}

/**
 * npm packages that ship in the native web build: every file of the build's module list
 * (apps/web/dist-native.modules.json) that lives under node_modules, mapped to its package.
 * Workspace packages (@prism/core, through a symlink) resolve to their source and are not listed.
 */
export function npmPackages(modules, repoRoot) {
  const dirs = new Set();
  for (const m of modules) {
    const d = packageDirOf(m);
    if (d) dirs.add(d);
  }
  const out = new Map();
  for (const rel of [...dirs].sort()) {
    const dir = join(repoRoot, rel);
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) throw new Error(`${rel}: bundled, but has no package.json`);
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name || !pkg.version) throw new Error(`${rel}/package.json has no name or version`);
    const key = `${pkg.name}@${pkg.version}`;
    if (out.has(key)) continue;
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    out.set(key, {
      kind: "npm",
      name: pkg.name,
      version: pkg.version,
      expression: declared(pkg),
      homepage: typeof pkg.homepage === "string" ? pkg.homepage : repo ? String(repo).replace(/^git\+/, "").replace(/\.git$/, "") : `https://www.npmjs.com/package/${pkg.name}`,
      platforms: ["macOS", "iOS"],
      files: licenceFiles(dir),
      path: relative(repoRoot, dir),
    });
  }
  return [...out.values()];
}

// ── Policy ──────────────────────────────────────────────────────────────────────────────────────

/** Licence families a file NAME names ("LICENSE-APACHE" → Apache-2.0), or [] for a generic name. */
export function familiesNamedBy(fileName) {
  const n = fileName.toUpperCase().replace(/\.(TXT|MD)$/, "");
  const out = [];
  if (/APACHE/.test(n)) out.push("Apache-2.0");
  if (/(^|[-_.])MIT($|[-_.])/.test(n) && !/LIBM/.test(n)) out.push("MIT", "MIT-0");
  if (/(^|[-_.])BSD/.test(n)) out.push("BSD-2-Clause", "BSD-3-Clause", "0BSD");
  if (/^UNLICEN[CS]E/.test(n)) out.push("Unlicense");
  if (/(^|[-_.])ZLIB/.test(n)) out.push("Zlib");
  if (/(^|[-_.])(BOOST|BSL)/.test(n)) out.push("BSL-1.0");
  if (/(^|[-_.])ISC/.test(n)) out.push("ISC");
  if (/(^|[-_.])CC0/.test(n)) out.push("CC0-1.0");
  return out;
}

/**
 * The licence files that apply to how a component is used: a dual-licensed crate used under MIT
 * ships LICENSE-MIT and LICENSE-APACHE, and only the first applies. Files with a generic name
 * (LICENSE, COPYING, COPYRIGHT, NOTICE, LICENSE-THIRD-PARTY …) are always kept.
 */
export function relevantFiles(files, chosen) {
  const fams = new Set(chosen.map(familyOf));
  return files.filter((f) => {
    if (f.notice) return true;
    const named = familiesNamedBy(f.name);
    return named.length === 0 || named.some((x) => fams.has(x));
  });
}

/** Apply policy overrides and judge every component. Returns the components + the findings. */
export function applyPolicy(components, policy) {
  const findings = [];
  const used = new Set();
  const judged = components.map((c) => {
    const keys = [`${c.kind}:${c.name}@${c.version}`, `${c.kind}:${c.name}`];
    const ov = keys.map((k) => [k, (policy.packages ?? {})[k]]).find(([, v]) => v);
    let expression = c.expression;
    let note;
    let bundles;
    if (ov) {
      used.add(ov[0]);
      if (!ov[1].reason) findings.push({ level: "error", component: c, why: `policy override ${ov[0]} has no reason` });
      if (ov[1].licence) expression = ov[1].licence;
      note = ov[1].reason;
      bundles = ov[1].bundles;
    }
    const j = expression ? judge(expression, policy) : { status: "unknown", chosen: [], why: "no declared licence" };
    const files = j.chosen.length ? relevantFiles(c.files, j.chosen) : c.files;
    const out = { ...c, bundles, files, shippedFiles: c.files.map((f) => f.name), effective: expression, chosen: j.chosen, status: j.status, note };
    for (const b of bundles ?? []) {
      const bj = judge(b.licence, policy);
      if (bj.status === "denied" || bj.status === "unknown") findings.push({ level: "error", component: out, why: `bundled ${b.what}: ${bj.why ?? bj.status}` });
    }
    if (j.status === "denied" || j.status === "unknown") findings.push({ level: "error", component: out, why: j.why ?? j.status });
    else if (j.status === "listed") findings.push({ level: "listed", component: out, why: j.chosen.map(familyOf).filter((id) => policy.listed?.[id]).map((id) => `${id}: ${policy.listed[id]}`).join("; ") });
    return out;
  });
  for (const k of Object.keys(policy.packages ?? {})) {
    if (!used.has(k)) findings.push({ level: "warning", why: `policy override ${k} matches no shipped component (remove it)` });
  }
  return { components: judged, findings };
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────

/** A copyright line: starts with "Copyright"/"(c)"/"©" and names a year or a (c)/© mark. */
export function isCopyrightLine(line) {
  const l = line.trim().replace(/^[#>*\-\s]+/, "");
  if (!/^(copyright\b|\(c\)|©)/i.test(l)) return false;
  if (/\[yyyy\]|\{yyyy\}|<year>|\[year\]|\[name of copyright owner\]|\{name of copyright owner\}/i.test(l)) return false;
  return /\d{4}|\(c\)|©/i.test(l);
}

const TITLE = /^(the\s+)?\(?(the\s+)?[a-z0-9 .\-()]{0,40}\blicen[cs]e\)?(\s*\([a-z0-9.\- ]+\))?\s*(version\s*[0-9.]+)?:?$/i;

/** The text without its copyright lines and title line, whitespace collapsed: what a family shares. */
export function normalizeText(text) {
  const lines = text.split("\n").filter((l) => !isCopyrightLine(l) && !/^\s*all rights reserved\.?\s*$/i.test(l));
  while (lines.length && (lines[0].trim() === "" || (TITLE.test(lines[0].trim().replace(/^#+\s*/, "")) && lines[0].trim().length < 60))) lines.shift();
  return lines.join(" ").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const stripCopyright = (text) => text.split("\n").filter((l) => !isCopyrightLine(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const label = (c) => `${c.name} ${c.version}`;
const fence = (t) => {
  let f = "```";
  while (t.includes(f)) f += "`";
  return `${f}text\n${t}\n${f}`;
};

/**
 * One representative text per licence family: the most common normalized text among the licence
 * files of components used under exactly that one licence (dual-licensed crates' LICENSE-MIT /
 * LICENSE-APACHE count for the family their file name names).
 */
export function familyTexts(components) {
  const votes = new Map(); // family → normalized → {count, text}
  const vote = (fam, file) => {
    const n = normalizeText(file.text);
    if (n.length < 80) return;
    const m = votes.get(fam) ?? new Map();
    const v = m.get(n) ?? { count: 0, text: stripCopyright(file.text) };
    v.count++;
    m.set(n, v);
    votes.set(fam, m);
  };
  for (const c of components) {
    const fams = [...new Set(c.chosen.map(familyOf))];
    const texts = c.files.filter((f) => !f.notice);
    for (const f of texts) {
      if (fams.length === 1 && texts.length === 1) vote(fams[0], f);
      else {
        const hint = fams.find((fam) => f.name.toUpperCase().includes(fam.split("-")[0].toUpperCase()));
        if (hint) vote(hint, f);
      }
    }
  }
  const out = new Map();
  for (const [fam, m] of votes) {
    const best = [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0];
    out.set(fam, { normalized: best[0], text: best[1].text });
  }
  return out;
}

/** THIRD-PARTY-LICENSES.md. */
export function render(components, { title, generator, policy }) {
  const sorted = [...components].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  const crates = sorted.filter((c) => c.kind === "crate");
  const npm = sorted.filter((c) => c.kind === "npm");
  const fams = familyTexts(sorted);
  const byFamily = new Map();
  for (const c of sorted) for (const f of new Set(c.chosen.map(familyOf))) byFamily.set(f, [...(byFamily.get(f) ?? []), c]);
  const famOrder = [...byFamily.keys()].sort((a, b) => byFamily.get(b).length - byFamily.get(a).length || a.localeCompare(b));
  const knownNormalized = new Set([...fams.values()].map((f) => f.normalized));

  const L = [];
  L.push(`# Third-party software in ${title}`, "");
  L.push(
    `Generated by ${generator} from what ships in the app: the Rust crates linked into it`,
    "(`cargo metadata`, normal dependencies of the app crate for macOS and iOS) and the npm packages",
    "whose code or files are in its web build (`apps/web/dist-native`, recorded by the Vite build).",
    "Prism itself is licensed under PolyForm Shield 1.0.0 (LICENSE.md). The components below keep",
    "their own licences.",
    "",
    `${crates.length} Rust crates and ${npm.length} npm packages. A component offered under a choice of`,
    "licences (\"MIT OR Apache-2.0\") is used under the licence in the \"Used under\" column.",
    "",
  );
  const listed = sorted.filter((c) => c.status === "listed");
  if (listed.length) {
    L.push("## File-level copyleft components", "");
    L.push("These are used unmodified; their source is available from the linked upstream projects.", "");
    for (const c of listed) L.push(`- ${label(c)} (${c.kind}) — ${c.chosen.join(" AND ")} — ${c.homepage}`);
    L.push("");
  }
  L.push("## Licences used", "", "| Licence | Components |", "|---|---|");
  for (const f of famOrder) L.push(`| ${f} | ${byFamily.get(f).length} |`);
  L.push("");
  for (const [heading, list] of [["Rust crates", crates], ["npm packages", npm]]) {
    L.push(`## ${heading}`, "", "| Component | Version | Declared licence | Used under | Platforms |", "|---|---|---|---|---|");
    for (const c of list) {
      const decl = (c.expression ?? "(none)").replace(/\|/g, "\\|");
      const used = c.chosen.join(" AND ") + (c.note ? " ¹" : "");
      L.push(`| ${c.name} | ${c.version} | ${decl} | ${used} | ${c.platforms.join(", ")} |`);
    }
    L.push("");
  }
  const bundled = sorted.filter((c) => c.bundles?.length);
  if (bundled.length) {
    L.push("## Content bundled inside these packages", "");
    L.push("Third-party content a package ships under its own licence, as recorded in the licence policy:", "");
    for (const c of bundled) {
      for (const b of c.bundles) L.push(`- ${b.what}, in ${label(c)} — ${b.licence} (https://spdx.org/licenses/${b.licence}.html) — ${b.source}`);
    }
    L.push("");
  }
  const notes = sorted.filter((c) => c.note);
  if (notes.length) {
    L.push("¹ Licence recorded by Prism's licence policy (`apps/client/scripts/licenses/policy.json`):", "");
    for (const c of notes) L.push(`- ${label(c)}: ${c.effective} — ${c.note}`);
    L.push("");
  }

  L.push("---", "", "## Licence texts", "");
  L.push("One text per licence. Copyright lines differ from component to component; they are listed under", "\"Copyright notices\" below.", "");
  for (const f of famOrder) {
    L.push(`### ${f}`, "", `Used by: ${byFamily.get(f).map(label).join(", ")}.`, "");
    const t = fams.get(f);
    if (t) L.push(fence(t.text), "");
    else L.push(`_No component ships this licence's text; it is published at https://spdx.org/licenses/${f}.html._`, "");
    const ex = [...new Set(byFamily.get(f).flatMap((c) => c.chosen.filter((x) => familyOf(x) === f && x.includes(" WITH "))))];
    for (const e of ex) {
      const id = e.split(" WITH ")[1];
      L.push(`With the ${id} exception: ${policy?.exceptions?.[id] ?? ""} (https://spdx.org/licenses/${id}.html)`, "");
    }
  }

  L.push("## Copyright notices", "");
  for (const c of sorted) {
    const lines = [...new Set(c.files.filter((f) => !f.notice).flatMap((f) => f.text.split("\n").filter(isCopyrightLine).map((l) => l.trim())))];
    if (lines.length) L.push(`- **${label(c)}**: ${lines.join("; ")}`);
    else if (!c.files.length) L.push(`- **${label(c)}**: no licence file in the package; it declares ${c.expression ?? "no licence"}.`);
  }
  L.push("");

  // Texts that are not simply a family text with other copyright lines: printed as shipped, once.
  const other = new Map();
  for (const c of sorted) {
    for (const f of c.files) {
      if (f.notice) continue;
      const n = normalizeText(f.text);
      if (knownNormalized.has(n)) continue;
      const k = hash(f.text);
      const e = other.get(k) ?? { text: f.text, users: [] };
      e.users.push(`${label(c)} (${f.name})`);
      other.set(k, e);
    }
  }
  if (other.size) {
    L.push("## Other licence texts, as shipped", "");
    for (const e of other.values()) L.push(`### ${e.users.join(", ")}`, "", fence(e.text), "");
  }
  const notices = new Map();
  for (const c of sorted) {
    for (const f of c.files) {
      if (!f.notice) continue;
      const k = hash(f.text);
      const e = notices.get(k) ?? { text: f.text, users: [] };
      e.users.push(`${label(c)} (${f.name})`);
      notices.set(k, e);
    }
  }
  if (notices.size) {
    L.push("## NOTICE files", "");
    for (const e of notices.values()) L.push(`### ${e.users.join(", ")}`, "", fence(e.text), "");
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

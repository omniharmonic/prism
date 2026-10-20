// node --test apps/client/scripts/licenses/licenses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPolicy,
  familiesNamedBy,
  isCopyrightLine,
  judge,
  licenceFiles,
  mergePlatforms,
  normalizeText,
  npmPackages,
  packageDirOf,
  parseSpdx,
  relevantFiles,
  render,
  rustCrates,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(here, "policy.json"), "utf8"));

const MIT = (who) => `MIT License\n\nCopyright (c) 2020 ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;
const APACHE = `                                 Apache License\n                           Version 2.0, January 2004\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions. "License" shall mean the terms and conditions for use, reproduction, and distribution.\n   copyright notice that is included in or attached to the work\n\n   Copyright [yyyy] [name of copyright owner]`;

function write(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** A fake registry + cargo metadata: app → a (normal) → b (normal); app → build-only (build); app → dev-only (dev). */
function fakeCargo() {
  const reg = mkdtempSync(join(tmpdir(), "prism-lic-crates-"));
  const crate = (name, version, files) => {
    const dir = join(reg, `${name}-${version}`);
    write(join(dir, "Cargo.toml"), `[package]\nname = "${name}"\n`);
    for (const [f, t] of Object.entries(files)) write(join(dir, f), t);
    return join(dir, "Cargo.toml");
  };
  const pkg = (name, version, license, manifest, source = "registry+https://github.com/rust-lang/crates.io-index") => ({
    id: `${name} ${version}`, name, version, license, license_file: null, manifest_path: manifest, source, repository: `https://example.com/${name}`,
  });
  const packages = [
    pkg("app", "1.0.0", "PolyForm-Shield-1.0.0", join(reg, "app/Cargo.toml"), null),
    pkg("a", "1.2.0", "MIT OR Apache-2.0", crate("a", "1.2.0", { "LICENSE-MIT": MIT("Alice"), "LICENSE-APACHE": APACHE, NOTICE: "a NOTICE: includes software from Example" })),
    pkg("b", "0.3.0", "MPL-2.0", crate("b", "0.3.0", { LICENSE: "Mozilla Public License Version 2.0 ..." })),
    pkg("local", "0.1.0", "MIT", join(reg, "local/Cargo.toml"), null),
    pkg("build-only", "1.0.0", "GPL-3.0-only", crate("build-only", "1.0.0", {})),
    pkg("dev-only", "1.0.0", "AGPL-3.0", crate("dev-only", "1.0.0", {})),
  ];
  const edge = (to, kind) => ({ pkg: `${to}`, dep_kinds: [{ kind, target: null }] });
  const metadata = {
    packages,
    resolve: {
      root: "app 1.0.0",
      nodes: [
        { id: "app 1.0.0", deps: [edge("a 1.2.0", null), edge("local 0.1.0", null), edge("build-only 1.0.0", "build"), edge("dev-only 1.0.0", "dev")] },
        { id: "a 1.2.0", deps: [edge("b 0.3.0", null)] },
        { id: "b 0.3.0", deps: [] },
        { id: "local 0.1.0", deps: [] },
        { id: "build-only 1.0.0", deps: [] },
        { id: "dev-only 1.0.0", deps: [] },
      ],
    },
  };
  return metadata;
}

/** A fake repo: node_modules with a scoped package, a nested one, one with no licence, and a GPL one. */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "prism-lic-npm-"));
  const pj = (dir, o) => write(join(root, dir, "package.json"), JSON.stringify(o));
  pj("node_modules/x", { name: "x", version: "1.0.0", license: "MIT", homepage: "https://x.example" });
  write(join(root, "node_modules/x/LICENSE"), MIT("Xavier"));
  write(join(root, "node_modules/x/license-update.mjs"), "// not a licence");
  write(join(root, "node_modules/x/dist/x.js"), "");
  write(join(root, "node_modules/x/dist/sub/package.json"), JSON.stringify({ type: "module" }));
  pj("node_modules/@s/y", { name: "@s/y", version: "2.0.0", license: { type: "ISC" }, repository: { url: "git+https://github.com/s/y.git" } });
  write(join(root, "node_modules/@s/y/LICENSE.md"), "ISC License\n\nCopyright © 2019 Yvonne\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.");
  pj("node_modules/x/node_modules/z", { name: "z", version: "0.1.0", license: "(MIT OR GPL-3.0)" });
  pj("node_modules/nolic", { name: "nolic", version: "1.0.0" });
  pj("node_modules/gpl", { name: "gpl", version: "1.0.0", license: "GPL-2.0-or-later" });
  const modules = [
    "apps/web/src/main.tsx",
    "packages/core/src/index.ts",
    "node_modules/x/dist/x.js",
    "node_modules/x/dist/sub/inner.js",
    "node_modules/@s/y/index.css",
    "node_modules/x/node_modules/z/z.js",
    "node_modules/nolic/a.js",
    "node_modules/gpl/g.js",
  ];
  return { root, modules };
}

test("SPDX: operators, parentheses, WITH, and the legacy slash form", () => {
  assert.deepEqual(parseSpdx("MIT"), { id: "MIT" });
  assert.deepEqual(parseSpdx("MIT/Apache-2.0"), { op: "or", args: [{ id: "MIT" }, { id: "Apache-2.0" }] });
  assert.deepEqual(parseSpdx("Apache-2.0 / MIT"), { op: "or", args: [{ id: "Apache-2.0" }, { id: "MIT" }] });
  assert.deepEqual(parseSpdx("(MIT OR Apache-2.0) AND Unicode-3.0"), { op: "and", args: [{ op: "or", args: [{ id: "MIT" }, { id: "Apache-2.0" }] }, { id: "Unicode-3.0" }] });
  assert.deepEqual(parseSpdx("Apache-2.0 WITH LLVM-exception OR MIT"), { op: "or", args: [{ id: "Apache-2.0", exception: "LLVM-exception" }, { id: "MIT" }] });
  assert.deepEqual(parseSpdx("mit or isc"), { op: "or", args: [{ id: "mit" }, { id: "isc" }] });
  for (const bad of ["", "MIT OR", "(MIT", "MIT)", "AND MIT", "SEE LICENSE IN LICENSE.txt", "MIT WITH"]) assert.throws(() => parseSpdx(bad), bad);
});

test("judge: OR takes the preferred acceptable branch, AND needs every part", () => {
  assert.deepEqual(judge("Apache-2.0 OR MIT", policy), { status: "allowed", chosen: ["MIT"], why: undefined });
  assert.equal(judge("MIT OR GPL-3.0", policy).status, "allowed");
  assert.deepEqual(judge("GPL-3.0 OR MIT", policy).chosen, ["MIT"]);
  assert.deepEqual(judge("(MIT OR Apache-2.0) AND Unicode-3.0", policy).chosen, ["MIT", "Unicode-3.0"]);
  assert.equal(judge("MIT AND GPL-2.0-only", policy).status, "denied");
  assert.equal(judge("LGPL-2.1-or-later", policy).status, "denied");
  assert.equal(judge("AGPL-3.0", policy).status, "denied");
  assert.equal(judge("GPL", policy).status, "denied");
  assert.equal(judge("MPL-2.0", policy).status, "listed");
  assert.equal(judge("EPL-2.0", policy).status, "listed");
  assert.deepEqual(judge("(MPL-2.0 OR Apache-2.0)", policy).chosen, ["Apache-2.0"], "a permissive branch wins over a listed one");
  assert.equal(judge("WTFPL", policy).status, "unknown");
  assert.equal(judge("SEE LICENSE IN x", policy).status, "unknown");
  assert.equal(judge("Apache-2.0 WITH Made-Up-exception", policy).status, "unknown");
  assert.deepEqual(judge("Apache-2.0 WITH LLVM-exception", policy).chosen, ["Apache-2.0 WITH LLVM-exception"]);
});

test("rustCrates: normal edges only, path crates left out, platforms merged", () => {
  const md = fakeCargo();
  const mac = rustCrates(md, "macOS");
  assert.deepEqual(mac.map((c) => c.name).sort(), ["a", "b"], "no root, no path crate, no build/dev-only crate");
  const a = mac.find((c) => c.name === "a");
  assert.deepEqual(a.files.map((f) => f.name), ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]);
  assert.equal(a.files.find((f) => f.name === "NOTICE").notice, true);
  const both = mergePlatforms([mac, rustCrates(md, "iOS").filter((c) => c.name === "a")]);
  assert.deepEqual(both.find((c) => c.name === "a").platforms, ["macOS", "iOS"]);
  assert.deepEqual(both.find((c) => c.name === "b").platforms, ["macOS"]);
});

test("npmPackages: bundled files map to packages; workspace sources and nested package.json files are not packages", () => {
  const { root, modules } = fakeRepo();
  assert.equal(packageDirOf("node_modules/x/node_modules/z/z.js"), "node_modules/x/node_modules/z");
  assert.equal(packageDirOf("node_modules/@s/y/index.css"), "node_modules/@s/y");
  assert.equal(packageDirOf("packages/core/src/index.ts"), null);
  const pkgs = npmPackages(modules, root);
  assert.deepEqual(pkgs.map((p) => p.name).sort(), ["@s/y", "gpl", "nolic", "x", "z"]);
  const x = pkgs.find((p) => p.name === "x");
  assert.deepEqual(x.files.map((f) => f.name), ["LICENSE"], "a script named license-*.mjs is not a licence file");
  assert.equal(pkgs.find((p) => p.name === "@s/y").expression, "ISC");
  assert.equal(pkgs.find((p) => p.name === "@s/y").homepage, "https://github.com/s/y");
  assert.equal(pkgs.find((p) => p.name === "nolic").expression, null);
  assert.throws(() => npmPackages(["node_modules/missing/a.js"], root), /no package.json/);
});

test("policy: copyleft and unknown licences are errors, MPL is listed, overrides need a reason", () => {
  const { root, modules } = fakeRepo();
  const comps = [...rustCrates(fakeCargo(), "macOS"), ...npmPackages(modules, root)];
  const { findings } = applyPolicy(comps, policy);
  const errs = findings.filter((f) => f.level === "error").map((f) => f.component.name).sort();
  assert.deepEqual(errs, ["gpl", "nolic"]);
  assert.deepEqual(findings.filter((f) => f.level === "listed").map((f) => f.component.name), ["b"]);
  assert.ok(findings.some((f) => f.level === "warning" && /npm:khroma@2\.1\.0/.test(f.why)), "an override that matches nothing is reported");

  const p2 = { ...policy, packages: { "npm:nolic@1.0.0": { licence: "MIT", reason: "LICENSE file is MIT" }, "npm:gpl": { licence: "MIT" } } };
  const r2 = applyPolicy(comps, p2);
  const e2 = r2.findings.filter((f) => f.level === "error");
  assert.ok(e2.some((f) => f.component.name === "gpl" && /no reason/.test(f.why)), "an override without a reason is an error");
  assert.ok(!e2.some((f) => f.component.name === "nolic"));
  assert.equal(r2.components.find((c) => c.name === "nolic").note, "LICENSE file is MIT");

  const p3 = { ...policy, packages: { "npm:x": { reason: "fonts", bundles: [{ what: "a font", licence: "GPL-3.0", source: "s" }] } } };
  assert.ok(applyPolicy(comps, p3).findings.some((f) => f.level === "error" && /bundled a font/.test(f.why)), "bundled content is judged too");
});

test("licence files: only the ones that apply to the licence used", () => {
  assert.deepEqual(familiesNamedBy("LICENSE-APACHE"), ["Apache-2.0"]);
  assert.deepEqual(familiesNamedBy("LICENSE-MIT.txt"), ["MIT", "MIT-0"]);
  assert.deepEqual(familiesNamedBy("LICENSE"), []);
  assert.deepEqual(familiesNamedBy("UNLICENSE"), ["Unlicense"]);
  assert.deepEqual(familiesNamedBy("LICENSE-LIBM-MIT"), [], "a bundled-code licence is not the crate's choice");
  const files = [{ name: "LICENSE-APACHE" }, { name: "LICENSE-MIT" }, { name: "COPYING" }, { name: "NOTICE", notice: true }];
  assert.deepEqual(relevantFiles(files, ["MIT"]).map((f) => f.name), ["LICENSE-MIT", "COPYING", "NOTICE"]);
  assert.deepEqual(relevantFiles(files, ["Apache-2.0"]).map((f) => f.name), ["LICENSE-APACHE", "COPYING", "NOTICE"]);
});

test("copyright lines and normalized texts", () => {
  assert.ok(isCopyrightLine("Copyright (c) 2020 Alice"));
  assert.ok(isCopyrightLine("  Copyright 2014 The Rust Project Developers"));
  assert.ok(isCopyrightLine("© 2019 Someone"));
  assert.ok(!isCopyrightLine("   copyright notice that is included in or attached to the work"));
  assert.ok(!isCopyrightLine("   Copyright [yyyy] [name of copyright owner]"));
  assert.ok(!isCopyrightLine("The above copyright notice and this permission notice shall be included"));
  assert.equal(normalizeText(MIT("Alice")), normalizeText(MIT("Bob")), "two MIT texts differ only in their copyright line");
  assert.equal(normalizeText(MIT("Alice")), normalizeText(MIT("Alice").replace("MIT License", "The MIT License (MIT)")));
});

test("render: family texts once, copyright lines per component, NOTICE files in full, odd texts as shipped", () => {
  const { root, modules } = fakeRepo();
  const p = { ...policy, packages: { "npm:nolic@1.0.0": { licence: "MIT", reason: "checked by hand" }, "npm:gpl": { licence: "MIT", reason: "test" } } };
  const md0 = fakeCargo();
  const { components } = applyPolicy([...mergePlatforms([rustCrates(md0, "macOS"), rustCrates(md0, "iOS")]), ...npmPackages(modules, root)], p);
  const md = render(components, { title: "Test App", generator: "test", policy: p });
  assert.match(md, /^# Third-party software in Test App\n/);
  assert.match(md, /2 Rust crates and 5 npm packages/);
  assert.match(md, /\| a \| 1\.2\.0 \| MIT OR Apache-2\.0 \| MIT \| macOS, iOS \|/);
  assert.match(md, /\| z \| 0\.1\.0 \| \(MIT OR GPL-3\.0\) \| MIT \|/);
  assert.match(md, /\| nolic \| 1\.0\.0 \| \(none\) \| MIT ¹ \|/);
  assert.match(md, /## File-level copyleft components\n\nThese are used unmodified[^\n]*\n\n- b 0\.3\.0 \(crate\) — MPL-2\.0 — https:\/\/example\.com\/b/);
  // One MIT text (a's and x's differ only in the copyright line), without any copyright line.
  const mitSection = md.slice(md.indexOf("### MIT"), md.indexOf("###", md.indexOf("### MIT") + 4));
  assert.equal((mitSection.match(/Permission is hereby granted/g) ?? []).length, 1);
  assert.ok(!/Copyright \(c\) 2020/.test(mitSection));
  assert.match(md, /- \*\*a 1\.2\.0\*\*: Copyright \(c\) 2020 Alice/);
  assert.match(md, /- \*\*x 1\.0\.0\*\*: Copyright \(c\) 2020 Xavier/);
  assert.match(md, /- \*\*nolic 1\.0\.0\*\*: no licence file in the package/);
  // a is used under MIT: its LICENSE-APACHE is not reproduced; its NOTICE is, in full.
  assert.ok(!md.includes("TERMS AND CONDITIONS FOR USE"));
  assert.match(md, /## NOTICE files\n\n### a 1\.2\.0 \(NOTICE\)\n\n```text\na NOTICE: includes software from Example\n```/);
  // A text that is no family's text appears as shipped (b's stub MPL file).
  assert.match(md, /## Other licence texts, as shipped[\s\S]*### b 0\.3\.0 \(LICENSE\)/);
  // A licence nobody ships the text of points at SPDX.
  assert.match(md, /### MPL-2\.0[\s\S]*?_No component ships this licence's text; it is published at https:\/\/spdx\.org\/licenses\/MPL-2\.0\.html\._/);
  assert.ok(!/\n{3,}/.test(md));
});

test("a licence text containing a fence cannot break out of its block", () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-lic-fence-"));
  write(join(dir, "LICENSE"), "odd\n```\n# not a heading\n```");
  const files = licenceFiles(dir);
  const md = render([{ kind: "npm", name: "f", version: "1.0.0", expression: "MIT", chosen: ["MIT"], status: "allowed", platforms: ["macOS"], homepage: "h", files }], { title: "T", generator: "g", policy });
  assert.match(md, /````text\nodd\n```\n# not a heading\n```\n````/);
});

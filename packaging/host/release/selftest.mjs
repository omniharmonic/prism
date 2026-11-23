// Run BY the bundled Node of an unpacked (signed) host bundle — the release job's proof that the
// hardened-runtime signature and its entitlements leave the runtime working:
//   <bundle>/runtime/node/bin/node packaging/host/release/selftest.mjs <bundle>
// It exercises V8's JIT (a hot loop gets optimised), WebAssembly (compiled to machine code),
// loads the better-sqlite3 add-on (library validation: it must be signed by the same team), and
// runs tsx's esbuild binary. Any failure exits non-zero. The full server smoke test runs after it.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: selftest.mjs <bundle-dir>");
  process.exit(2);
}
const ok = (what) => console.log(`selftest: ${what} ok`);

// 1. JIT: enough iterations for TurboFan/Maglev to optimise the function.
let acc = 0;
const f = (x) => (x * 31) ^ (x >>> 3);
for (let i = 0; i < 5_000_000; i++) acc = (acc + f(i)) | 0;
if (typeof acc !== "number") throw new Error("jit");
ok("V8 JIT");

// 2. WebAssembly: (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
const { instance } = await WebAssembly.instantiate(wasm);
if (instance.exports.add(2, 3) !== 5) throw new Error("wasm add");
ok("WebAssembly");

// 3. The native add-on, from the bundle.
const require = createRequire(join(bundle, "app", "package.json"));
const Database = require("better-sqlite3");
const db = new Database(":memory:");
if (db.prepare("select 41 + 1 as n").get().n !== 42) throw new Error("sqlite");
db.close();
ok("better-sqlite3 add-on");

// 4. tsx's compiler binary (a separate signed executable).
const esbuildBin = join(bundle, "app/node_modules/tsx/node_modules/@esbuild/darwin-arm64/bin/esbuild");
const alt = join(bundle, "app/node_modules/@esbuild/darwin-arm64/bin/esbuild");
const bin = existsSync(esbuildBin) ? esbuildBin : alt;
if (!existsSync(bin)) throw new Error(`no esbuild binary (looked in ${readdirSync(join(bundle, "app/node_modules")).length} packages)`);
execFileSync(bin, ["--version"], { stdio: "pipe" });
ok("esbuild executable");

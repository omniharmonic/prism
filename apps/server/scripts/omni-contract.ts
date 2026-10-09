/**
 * Check a Hermes against the contract the Omni gateway relies on — one PASS/FAIL line per
 * assumption (scripts/lib/omni-contract.ts; docs/omni-module.md "The contract with Hermes").
 *
 *   node --env-file=.env --import tsx scripts/omni-contract.ts            # safe: no model call
 *   … scripts/omni-contract.ts --turn                                     # + one plain model turn
 *   … scripts/omni-contract.ts --turn --driver stub                       # the same against the stub
 *   … scripts/omni-contract.ts --full --driver fake [--jobs] [--keepalive]  # a dev Hermes on the fake model
 *   … scripts/omni-contract.ts --full --driver stub                       # the stub (omni-dev.sh)
 *
 * It reads the same settings as the server: `OMNI_HERMES_URL` (default http://127.0.0.1:8642)
 * and the key from the variable `OMNI_HERMES_KEY_ENV` names (default `OMNI_HERMES_KEY`).
 * The key goes only in the Authorization header to that URL; redirects are refused; nothing
 * here prints it, a response body, or a header.
 *
 * LOOPBACK ONLY unless `--allow-remote` is given (then https is required): the key must not
 * cross a network in clear text, and this script creates and deletes sessions.
 *
 * `safe` and `--turn` are fit for a production Hermes: they create one session named
 * `omni_contract_<hex>` and delete it. `--turn` sends the model one short message ("Reply
 * with the single word ok."). `--full` needs a model that obeys markers — never run it
 * against production (it refuses a driver-less run).
 */
import { FAKE_DRIVER, STUB_DRIVER, runContract, type ContractCall, type ContractResult } from "./lib/omni-contract";

function fail(msg: string): never {
  console.error(`omni-contract: ${msg}`);
  process.exit(2);
}

const args = new Set(process.argv.slice(2).filter((a) => a.startsWith("--") && !a.includes("=")));
const valueOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : i >= 0 ? process.argv[i + 1] : undefined;
};
if (args.has("--help")) {
  console.log("usage: omni-contract.ts [--turn | --full --driver stub|fake] [--jobs] [--keepalive] [--allow-remote]");
  process.exit(0);
}
const depth = args.has("--full") ? "full" : args.has("--turn") ? "turn" : "safe";
const driverName = valueOf("--driver");
const driver = driverName === "fake" ? FAKE_DRIVER : driverName === "stub" ? STUB_DRIVER : undefined;
if (driverName && !driver) fail("--driver is `stub` or `fake`");
if (depth === "full" && !driver) fail("--full needs --driver stub|fake: its checks send scripted markers a real model would not obey. Use --turn against a real Hermes.");

const base = (process.env.OMNI_HERMES_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
let u: URL;
try {
  u = new URL(base);
} catch {
  fail("OMNI_HERMES_URL is not a URL");
}
const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
if (!loopback) {
  if (!args.has("--allow-remote")) fail(`${u.hostname} is not this machine. This check is for a Hermes on loopback; pass --allow-remote to insist.`);
  if (u.protocol !== "https:") fail("a remote Hermes must be https: the key would cross the network in clear text");
} else if (u.protocol !== "http:" && u.protocol !== "https:") fail("OMNI_HERMES_URL must be http or https");
const keyName = process.env.OMNI_HERMES_KEY_ENV || "OMNI_HERMES_KEY";
const key = process.env[keyName] ?? "";
if (key.length < 16) fail(`no Hermes key: ${keyName} is unset or shorter than 16 characters (run with --env-file=<the server's env file>)`);

const call: ContractCall = (method, path, body, o) =>
  fetch(base + path, {
    method,
    headers: { accept: "application/json, text/event-stream", ...(o?.auth === false ? {} : { authorization: `Bearer ${key}` }), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: o?.signal ?? (path.endsWith("/chat/stream") ? undefined : AbortSignal.timeout(20_000)),
  });

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
const report = (r: ContractResult) => console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.id, 4)}${r.name}\n        ${r.ok ? "" : "→ "}${r.note}`);

console.log(`omni-contract: ${u.origin} · ${depth}${driver ? ` · ${driver.name} model` : ""}${loopback ? "" : " · REMOTE"}`);
runContract({
  call,
  depth,
  driver,
  jobs: args.has("--jobs"),
  keepalive: args.has("--keepalive") ? { silentSeconds: 45, withinMs: 32_000 } : undefined,
  report,
})
  .then((results) => {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${depth === "safe" ? " (safe: no model call was made — add --turn for the stream)" : ""}`);
    if (!results.length) console.log("omni-contract: nothing could be checked");
    process.exit(bad.length || !results.length ? 1 : 0);
  })
  .catch((e) => {
    // A name only: an error message can quote a URL or a header.
    console.error(`omni-contract: could not reach Hermes (${(e as Error).name})`);
    process.exit(1);
  });

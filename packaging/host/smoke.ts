/**
 * Smoke test of a built host bundle, on this Mac, touching nothing outside a scratch folder:
 *
 *   node --import tsx packaging/host/smoke.ts <prism-host-…tar.gz> [--tmp <dir>]
 *
 * It verifies the tarball against SHA256SUMS, unpacks it, runs `prism doctor`, installs to
 * a scratch prefix with `--no-launchd` (and shows the launchd commands of a `--dry-run`
 * install without running them), starts the bundled server in the FOREGROUND on a free high
 * port against a FAKE vault + hub served by this script (so neither :1939/:1940 nor the
 * server port :8787 is touched), checks /health?live=1, /health, /api/version and the web
 * app, takes a backup, stops the server, checks update/uninstall rules, and removes it all.
 * Exit 0 = every check passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const tarball = resolve(argv.find((a) => !a.startsWith("--")) ?? "");
const tmpArg = argv.includes("--tmp") ? argv[argv.indexOf("--tmp") + 1] : undefined;
if (!existsSync(tarball)) throw new Error("usage: smoke.ts <prism-host-…tar.gz>");
const t0 = Date.now();
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const log = (s: string) => console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const freePort = () =>
  new Promise<number>((res) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const FORBIDDEN = new Set([1939, 1940, 8787]);

const root = mkdtempSync(join(tmpArg ?? tmpdir(), "prism-host-smoke-"));
const extract = join(root, "extract");
const prefix = join(root, "Host");
let server: Server | undefined;
let child: ReturnType<typeof spawn> | undefined;
try {
  // 1. checksum
  const sums = readFileSync(join(dirname(tarball), "SHA256SUMS"), "utf8");
  const want = sums.split("\n").find((l) => l.endsWith(`  ${basename(tarball)}`))?.split(" ")[0];
  const got = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  check("tarball matches SHA256SUMS", want === got, got.slice(0, 16));

  // 2. unpack
  spawnSync("mkdir", ["-p", extract]);
  const tx = Date.now();
  const x = spawnSync("/usr/bin/tar", ["-xzf", tarball, "-C", extract]);
  check("unpack", x.status === 0, `${Date.now() - tx} ms`);
  const bundle = join(extract, readdirSync(extract)[0]!);
  const prism = join(bundle, "bin", "prism");
  // Asynchronous on purpose: the fake vault below lives in THIS process and must keep answering.
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env, at: string = prefix) =>
    new Promise<{ code: number | null; json: Record<string, unknown>; stderr: string; stdout: string }>((res) => {
      const c = spawn(prism, [...args, "--prefix", at, "--json"], { stdio: ["ignore", "pipe", "pipe"], env });
      let so = "";
      let se = "";
      c.stdout.on("data", (b: Buffer) => (so += b));
      c.stderr.on("data", (b: Buffer) => (se += b));
      c.on("exit", (code) => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(so.trim().split("\n").pop() ?? "{}");
        } catch {
          json = { raw: so, stderr: se };
        }
        res({ code, json, stderr: se, stdout: so });
      });
    });

  // 3. fake vault + hub
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/health") || url.endsWith("/health")) return void res.end(JSON.stringify({ ok: true }));
    if (url.includes("jwks")) return void res.end(JSON.stringify({ keys: [] }));
    if (url.includes("/api/notes")) return void res.end("[]");
    if (url.includes("/api/tags")) return void res.end("[]");
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const vaultPort = (server.address() as { port: number }).port;
  let port = await freePort();
  while (FORBIDDEN.has(port)) port = await freePort();
  log(`fake vault+hub on :${vaultPort}, server on :${port}, prefix ${prefix}`);

  // 4. version + doctor
  const v = await run(["version"]);
  check("prism version", v.code === 0, String(v.json.version));
  const d = await run(["doctor", "--port", String(port)]);
  check("prism doctor", d.code === 0, (d.json.checks as Array<{ id: string; ok: boolean }>)?.map((c) => `${c.id}:${c.ok ? "ok" : "no"}`).join(" "));

  // 5. a dry run WITH launchd prints the agent and the launchctl commands, changes nothing
  const tokenFile = join(root, "vault-token");
  writeFileSync(tokenFile, "smoke-fake-vault-token\n", { mode: 0o600 });
  const installArgs = ["--owner-email", "owner@example.com", "--port", String(port), "--parachute-url", `http://127.0.0.1:${vaultPort}`, "--parachute-hub-origin", `http://127.0.0.1:${vaultPort}`, "--parachute-token-file", tokenFile];
  const dry = await run(["install", ...installArgs, "--dry-run"]);
  const dryActions = (dry.json.actions as string[]) ?? [];
  check("install --dry-run (launchd) changes nothing", dry.code === 0 && !existsSync(prefix), dryActions.filter((a) => a.startsWith("launchctl") || a.endsWith(".plist")).join(" | "));

  // 6. install without launchd
  const ti = Date.now();
  const inst = await run(["install", ...installArgs, "--no-launchd"]);
  check("install --no-launchd", inst.code === 0, `${Date.now() - ti} ms; ${inst.code === 0 ? "" : JSON.stringify(inst.json)}`);
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
  check("permissions", mode(prefix) === "700" && mode(join(prefix, "config")) === "700" && mode(join(prefix, "config/.env")) === "600" && mode(join(prefix, "data")) === "700", `prefix ${mode(prefix)} config ${mode(join(prefix, "config"))} .env ${mode(join(prefix, "config/.env"))} data ${mode(join(prefix, "data"))}`);
  const envBefore = readFileSync(join(prefix, "config/.env"), "utf8");
  check(".env has no token on argv and holds the file's token", envBefore.includes("PARACHUTE_TOKEN=smoke-fake-vault-token") && !envBefore.includes("1939") && !envBefore.includes(":1940"));
  const again = await run(["install", ...installArgs.filter((a, i, all) => all[i - 1] !== "--parachute-token-file" && a !== "--parachute-token-file"), "--no-launchd"]);
  check("install is idempotent", again.code === 0 && readFileSync(join(prefix, "config/.env"), "utf8") === envBefore, JSON.stringify(again.json.env));

  // 7. the server in the foreground
  const tsrv = Date.now();
  child = spawn(join(prefix, "bin/prism"), ["run", "server", "--foreground", "--prefix", prefix], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (b: Buffer) => (out += b));
  child.stderr?.on("data", (b: Buffer) => (out += b));
  let live = false;
  for (let i = 0; i < 240 && !live; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health?live=1`);
      live = r.status === 200;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("/health?live=1", live, `${Date.now() - tsrv} ms to first answer`);
  const ver = await fetch(`http://127.0.0.1:${port}/api/version`).then((r) => r.json()).catch(() => null);
  check("/api/version reports the bundle version", ver?.version === v.json.version, JSON.stringify(ver));
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status).catch(() => 0);
  check("/health (fake vault reachable)", health === 200, String(health));
  const index = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => "");
  check("web app served from the bundle (WEB_ROOT)", /<div id="root"|<!doctype html/i.test(index), `${index.length} bytes`);
  const st = await run(["status"]);
  check("prism status", st.code === 0, JSON.stringify(st.json.server));
  // `prism reach` with no Tailscale on this "machine" (the real one is never touched): a next step, no change.
  const noTs = { ...process.env, PRISM_TAILSCALE_BIN: join(root, "no-tailscale-here") };
  const rs = await run(["reach", "status"], noTs);
  check("prism reach status without Tailscale says what to install", rs.code === 0 && rs.json.reachable === false && /install the Tailscale app/.test(String(rs.json.next)), String(rs.json.next));
  const rt = await run(["reach", "tailscale", "--dry-run"], noTs);
  check("prism reach tailscale without Tailscale: exit 4, .env unchanged", rt.code === 4 && readFileSync(join(prefix, "config/.env"), "utf8") === envBefore, `exit ${rt.code}`);
  // `prism token status`: the token's facts and the (fake) vault's verdict, never the token.
  const tok = await run(["token", "status"]);
  check("prism token status: set, accepted, the token never on stdout", tok.json.set === true && tok.json.vault === "accepted" && !tok.stdout.includes("smoke-fake-vault-token"), `exit ${tok.code} vault ${String(tok.json.vault)}`);
  // `prism setup --dry-run`: every step reported, nothing written, the (fake) parachute never run.
  const fakeBin = join(root, "fake-parachute");
  writeFileSync(fakeBin, `#!/bin/sh\necho called >> "${join(root, "fake-parachute.calls")}"\nexit 3\n`, { mode: 0o755 });
  const setupEnv = { ...noTs, PARACHUTE_BIN: fakeBin, PRISM_APPLICATIONS_DIRS: join(root, "no-apps") };
  const sd = await run(["setup", "--dry-run"], setupEnv);
  const sdSteps = (sd.json.steps as Array<{ id: string; state: string }>) ?? [];
  check(
    "prism setup --dry-run: every step reported, none failed, .env unchanged, nothing spawned",
    sd.code === 0 && sdSteps.length === (sd.json.stepIds as string[] | undefined)?.length && sdSteps.every((s) => s.state !== "failed") && readFileSync(join(prefix, "config/.env"), "utf8") === envBefore && !existsSync(join(root, "fake-parachute.calls")),
    sdSteps.map((s) => `${s.id}:${s.state}`).join(" "),
  );
  const progressLines = sd.stdout.trim().split("\n").filter((l) => l.startsWith('{"event":"step"'));
  check("prism setup --json: one JSON line per step before the summary", progressLines.length === sdSteps.length, `${progressLines.length} lines`);
  // Stock Parachute run by Prism (the launch plan's fallback), dry runs only: Parachute's own
  // launchd labels are moved (PRISM_PARACHUTE_UNIT_PREFIX) so this Mac's real Parachute, if any,
  // is neither seen nor touched; no launchd agent is loaded and no Parachute is started.
  const stockEnv = { ...setupEnv, PRISM_PARACHUTE_UNIT_PREFIX: "smoke.not-parachute" };
  const sdry = await run(["install", ...installArgs, "--parachute", "stock", "--parachute-bin", fakeBin, "--dry-run"], stockEnv);
  const sActions = ((sdry.json.actions as string[]) ?? []).join(" | ");
  check(
    "install --parachute stock --dry-run: Prism's hub agent + the server agent, no vault agent, nothing loaded",
    sdry.code === 0 && /\.host\.hub\.plist/.test(sActions) && /launchctl bootstrap gui\/\d+ .*\.host\.hub\.plist/.test(sActions) && !/\.host\.vault\.plist/.test(sActions) && !existsSync(join(prefix, "parachute", "vault")),
    sActions.split(" | ").filter((a) => a.includes(".plist")).join(" | "),
  );
  const prefix2 = join(root, "HostStock");
  const pHome = join(root, "parachute-home");
  spawnSync("mkdir", ["-p", pHome]);
  writeFileSync(join(pHome, "hub.db"), "x", { mode: 0o644 });
  const sInst = await run(["install", ...installArgs, "--parachute", "stock", "--parachute-bin", fakeBin, "--parachute-home", pHome, "--no-launchd", "--skip-checks"], stockEnv, prefix2);
  const hubDry = await run(["run", "hub", "--dry-run"], stockEnv, prefix2);
  const hc = hubDry.json.command as { cmd?: string; args?: string[]; env?: Record<string, string> } | null;
  check(
    "prism run hub --dry-run (stock): `parachute serve`, loopback, port 1939, the chosen home; would tighten hub.db; spawns nothing",
    sInst.code === 0 && hubDry.code === 0 && hc?.cmd === fakeBin && hc.args?.join(" ") === "serve" && hc.env?.PARACHUTE_BIND_HOST === "127.0.0.1" && hc.env?.PORT === "1939" && hc.env?.PARACHUTE_HOME === pHome && ((hubDry.json.tighten as Array<{ path: string }>) ?? []).some((t) => t.path === join(pHome, "hub.db")) && (statSync(join(pHome, "hub.db")).mode & 0o777) === 0o644 && !existsSync(join(root, "fake-parachute.calls")),
    `exit ${hubDry.code}; ${JSON.stringify(hc?.args)} ${hc?.env?.PARACHUTE_BIND_HOST} ${hc?.env?.PORT}`,
  );
  const vaultRun = await run(["run", "vault"], stockEnv, prefix2);
  check("prism run vault (stock): exit 0 — the hub's supervisor runs the vault", vaultRun.code === 0 && /supervisor runs the vault/.test(vaultRun.stderr), vaultRun.stderr.trim());
  const sdel = await run(["uninstall", "--delete-data", "--yes"], stockEnv, prefix2);
  check("the stock scratch install is removed; the Parachute home is not Prism's to delete", sdel.code === 0 && !existsSync(prefix2) && existsSync(join(pHome, "hub.db")));
  const lockDry = await run(["setup", "--dry-run"], setupEnv);
  check("prism setup --dry-run reports the run lock as free (and takes none)", (lockDry.json.lock as { state?: string } | undefined)?.state === "free" && !existsSync(join(prefix, ".setup.lock")), JSON.stringify(lockDry.json.lock));

  for (let i = 0; i < 20 && !existsSync(join(prefix, "data/DATA_VERSION")); i++) await new Promise((r) => setTimeout(r, 500));
  check("DATA_VERSION recorded after a healthy start", existsSync(join(prefix, "data/DATA_VERSION")) && readFileSync(join(prefix, "data/DATA_VERSION"), "utf8").trim() === v.json.version);

  // 8. backup while running (online)
  const b = await run(["backup", "--label", "smoke"]);
  const dbs = (b.json.databases as Array<{ file: string; integrity: string }>) ?? [];
  check("prism backup (online, integrity ok)", b.code === 0 && dbs.some((x) => x.file === "prism/prism-server.db" && x.integrity === "ok"), String(b.json.dir ?? JSON.stringify(b.json)));

  // 9. stop
  const ts = Date.now();
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((r) => child!.on("exit", (c) => r(c)));
  check("SIGTERM stops the supervisor", code === 0, `exit ${code} in ${Date.now() - ts} ms`);
  // The supervisor forwarded the signal once and waited for the server's own graceful shutdown.
  check("the server shut down gracefully (stores, clients, database) — no SIGKILL", out.includes("[shutdown] SIGTERM: stopping") && out.includes("[shutdown] done") && !out.includes("killing it") && !out.includes("second signal ("), out.split("\n").filter((l) => l.includes("[shutdown]")).join(" | "));
  child = undefined;

  // 10. update rules on the same bundle
  const same = await run(["update", tarball, "--allow-unsigned"]);
  check("update to the same version is a no-op", same.code === 0 && same.json.status === "unchanged", `${same.json.status} ${same.json.reason ?? ""}`);
  // A real update to a newer bundle (the same build re-stamped 0.0.0-smoke → next patch), then the gate.
  const next = (() => {
    const [a, bb, c] = String(v.json.version).split(/[.-]/).map(Number);
    return `${a}.${bb}.${(c ?? 0) + 1}`;
  })();
  const upDir = join(root, "next");
  spawnSync("mkdir", ["-p", upDir]);
  spawnSync("/usr/bin/tar", ["-xzf", tarball, "-C", upDir]);
  const oldName = readdirSync(upDir)[0]!;
  const newName = oldName.replace(String(v.json.version), next);
  spawnSync("mv", [join(upDir, oldName), join(upDir, newName)]);
  for (const f of ["build-info.json", "app/package.json"]) {
    const p = join(upDir, newName, f);
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.version = next;
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
  const nextTar = join(upDir, `${newName}.tar.gz`);
  spawnSync("/usr/bin/tar", ["-czf", nextTar, "-C", upDir, newName], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  writeFileSync(join(upDir, "SHA256SUMS"), `${createHash("sha256").update(readFileSync(nextTar)).digest("hex")}  ${basename(nextTar)}\n`);
  const bad = join(upDir, "SHA256SUMS.bad");
  writeFileSync(bad, `${"0".repeat(64)}  ${basename(nextTar)}\n`);
  const tampered = await run(["update", nextTar, "--sums", bad, "--allow-unsigned"]);
  check("update refuses a checksum mismatch", tampered.code === 5 && readFileSync(join(prefix, "state.json"), "utf8").includes(`"current": "${v.json.version}"`), String(tampered.json.reason));
  // The smoke's re-stamped tarball has no signature (the release key signs only the published
  // SHA256SUMS): without --allow-unsigned the update is refused and nothing changes.
  const unsigned = await run(["update", nextTar]);
  check("update refuses an unsigned SHA256SUMS", unsigned.code === 5 && readFileSync(join(prefix, "state.json"), "utf8").includes(`"current": "${v.json.version}"`), String(unsigned.json.reason));
  const up = await run(["update", nextTar, "--allow-unsigned"]);
  check("--allow-unsigned says so", Array.isArray(up.json.warnings) && /development builds only/.test(String(up.json.warnings)), JSON.stringify(up.json.warnings));
  check(`update ${v.json.version} → ${next} (not managed: swap only)`, up.code === 0 && up.json.status === "swapped_unmanaged", `${up.json.status} backup ${up.json.backup ? "yes" : "no"}`);
  child = spawn(join(prefix, "bin/prism"), ["run", "server", "--foreground", "--prefix", prefix], { stdio: ["ignore", "pipe", "pipe"] });
  const versionNow = (): Promise<{ version?: string } | null> => fetch(`http://127.0.0.1:${port}/api/version`).then((r) => r.json() as Promise<{ version?: string }>).catch(() => null);
  let ver2 = await versionNow();
  for (let i = 0; i < 240 && ver2?.version !== next; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ver2 = await versionNow();
  }
  check("the swapped install answers the new version", ver2?.version === next, JSON.stringify(ver2));
  for (let i = 0; i < 20 && readFileSync(join(prefix, "data/DATA_VERSION"), "utf8").trim() !== next; i++) await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGTERM");
  await new Promise((r) => child!.on("exit", r));
  child = undefined;
  const down = await run(["update", tarball, "--allow-unsigned"]);
  check("downgrade over newer data is refused", down.code === 6, String(down.json.reason));
  const forced = await run(["update", tarball, "--force", "--dry-run", "--allow-unsigned"]);
  check("--force allows it (dry run)", forced.code === 0 && forced.json.status === "dry_run", String(forced.json.status));

  const start = await run(["start"]);
  check("start refuses a --no-launchd install", start.code === 4, String(start.json.error));

  // 11. uninstall
  const noYes = await run(["uninstall", "--delete-data"]);
  check("--delete-data needs --yes", noYes.code === 9 && existsSync(join(prefix, "data")));
  const un = await run(["uninstall"]);
  check("uninstall keeps data", un.code === 0 && !existsSync(join(prefix, "app")) && existsSync(join(prefix, "data/prism-server.db")) && existsSync(join(prefix, "config/.env")));
  const del = await run(["uninstall", "--delete-data", "--yes"]);
  check("uninstall --delete-data --yes", del.code === 0 && !existsSync(prefix));
  if (results.some((r) => !r.ok)) console.log(out.split("\n").slice(-40).join("\n"));
} finally {
  child?.kill("SIGKILL");
  server?.close();
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

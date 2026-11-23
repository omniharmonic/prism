/**
 * parachute-cli.ts — the one Parachute CLI spawner (launch plan §3.5).
 * Every test runs a FAKE binary (a temp shell script); none reaches a real
 * Parachute install. The fake records its argv, env and stdin under
 * `$PARACHUTE_HOME` (which the helper passes through), so the same files prove
 * "explicit path used", "PARACHUTE_HOME passed" and "env allowlist".
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runParachute,
  runParachuteSync,
  parachuteCliConfig,
  parachuteEnv,
  withBinDirOnPath,
  parseCliJson,
  parseMintedToken,
  assertNoSecretArgs,
  ParachuteCliError,
} from "../src/parachute-cli";
import { mintVaultToken, mintEphemeralAdminToken, revokeVaultToken, setCliRunner } from "../src/mcp-token";
import { createVaultViaCli, setVaultCreator } from "../src/vault-provision";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ jti: "jti-from-jwt", exp: 2_000_000_000, iss: "http://127.0.0.1:19390" })}.c2lnbmF0dXJlc2ln`;

let dir: string;
let home: string;
let hubBin: string;
let vaultBin: string;
const SAVED: Record<string, string | undefined> = {};
const KEYS = ["PARACHUTE_BIN", "PARACHUTE_VAULT_BIN", "PARACHUTE_HOME", "PARACHUTE_CLI_TIMEOUT_MS", "PARACHUTE_CLI_JSON", "PARACHUTE_ADMIN_TOKEN"];

/** A fake CLI. It records argv / env / stdin into $PARACHUTE_HOME, then acts
 *  on the subcommand: mint-token prints a JWT (JSON with --json), `create`
 *  prints vault JSON, `sleep` hangs, `fail` exits 3 with a token on stderr,
 *  `--service` is rejected when $PARACHUTE_HOME/no-service exists (hub 0.7.1). */
function fakeScript(kind: "hub" | "vault"): string {
  return `#!/bin/sh
rec="\${PARACHUTE_HOME:-${dir}/nohome}"
mkdir -p "$rec"
printf '%s\\n' "$0" > "$rec/${kind}.bin"
: > "$rec/${kind}.args"
for a in "$@"; do printf '%s\\n' "$a" >> "$rec/${kind}.args"; done
env > "$rec/${kind}.env"
case "$1" in
  stdin) cat > "$rec/${kind}.stdin"; echo read ;;
  sleep) exec sleep 30 ;;
  fail) echo "boom ${JWT}" >&2; echo "stdout-secret ${JWT}"; exit 3 ;;
  create) echo "notice: creating"; echo '{"name":"'"$2"'","token":"${JWT}","created":true}' ;;
  auth)
    case "$2" in
      revoke-token) echo "revoked $3" ;;
      mint-token)
        for a in "$@"; do
          if [ "$a" = "--service" ] && [ -e "$rec/no-service" ]; then
            echo 'parachute auth mint-token: unknown flag "--service"' >&2; exit 1
          fi
        done
        json=0; for a in "$@"; do [ "$a" = "--json" ] && json=1; done
        if [ $json = 1 ]; then echo '{"token":"${JWT}","jti":"jti-from-json","exp":2100000000}'; else echo "${JWT}"; fi ;;
    esac ;;
esac
`;
}

before(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "prism-pcli-"));
  home = join(dir, "home");
  mkdirSync(home);
  hubBin = join(dir, "bin", "fake-parachute");
  vaultBin = join(dir, "bin", "fake-parachute-vault");
  mkdirSync(join(dir, "bin"));
  writeFileSync(hubBin, fakeScript("hub"));
  writeFileSync(vaultBin, fakeScript("vault"));
  chmodSync(hubBin, 0o755);
  chmodSync(vaultBin, 0o755);
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  setCliRunner(null);
  setVaultCreator(null);
  rmSync(join(home, "no-service"), { force: true });
});

after(() => rmSync(dir, { recursive: true, force: true }));

function useFakes(withHome = true): void {
  process.env.PARACHUTE_BIN = hubBin;
  process.env.PARACHUTE_VAULT_BIN = vaultBin;
  if (withHome) process.env.PARACHUTE_HOME = home;
  else delete process.env.PARACHUTE_HOME;
}
const recorded = (name: string, base = home) => readFileSync(join(base, name), "utf8");
const envOf = (name: string, base = home): Record<string, string> =>
  Object.fromEntries(
    recorded(name, base)
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("defaults: bare names on PATH, no PARACHUTE_HOME, 60 s timeout, no --json", () => {
  const cfg = parachuteCliConfig({});
  assert.deepEqual(cfg, { bin: "parachute", vaultBin: "parachute-vault", home: undefined, timeoutMs: 60_000, json: false });
  const env = parachuteEnv({ HOME: "/h", PATH: "/p" }, cfg);
  assert.equal(env.PARACHUTE_HOME, undefined);
});

test("explicit PARACHUTE_BIN / PARACHUTE_VAULT_BIN are the binaries that run", async () => {
  useFakes();
  await runParachute("hub", ["auth", "revoke-token", "abc"]);
  await runParachute("vault", ["create", "v1", "--json"]);
  assert.equal(recorded("hub.bin").trim(), hubBin);
  assert.equal(recorded("vault.bin").trim(), vaultBin);
  assert.deepEqual(recorded("hub.args").trim().split("\n"), ["auth", "revoke-token", "abc"]);
});

test("PARACHUTE_HOME is passed to the child when set, and absent when unset", async () => {
  useFakes();
  await runParachute("hub", ["auth", "revoke-token", "x"]);
  assert.equal(envOf("hub.env").PARACHUTE_HOME, home);
  useFakes(false);
  await runParachute("hub", ["auth", "revoke-token", "x"]);
  assert.equal(envOf("hub.env", join(dir, "nohome")).PARACHUTE_HOME, undefined);
});

test("env allowlist: secrets and Prism's PORT never reach the child; topology vars do", async () => {
  useFakes();
  const parentEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PARACHUTE_TOKEN: "pvt_should_not_leak_123",
    SESSION_SECRET: "s3cret",
    PARACHUTE_ADMIN_TOKEN: "admin",
    ANTHROPIC_API_KEY: "sk-x",
    PORT: "8787",
    SOME_RANDOM_VAR: "x",
    LC_ALL: "en_US.UTF-8",
    PARACHUTE_HUB_ORIGIN: "http://127.0.0.1:19390",
  };
  await runParachute("hub", ["auth", "revoke-token", "x"], { parentEnv });
  const env = envOf("hub.env");
  for (const k of ["PARACHUTE_TOKEN", "SESSION_SECRET", "PARACHUTE_ADMIN_TOKEN", "ANTHROPIC_API_KEY", "PORT", "SOME_RANDOM_VAR"]) {
    assert.equal(env[k], undefined, `${k} leaked`);
  }
  assert.equal(env.LC_ALL, "en_US.UTF-8");
  assert.equal(env.PARACHUTE_HUB_ORIGIN, "http://127.0.0.1:19390");
  assert.equal(env.HOME, process.env.HOME);
  assert.ok(env.PATH);
});

test("per-call env is added, but a secret-named one is refused", async () => {
  useFakes();
  await runParachute("vault", ["create", "v2", "--json"], { env: { PORT: "19400" } });
  assert.equal(envOf("vault.env").PORT, "19400");
  await assert.rejects(runParachute("vault", ["x"], { env: { PARACHUTE_TOKEN: "t" } }), (e: ParachuteCliError) => e.code === "secret_env");
});

test("timeout: a hung CLI is killed and reported as timed out", async () => {
  useFakes();
  await assert.rejects(runParachute("hub", ["sleep"], { timeoutMs: 150 }), (e: ParachuteCliError) => {
    assert.equal(e.code, "timeout");
    assert.equal(e.timedOut, true);
    return true;
  });
  process.env.PARACHUTE_CLI_TIMEOUT_MS = "150";
  await assert.rejects(runParachute("hub", ["sleep"]), (e: ParachuteCliError) => e.code === "timeout");
  assert.throws(() => runParachuteSync("hub", ["sleep"], { timeoutMs: 150 }), (e: ParachuteCliError) => e.code === "timeout");
});

test("a failing CLI: exit code + scrubbed stderr, never stdout", async () => {
  useFakes();
  for (const run of [
    () => runParachute("hub", ["fail"]),
    async () => runParachuteSync("hub", ["fail"]),
  ]) {
    await assert.rejects(run(), (e: ParachuteCliError) => {
      assert.equal(e.code, "exit");
      assert.equal(e.exitCode, 3);
      assert.match(e.message, /boom/);
      assert.ok(!e.message.includes(JWT) && !e.stderr.includes(JWT), "token in error");
      assert.ok(!e.message.includes("stdout-secret"), "stdout in error");
      return true;
    });
  }
});

test("missing binary names the variable to set", async () => {
  process.env.PARACHUTE_BIN = join(dir, "does-not-exist");
  await assert.rejects(runParachute("hub", ["--version"]), (e: ParachuteCliError) => e.code === "spawn" && /PARACHUTE_BIN/.test(e.message));
});

test("no secret on argv: refused before anything is spawned", async () => {
  useFakes();
  rmSync(join(home, "hub.args"), { force: true });
  for (const args of [["auth", "set-password", "--password", "hunter2"], ["x", "--password=hunter2"], ["x", JWT], ["x", "pvt_abcdefghijkl"], ["x", "--token", "t"]]) {
    await assert.rejects(runParachute("hub", args), (e: ParachuteCliError) => e.code === "secret_argv");
  }
  assert.equal(existsSync(join(home, "hub.args")), false);
  assert.doesNotThrow(() => assertNoSecretArgs(["auth", "mint-token", "--scope", "vault:v:admin", "--ephemeral", "--service", "mcp:a@b.c"]));
});

test("secrets go in through stdin", async () => {
  useFakes();
  await runParachute("hub", ["stdin"], { input: "pw-on-stdin\n" });
  assert.equal(recorded("hub.stdin"), "pw-on-stdin\n");
  runParachuteSync("hub", ["stdin"], { input: "sync-pw\n" });
  assert.equal(recorded("hub.stdin"), "sync-pw\n");
});

test("output parsing: JSON (with a notice line before it) and the stock text form", () => {
  assert.deepEqual(parseCliJson('notice\n{"name":"v","token":"t"}\n'), { name: "v", token: "t" });
  assert.equal(parseCliJson("not json"), undefined);
  assert.deepEqual(parseMintedToken(`{"token":"${JWT}","jti":"j","exp":5}`), { token: JWT, jti: "j", exp: 5 });
  assert.deepEqual(parseMintedToken(`${JWT}\n`), { token: JWT });
  assert.deepEqual(parseMintedToken(`auto-rotated operator token\n${JWT}\n`), { token: JWT });
  assert.throws(() => parseMintedToken("nothing here"), /did not return a JWT/);
  assert.throws(() => parseMintedToken('{"token":"nope"}'), (e: Error) => !e.message.includes("nope"));
});

test("mcp-token default runner goes through the fake: stock text output", async () => {
  useFakes();
  const t = await mintVaultToken({ vaultName: "v", verb: "write", expiresInSeconds: 60, sub: "mcp:a@b.c" });
  assert.equal(t.token, JWT);
  assert.equal(t.jti, "jti-from-jwt");
  assert.deepEqual(recorded("hub.args").trim().split("\n"), [
    "auth", "mint-token", "--scope", "vault:v:write", "--expires-in", "60", "--service", "mcp:a@b.c",
  ]);
  await revokeVaultToken("jti-from-jwt");
  assert.deepEqual(recorded("hub.args").trim().split("\n"), ["auth", "revoke-token", "jti-from-jwt"]);
});

test("mcp-token: PARACHUTE_CLI_JSON=true asks for --json and reads jti/exp from it", async () => {
  useFakes();
  process.env.PARACHUTE_CLI_JSON = "true";
  const t = await mintVaultToken({ vaultName: "v", verb: "read", expiresInSeconds: 60, sub: "agent-session:1" });
  assert.equal(t.jti, "jti-from-json");
  assert.equal(t.expiresAt, 2_100_000_000 * 1000);
  assert.equal(recorded("hub.args").trim().split("\n").at(-1), "--json");
  assert.equal(await mintEphemeralAdminToken("v"), JWT);
});

test("mcp-token: a real 'unknown flag --service' stderr still falls back to --sub", async () => {
  useFakes();
  writeFileSync(join(home, "no-service"), "");
  const t = await mintVaultToken({ vaultName: "v", verb: "read", expiresInSeconds: 60, sub: "mcp:a@b.c" });
  assert.equal(t.jti, "jti-from-jwt");
  assert.deepEqual(recorded("hub.args").trim().split("\n").slice(-2), ["--sub", "mcp:a@b.c"]);
});

test("vault-provision default creator goes through the fake vault binary", async () => {
  useFakes();
  const v = await createVaultViaCli("team");
  assert.equal(v.name, "team");
  assert.equal(v.token, JWT);
  assert.deepEqual(recorded("vault.args").trim().split("\n"), ["create", "team", "--mint", "--scope", "write", "--no-mirror", "--json"]);
});

test("a bun-script CLI runs when the caller's PATH lacks its folder (clean-VM finding)", async () => {
  // Stock Parachute is `#!/usr/bin/env bun`, installed beside bun in ~/.bun/bin. The caller's
  // shell (an agent's, a fresh Terminal) often does not have that folder on PATH yet.
  const binDir = mkdtempSync(join(tmpdir(), "prism-bun-bin-"));
  try {
    writeFileSync(join(binDir, "fakebun"), "#!/bin/sh\nexec /bin/sh \"$@\"\n");
    chmodSync(join(binDir, "fakebun"), 0o755);
    const cli = join(binDir, "parachute-vault");
    writeFileSync(cli, "#!/usr/bin/env fakebun\necho ran-with-interpreter\n");
    chmodSync(cli, 0o755);
    const cfg = { ...parachuteCliConfig({}), vaultBin: cli };
    const r = await runParachute("vault", ["create", "v"], { config: cfg, parentEnv: { HOME: "/h", PATH: "/usr/bin:/bin" } });
    assert.equal(r.stdout.trim(), "ran-with-interpreter");
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("withBinDirOnPath: an absolute binary's folder goes first once; a bare name changes nothing", () => {
  assert.equal(withBinDirOnPath({ PATH: "/usr/bin:/bin" }, "/u/.bun/bin/parachute").PATH, "/u/.bun/bin:/usr/bin:/bin");
  assert.equal(withBinDirOnPath({ PATH: "/u/.bun/bin:/usr/bin" }, "/u/.bun/bin/parachute").PATH, "/u/.bun/bin:/usr/bin");
  assert.equal(withBinDirOnPath({ PATH: "/usr/bin" }, "parachute").PATH, "/usr/bin");
  assert.equal(withBinDirOnPath({}, "/x/parachute").PATH, "/x:/usr/bin:/bin");
});

/**
 * The CLI-level default minter (mcp-token.ts) across hub versions: hub ≥0.7.18
 * needs `--service` to keep `sub = mcp:<email>` (`--sub` became a label, hub#872);
 * hub 0.7.1 rejects `--service` as an unknown flag, so we fall back to `--sub`.
 * Plus the ephemeral admin-token seam. The `parachute` CLI is injected.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mintVaultToken, mintEphemeralAdminToken, setCliRunner } from "../src/mcp-token";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}
const JWT = fakeJwt({ jti: "j1", exp: 2_000_000_000 });

afterEach(() => {
  setCliRunner(null);
  delete process.env.PARACHUTE_ADMIN_TOKEN;
});

test("mints with --service on a hub that knows it", async () => {
  const calls: string[][] = [];
  setCliRunner(async (args) => {
    calls.push(args);
    return `${JWT}\n`;
  });
  const t = await mintVaultToken({ vaultName: "v", verb: "write", expiresInSeconds: 60, sub: "mcp:a@b.c" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(-2), ["--service", "mcp:a@b.c"]);
  assert.equal(t.jti, "j1");
  assert.equal(t.scope, "vault:v:write");
});

test("falls back to --sub when the hub rejects --service (hub 0.7.1)", async () => {
  const calls: string[][] = [];
  setCliRunner(async (args) => {
    calls.push(args);
    if (args.includes("--service")) {
      throw Object.assign(new Error("Command failed"), {
        stderr: 'parachute auth mint-token: unknown flag "--service"\n',
      });
    }
    return JWT;
  });
  const t = await mintVaultToken({ vaultName: "v", verb: "read", expiresInSeconds: 60, sub: "mcp:a@b.c" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.slice(-2), ["--sub", "mcp:a@b.c"]);
  assert.equal(t.jti, "j1");
});

test("any other CLI failure is not retried", async () => {
  let n = 0;
  setCliRunner(async () => {
    n++;
    throw Object.assign(new Error("boom"), { stderr: "hub unreachable" });
  });
  await assert.rejects(mintVaultToken({ vaultName: "v", verb: "read", expiresInSeconds: 60, sub: "s" }), /boom/);
  assert.equal(n, 1);
});

test("admin token: ephemeral vault:<name>:admin mint", async () => {
  let seen: string[] = [];
  setCliRunner(async (args) => {
    seen = args;
    return JWT;
  });
  assert.equal(await mintEphemeralAdminToken("default"), JWT);
  assert.deepEqual(seen, ["auth", "mint-token", "--scope", "vault:default:admin", "--ephemeral"]);
});

test("admin token: PARACHUTE_ADMIN_TOKEN overrides the CLI", async () => {
  process.env.PARACHUTE_ADMIN_TOKEN = "override";
  setCliRunner(async () => {
    throw new Error("CLI must not be called");
  });
  assert.equal(await mintEphemeralAdminToken("default"), "override");
});

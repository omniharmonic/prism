/**
 * In-app vault create/link (multi-vault Phase 2). Covers:
 *   - the merged registry (env base + db rows, deduped env-wins) and resolve.
 *   - POST /acl/vaults link-mode: owner-only, persists, surfaces in GET /api/vaults
 *     (token-free), DELETE removes it; the env primary id can't be deleted.
 *   - POST /acl/vaults create-mode with the CLI/seeder INJECTED (no real spawn):
 *     parses JSON → addVaultEntry → seeder called; name validation + the
 *     ALLOW_VAULT_CREATE gate; tokens never appear in any response.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { vaults as vaultsRoute } from "../src/routes/vaults";
import { config, vaultRegistry } from "../src/config";
import {
  addVaultEntry,
  listVaultEntries,
  getVaultEntry,
  removeVaultEntry,
  getVaultRegistry,
  resolveVaultEntry,
} from "../src/db";
import { setVaultCreator, setVaultSeeder } from "../src/vault-provision";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  setVaultCreator(null);
  setVaultSeeder(null);
});

const OWNER = "owner@test.local";
const ownerCookie = () => sessionCookie(makeSession(OWNER));
const ownerHeaders = () => {
  const h = new Headers({ "content-type": "application/json" });
  h.set("cookie", ownerCookie());
  return h;
};
const ownerReq = (route: typeof acl, path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cookie", ownerCookie());
  if (init?.body) headers.set("content-type", "application/json");
  return route.request(path, { ...init, headers });
};

// ── Registry merge + resolve (db layer) ──────────────────────────────────────
test("getVaultRegistry merges env base + db rows; env entry stays first/primary", () => {
  assert.equal(vaultRegistry[0]!.id, "primary");
  addVaultEntry({ id: "extra", label: "Extra", url: "http://other.test", vault: "other", token: "tok-extra" });

  const reg = getVaultRegistry();
  assert.equal(reg.length, 2);
  assert.equal(reg[0]!.id, "primary", "env primary remains index 0");
  assert.equal(reg[1]!.id, "extra");
});

test("dedupe: a db row reusing an env id is shadowed (env wins)", () => {
  addVaultEntry({ id: "primary", label: "Impostor", url: "http://evil.test", vault: "evil", token: "tok-evil" });
  const reg = getVaultRegistry();
  assert.equal(reg.length, 1, "the colliding db row is dropped");
  assert.equal(reg[0]!.label, vaultRegistry[0]!.label, "env entry, not the impostor");
  assert.equal(reg[0]!.token, config.parachuteToken);
});

test("resolveVaultEntry resolves an added id and falls back to primary on unknown", () => {
  addVaultEntry({ id: "extra", label: "Extra", url: "http://other.test", vault: "other", token: "tok-extra" });
  assert.equal(resolveVaultEntry("extra").vault, "other");
  assert.equal(resolveVaultEntry("nope").id, "primary", "unknown id → primary");
  assert.equal(resolveVaultEntry(undefined).id, "primary", "no id → primary");
});

test("vault-entry CRUD round-trips (token-bearing rows live in the db)", () => {
  addVaultEntry({ id: "v1", label: "One", url: "http://one.test", vault: "one", token: "secret-1" });
  assert.equal(listVaultEntries().length, 1);
  assert.equal(getVaultEntry("v1")!.token, "secret-1");
  removeVaultEntry("v1");
  assert.equal(getVaultEntry("v1"), null);
  assert.equal(listVaultEntries().length, 0);
});

// ── POST /acl/vaults link mode ───────────────────────────────────────────────
test("POST /acl/vaults link-mode is owner-only (anon → 403)", async () => {
  const res = await acl.request("/vaults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "link", label: "X", url: "http://vault.test", vault: "default", token: "t" }),
  });
  assert.equal(res.status, 403);
  assert.equal(listVaultEntries().length, 0, "nothing persisted for a non-owner");
});

test("link-mode persists, appears in GET /api/vaults without a token, then DELETE removes it", async () => {
  // Link the fake vault (its /vault/default/api/tags probe returns fv.tags).
  const created = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "link", label: "Linked Default", url: "http://vault.test/", vault: "default", token: "linked-token" }),
  });
  assert.equal(created.status, 200);
  const summary = (await created.json()) as { id: string; label: string; vault: string; active: boolean };
  assert.equal(summary.label, "Linked Default");
  assert.equal(summary.vault, "default");
  assert.equal(summary.active, false);
  assert.ok(!("token" in summary) && !("url" in summary), "summary omits token+url");

  // Stored with the token server-side, url trailing-slash trimmed.
  assert.equal(getVaultEntry(summary.id)!.token, "linked-token");
  assert.equal(getVaultEntry(summary.id)!.url, "http://vault.test");

  // Shows up in GET /api/vaults (2 entries: primary + linked), no token/url leaked.
  const listRes = await vaultsRoute.request("/vaults", { headers: ownerHeaders() });
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as Array<Record<string, unknown>>;
  assert.equal(list.length, 2);
  assert.equal(list[0]!.active, true, "primary is active");
  assert.equal(list[1]!.active, false);
  for (const v of list) {
    assert.ok(!("token" in v), "GET /api/vaults never includes a token");
    assert.ok(!("url" in v), "GET /api/vaults never includes a url");
  }

  // DELETE removes the added vault.
  const del = await ownerReq(acl, `/vaults/${summary.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(getVaultEntry(summary.id), null);
});

test("link-mode rejects a non-http url and a missing token", async () => {
  const badUrl = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "link", label: "X", url: "ftp://nope", vault: "default", token: "t" }),
  });
  assert.equal(badUrl.status, 400);
  const noTok = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "link", label: "X", url: "http://vault.test", vault: "default" }),
  });
  assert.equal(noTok.status, 400);
});

test("link-mode 400 'unreachable' when the probe fails", async () => {
  fv.healthy = true; // health endpoint is separate; the probe hits /vault/<v>/api/tags
  const res = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "link", label: "X", url: "http://vault.test", vault: "does-not-exist", token: "t" }),
  });
  // The fake vault only serves /vault/default/api; a different vault name 404s → unreachable.
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "unreachable" });
});

test("the env primary id cannot be deleted", async () => {
  const del = await ownerReq(acl, "/vaults/primary", { method: "DELETE" });
  assert.equal(del.status, 400);
  // Still present in the merged registry.
  assert.ok(getVaultRegistry().some((v) => v.id === "primary"));
});

// ── POST /acl/vaults create mode (CLI + seeder injected) ─────────────────────
test("create-mode: parses CLI JSON → addVaultEntry → seeder called; token never leaks", async () => {
  let creatorCalledWith = "";
  setVaultCreator(async (name) => {
    creatorCalledWith = name;
    return { name, token: "minted-secret-token" };
  });
  const seedCalls: Array<{ vaultUrl: string; vault: string; token: string }> = [];
  setVaultSeeder(async (opts) => {
    seedCalls.push(opts);
    return { created: [], updated: [], unchanged: [], skipped: [], details: {}, dryRun: false };
  });

  const res = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "create", label: "My New Vault", name: "my-new-vault" }),
  });
  assert.equal(res.status, 200);
  const summary = (await res.json()) as Record<string, unknown>;
  assert.equal(summary.vault, "my-new-vault");
  assert.equal(summary.active, false);
  assert.ok(!("token" in summary), "create summary omits the minted token");
  const bodyText = JSON.stringify(summary);
  assert.ok(!bodyText.includes("minted-secret-token"), "the minted token never appears in the response");

  assert.equal(creatorCalledWith, "my-new-vault");
  assert.equal(getVaultEntry(summary.id as string)!.token, "minted-secret-token", "token persisted server-side");
  assert.equal(getVaultEntry(summary.id as string)!.url, config.parachuteUrl);

  // Seeder ran against the new vault with the minted token (default seedSchemas).
  assert.equal(seedCalls.length, 1, "seeder was called once");
  assert.equal(seedCalls[0]!.vault, "my-new-vault");
  assert.equal(seedCalls[0]!.token, "minted-secret-token");
});

test("create-mode: seedSchemas:false skips the seeder", async () => {
  setVaultCreator(async (name) => ({ name, token: "tok" }));
  let seeded = false;
  setVaultSeeder(async (o) => {
    seeded = true;
    return { created: [], updated: [], unchanged: [], skipped: [], details: {}, dryRun: false };
  });
  const res = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "create", label: "No Seed", name: "no-seed", seedSchemas: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(seeded, false, "seeder skipped when seedSchemas is false");
});

test("create-mode rejects an invalid vault name (^[a-z0-9_-]+$)", async () => {
  let creatorCalled = false;
  setVaultCreator(async (name) => {
    creatorCalled = true;
    return { name, token: "t" };
  });
  for (const bad of ["Has Space", "UPPER", "bad/slash", "dollar$", ""]) {
    const res = await ownerReq(acl, "/vaults", {
      method: "POST",
      body: JSON.stringify({ mode: "create", label: "L", name: bad }),
    });
    assert.equal(res.status, 400, `name "${bad}" must be rejected`);
  }
  assert.equal(creatorCalled, false, "the CLI is never invoked for an invalid name");
});

test("create-mode is gated by ALLOW_VAULT_CREATE=false (403, no spawn)", async () => {
  let creatorCalled = false;
  setVaultCreator(async (name) => {
    creatorCalled = true;
    return { name, token: "t" };
  });
  const original = config.allowVaultCreate;
  // config is `as const`; flip via a typed cast for this test only.
  (config as { allowVaultCreate: boolean }).allowVaultCreate = false;
  try {
    const res = await ownerReq(acl, "/vaults", {
      method: "POST",
      body: JSON.stringify({ mode: "create", label: "L", name: "ok-name" }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual((await res.json()) as { error: string }, { error: "disabled", detail: "vault creation is disabled on this server" });
  } finally {
    (config as { allowVaultCreate: boolean }).allowVaultCreate = original;
  }
  assert.equal(creatorCalled, false, "no spawn when creation is disabled");
});

test("create-mode surfaces a CLI failure as 500 create_failed (no token in the body)", async () => {
  setVaultCreator(async () => {
    throw new Error("parachute-vault create returned no token");
  });
  const res = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "create", label: "L", name: "boom" }),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "create_failed");
  assert.equal(listVaultEntries().length, 0, "nothing persisted on failure");
});

test("POST /acl/vaults with an unknown mode → 400", async () => {
  const res = await ownerReq(acl, "/vaults", {
    method: "POST",
    body: JSON.stringify({ mode: "wat" }),
  });
  assert.equal(res.status, 400);
});

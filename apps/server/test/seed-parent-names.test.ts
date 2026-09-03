/**
 * Seed: parent_names (is-a hierarchy) support. The vault tag schema now carries
 * an optional `parent_names` so `query-notes { tag:"entity", expand:"subtypes" }`
 * resolves subtypes. This pins that the seed SENDS parent_names on create and
 * adds it non-destructively on update (never clobbering a curated hierarchy).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { seedTagSchemas, type TagSchemaEntry } from "../scripts/lib/seed-tag-schemas";

const realFetch = globalThis.fetch;

interface Put {
  tag: string;
  body: { description?: string; fields?: Record<string, unknown>; parent_names?: string[] };
}

/** Install a fake vault: GET /tags returns `existing`; capture every PUT. */
function installVault(existing: Array<{ name: string; description?: string; fields?: Record<string, unknown>; parent_names?: string[] }>): { puts: Put[] } {
  const puts: Put[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/tags?include_schema=true") && method === "GET") {
      return new Response(JSON.stringify(existing.map((e) => ({ count: 0, description: null, fields: null, ...e }))), { headers: { "content-type": "application/json" } });
    }
    const m = url.match(/\/tags\/([^/?]+)$/);
    if (m && method === "PUT") {
      puts.push({ tag: decodeURIComponent(m[1]!), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { puts };
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const schemas = (): Record<string, TagSchemaEntry> => ({
  entity: { description: "supertype", fields: { name: { type: "string" } } },
  "ecological-entity": { description: "a located being", fields: { name: { type: "string" } }, parent_names: ["entity"] } as TagSchemaEntry,
});

const opts = { vaultUrl: "http://vault.test", vault: "default", token: "t" };

test("create sends parent_names for a subtype tag", async () => {
  const { puts } = installVault([]); // nothing exists → all created
  const res = await seedTagSchemas({ ...opts, schemas: schemas() });
  const eco = puts.find((p) => p.tag === "ecological-entity");
  assert.ok(eco, "ecological-entity was PUT");
  assert.deepEqual(eco!.body.parent_names, ["entity"]);
  const ent = puts.find((p) => p.tag === "entity");
  assert.equal(ent!.body.parent_names, undefined); // the supertype declares no parents
  assert.ok(res.created.includes("ecological-entity"));
});

test("update adds parent_names when the vault tag has none, non-destructively", async () => {
  // ecological-entity already has a schema (description+fields) but NO parents.
  const { puts } = installVault([
    { name: "entity", description: "supertype", fields: { name: {} } },
    { name: "ecological-entity", description: "a located being", fields: { name: {} } },
  ]);
  const res = await seedTagSchemas({ ...opts, schemas: schemas() });
  const eco = puts.find((p) => p.tag === "ecological-entity");
  assert.ok(eco, "ecological-entity was updated to add parents");
  assert.deepEqual(eco!.body.parent_names, ["entity"]);
  assert.ok(res.updated.includes("ecological-entity"));
});

test("update does NOT clobber existing parent_names", async () => {
  const { puts } = installVault([
    { name: "entity", description: "supertype", fields: { name: {} } },
    { name: "ecological-entity", description: "a located being", fields: { name: {} }, parent_names: ["custom-parent"] },
  ]);
  const res = await seedTagSchemas({ ...opts, schemas: schemas() });
  // no field/description change + parents already present → unchanged, no PUT
  assert.ok(!puts.some((p) => p.tag === "ecological-entity"));
  assert.ok(res.unchanged.includes("ecological-entity"));
});

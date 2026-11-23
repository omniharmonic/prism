/**
 * Seed vs vault 0.7.x auth + validation: schema PUTs use the admin token (reads
 * keep the write token), a 403 insufficient_scope becomes an actionable
 * SchemaWriteError, 422/400 schema bodies are structured, and echo-back never
 * re-sends an `indexed` flag on a type the vault can't index.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { seedTagSchemas, SchemaWriteError, type TagSchemaEntry } from "../scripts/lib/seed-tag-schemas";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: any;
}

function installVault(opts: {
  existing?: Array<Record<string, unknown>>;
  putStatus?: number;
  putBody?: unknown;
}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url, auth, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET") {
      const list = (opts.existing ?? []).map((e) => ({ count: 0, description: null, fields: null, ...e }));
      return new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(opts.putBody ?? {}), {
      status: opts.putStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const schemas: Record<string, TagSchemaEntry> = {
  task: { description: "a task", fields: { priority: { type: "string", enum: ["medium", "high"], indexed: true } } },
};
const base = { vaultUrl: "http://vault.test", vault: "default", token: "write-tok", schemas };

test("PUTs use the admin token; GETs keep the write token", async () => {
  const calls = installVault({});
  await seedTagSchemas({ ...base, adminToken: "admin-tok" });
  assert.equal(calls.find((c) => c.method === "GET")!.auth, "Bearer write-tok");
  assert.equal(calls.find((c) => c.method === "PUT")!.auth, "Bearer admin-tok");
});

test("without an admin token the write token is used (vault 0.6.x)", async () => {
  const calls = installVault({});
  await seedTagSchemas(base);
  assert.equal(calls.find((c) => c.method === "PUT")!.auth, "Bearer write-tok");
});

test("403 insufficient_scope → actionable SchemaWriteError", async () => {
  installVault({ putStatus: 403, putBody: { error: "Forbidden", error_type: "insufficient_scope", required_scope: "vault:admin" } });
  await assert.rejects(seedTagSchemas(base), (e: unknown) => {
    assert.ok(e instanceof SchemaWriteError);
    assert.equal(e.status, 403);
    assert.equal(e.errorType, "insufficient_scope");
    assert.match(e.message, /vault:default:admin/);
    assert.match(e.message, /--ephemeral/);
    return true;
  });
});

test("422 tag_field_conflict → structured error, says nothing was written", async () => {
  installVault({ putStatus: 422, putBody: { error_type: "tag_field_conflict", violations: [{ field: "priority" }] } });
  await assert.rejects(seedTagSchemas(base), (e: unknown) => {
    assert.ok(e instanceof SchemaWriteError);
    assert.equal(e.errorType, "tag_field_conflict");
    assert.match(e.message, /nothing was written/);
    assert.match(e.message, /priority/);
    return true;
  });
});

test("echo-back drops indexed on non-indexable types but keeps 0.7-indexable ones", async () => {
  const calls = installVault({
    existing: [
      {
        name: "task",
        description: "a task",
        fields: {
          bbox: { type: "array", indexed: true },
          rank: { type: "integer", indexed: true },
        },
      },
    ],
  });
  await seedTagSchemas(base); // desired adds `priority` → an update PUT that echoes existing fields
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.body.fields.bbox.indexed, undefined);
  assert.equal(put.body.fields.rank.indexed, true);
  assert.equal(put.body.fields.priority.indexed, true);
});

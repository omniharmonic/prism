/**
 * Seed vs vault ≥0.7.9's cross-tag field rule (clean-VM run, 2026-10-20). The vault refuses a
 * whole tag-schema PUT (422 `tag_field_conflict`) when one of its fields disagrees with another
 * tag's declaration of the same name in type or `indexed` flag. Prism's own canonical schemas
 * hold such pairs, so `prism setup`'s `schemas` step failed on every fresh install. The fake vault
 * here enforces the rule the way vault 0.7.9's `collectCrossTagFieldViolations` does.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadCanonicalSchemas, seedTagSchemas, type TagSchemaEntry } from "../scripts/lib/seed-tag-schemas";
import { schemaClashes } from "../../../packaging/host/cli/setup";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Field = { type?: string; indexed?: boolean };
type Tag = { name: string; description: string | null; fields: Record<string, Field> | null; parent_names?: string[] };

/** A fake vault that stores schemas and enforces the 0.7.9 cross-tag agreement rule. */
function strictVault(initial: Tag[] = []): { tags: Map<string, Tag>; refused: number } {
  const tags = new Map(initial.map((t) => [t.name, t]));
  const state = { tags, refused: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/tags?include_schema=true") && method === "GET") {
      return Response.json([...tags.values()].map((t) => ({ count: 0, ...t })));
    }
    const m = url.match(/\/tags\/([^/?]+)$/);
    if (m && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      const body = JSON.parse(String(init?.body ?? "{}")) as { description?: string; fields?: Record<string, Field>; parent_names?: string[] };
      const violations: unknown[] = [];
      for (const [field, spec] of Object.entries(body.fields ?? {})) {
        for (const other of tags.values()) {
          if (other.name === name) continue;
          const o = other.fields?.[field];
          if (!o) continue;
          if (spec.indexed !== true && o.type !== spec.type) violations.push({ field, reason: "type_conflict", other_tag: other.name });
          if ((o.indexed === true) !== (spec.indexed === true)) violations.push({ field, reason: "indexed_flag_conflict", other_tag: other.name });
          if (spec.indexed === true && o.indexed === true && o.type !== spec.type) return Response.json({ error_type: "invalid_indexed_field" }, { status: 400 });
        }
      }
      if (violations.length) {
        state.refused++;
        return Response.json({ error_type: "tag_field_conflict", violations }, { status: 422 });
      }
      const cur = tags.get(name);
      tags.set(name, { name, description: body.description ?? cur?.description ?? null, fields: { ...(cur?.fields ?? {}), ...(body.fields ?? {}) }, parent_names: body.parent_names ?? cur?.parent_names });
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return state;
}

const opts = { vaultUrl: "http://vault.test", vault: "default", token: "t", adminToken: "a" };

test("the canonical schemas seed into an EMPTY 0.7.9-style vault, and a second run has nothing to do", async () => {
  const v = strictVault();
  const canonical = loadCanonicalSchemas();
  const r = await seedTagSchemas({ ...opts });
  assert.equal(v.refused, 0, "no PUT was refused");
  assert.equal(r.created.length + r.unchanged.length, Object.keys(canonical).length);
  // Since the 2026-10-20 renames the canonical file agrees with itself (schema-drift.test.ts pins
  // it): nothing is left out and no index flag is adopted. The skip-and-name logic stays as the
  // safety net for a person's own clashing tag (the tests below).
  assert.deepEqual(r.conflicts ?? [], [], JSON.stringify(r.conflicts));
  assert.deepEqual(r.adoptedIndexed ?? [], [], JSON.stringify(r.adoptedIndexed));
  // Every declared field now agrees across tags (what the vault requires).
  const seen = new Map<string, Field>();
  for (const t of v.tags.values()) {
    for (const [f, d] of Object.entries(t.fields ?? {})) {
      const o = seen.get(f);
      if (o) assert.deepEqual([o.type, o.indexed === true], [d.type, d.indexed === true], `field ${f} on ${t.name}`);
      else seen.set(f, d);
    }
  }
  const again = await seedTagSchemas({ ...opts, dryRun: true });
  assert.deepEqual([again.created, again.updated], [[], []], "the step reads as done afterwards");
  assert.equal(schemaClashes(again), "");
});

test("an indexed-flag difference adopts the vault's flag; the vault's own declarations win", async () => {
  strictVault([{ name: "mine", description: "the person's own tag", fields: { status: { type: "string", indexed: true } } }]);
  const schemas: Record<string, TagSchemaEntry> = { task: { description: "a task", fields: { status: { type: "string" }, due: { type: "string" } } } };
  const r = await seedTagSchemas({ ...opts, schemas });
  assert.deepEqual(r.created, ["task"]);
  assert.deepEqual((r.adoptedIndexed ?? []).map((c) => `${c.tag}.${c.field}<-${c.with}`), ["task.status<-mine"]);
  assert.deepEqual(r.conflicts, []);
});

test("a type clash with the person's own tag leaves only that field out", async () => {
  const v = strictVault([{ name: "mine", description: "x", fields: { due: { type: "integer" } } }]);
  const schemas: Record<string, TagSchemaEntry> = { task: { description: "a task", fields: { status: { type: "string" }, due: { type: "string" } } } };
  const r = await seedTagSchemas({ ...opts, schemas });
  assert.deepEqual(Object.keys(v.tags.get("task")!.fields!), ["status"]);
  assert.deepEqual((r.conflicts ?? []).map((c) => `${c.tag}.${c.field}`), ["task.due"]);
  assert.equal(v.tags.get("mine")!.fields!.due!.type, "integer", "the person's tag is untouched");
});

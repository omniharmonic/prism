/**
 * Vault hygiene, write side + lint: the shape guard at the vaultClient sink
 * (src/vault-shapes.ts) and the read-only `vault-lint` worker. Offline: fetch is
 * stubbed, the lint listing is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalTaskStatus,
  confidenceLabel,
  epochMs,
  shapeMetadata,
  shapeViolations,
  TASK_STATUSES,
  TASK_STATUS_SYNONYMS,
  THREAD_PLATFORMS,
  CONFIDENCE_LABELS,
  LIST_FIELDS_BY_TAG,
} from "../src/vault-shapes";
import { vaultClient } from "../src/parachute";
import { lintRows, runVaultLintOnce, lastVaultLintOutcome, LINT_TAGS } from "../src/worker/vault-lint";
import { clickupTaskNote } from "../src/worker/clickup";

const fixes = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../scripts/vault-hygiene/schema-fixes.json", import.meta.url)), "utf8"),
) as { changes: Array<{ id: string; to: { type?: string; enum?: string[] } }> };
const fix = (id: string) => fixes.changes.find((c) => c.id === id)!.to;

test("vault-shapes: vocabularies are exactly the corrected schemas (schema-fixes.json)", () => {
  assert.deepEqual([...TASK_STATUSES].sort(), [...fix("task-status").enum!].sort());
  assert.deepEqual([...THREAD_PLATFORMS].sort(), [...fix("thread-platform").enum!].sort());
  assert.deepEqual([...CONFIDENCE_LABELS].sort(), [...fix("person-confidence").enum!].sort());
  assert.equal(fix("thread-participants").type, "array");
  assert.ok(LIST_FIELDS_BY_TAG["message-thread"]!.includes("participants"));
  assert.equal(fix("thread-last-message-at").type, "integer");
  assert.equal(fix("spec-version").type, "string");
  for (const canon of Object.values(TASK_STATUS_SYNONYMS)) assert.ok(TASK_STATUSES.has(canon), canon);
});

test("vault-shapes: \"\" in a list field is absent on create, null (remove) on update", () => {
  assert.deepEqual(shapeMetadata({ organizations: "", aliases: "", role: "x" }, ["person"], "create"), { role: "x" });
  assert.deepEqual(shapeMetadata({ projects: "", title: "T" }, undefined, "update"), { projects: null, title: "T" });
  assert.deepEqual(shapeMetadata({ aliases: ["a", "", "a", " "] }, ["person"], "create"), { aliases: ["a"] });
  // name-only (tags unknown): a non-empty string is left alone
  assert.deepEqual(shapeMetadata({ aliases: "Sam" }, undefined, "update"), { aliases: "Sam" });
  assert.deepEqual(shapeMetadata({ aliases: "Sam" }, ["person"], "create"), { aliases: ["Sam"] });
  assert.deepEqual(shapeMetadata({ attendees: "[[a]], b@x.org" }, ["meeting"], "create"), { attendees: ["[[a]]", "b@x.org"] });
  assert.deepEqual(shapeMetadata({ collaborators: "Smith, John" }, ["project"], "create"), { collaborators: ["Smith, John"] });
});

test("vault-shapes: confidence, task status, thread, source, recording_id, version", () => {
  assert.equal(confidenceLabel(0.93), "high");
  assert.equal(confidenceLabel("0.6"), "medium");
  assert.equal(confidenceLabel("Low"), "low");
  assert.equal(confidenceLabel(""), null);
  assert.equal(shapeMetadata({ confidence: 0.9 }, ["person"], "create")!.confidence, "high");
  assert.deepEqual(shapeMetadata({ confidence: "" }, ["organization"], "create"), {});
  assert.equal(shapeMetadata({ confidence: 0.8 }, ["promise"], "create")!.confidence, 0.8, "a promise keeps its number");
  assert.equal(canonicalTaskStatus("Tracked"), "pending");
  assert.equal(canonicalTaskStatus("todo"), "todo");
  assert.equal(shapeMetadata({ status: "processed" }, ["meeting"], "create")!.status, "processed");
  assert.equal(epochMs("2026-10-01T00:00:00Z"), 1790812800000);
  assert.equal(epochMs("1790812800000"), 1790812800000);
  assert.equal(epochMs(1790812800), 1790812800000);
  const t = shapeMetadata({ lastMessageAt: "1790812800000", platform: "Matrix", participants: "Ann" }, ["message-thread"], "create")!;
  assert.deepEqual(t, { lastMessageAt: 1790812800000, platform: "matrix", participants: ["Ann"] });
  assert.deepEqual(shapeMetadata({ source: "", recording_id: 42 }, ["meeting", "transcript"], "update"), { recording_id: "42" });
  assert.equal(shapeMetadata({ source: "fireflies" }, ["transcript"], "create")!.source, "fireflies");
  assert.equal(shapeMetadata({ version: 1 }, ["spec"], "create")!.version, "1");
});

test("vault-shapes: governance notes and the kill switch pass through untouched", () => {
  const gov = { people: "", gov_sig: "v1.x" };
  assert.equal(shapeMetadata(gov, undefined, "update"), gov);
  assert.equal(shapeMetadata({ people: "" }, ["governance-role"], "create")!.people, "");
  process.env.VAULT_SHAPE_GUARD = "0";
  try {
    const m = { aliases: "" };
    assert.equal(shapeMetadata(m, ["person"], "create"), m);
  } finally {
    delete process.env.VAULT_SHAPE_GUARD;
  }
});

test("vault-shapes: vaultClient create/update send shaped metadata (the sink)", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: "n1", path: "p", tags: [], metadata: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const v = vaultClient();
    await v.createNote({ content: "", path: "vault/people/a", tags: ["person"], metadata: { aliases: "", confidence: 0.85, name: "A" } });
    await v.updateNote("n1", { metadata: { organizations: "" }, ifUpdatedAt: "2026-01-01T00:00:00Z" });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(sent[0]!.metadata, { confidence: "high", name: "A" });
  assert.deepEqual(sent[1]!.metadata, { organizations: null });
});

test("writer fix: a ClickUp task with no list writes no `project: \"\"`", () => {
  const ctx = { teamId: "t1" } as Parameters<typeof clickupTaskNote>[1];
  const note = clickupTaskNote({ id: "abc", name: "Do it", status: { status: "open", type: "open" } } as Parameters<typeof clickupTaskNote>[0], ctx);
  assert.ok(!("project" in note.metadata));
});

test("lint: shapeViolations names mis-shaped fields, never values", () => {
  assert.deepEqual(shapeViolations({ organizations: "", aliases: ["a"], confidence: 0.9 }, "person").sort(), ["confidence", "organizations"]);
  assert.deepEqual(shapeViolations({ projects: ["[[vault/projects/x]]"] }, "meeting"), ["projects:folder-link"]);
  assert.deepEqual(shapeViolations({ projects: ["[[vault/projects/x/PROJECT|X]]"] }, "meeting"), []);
  assert.deepEqual(shapeViolations({ status: "review" }, "task"), ["status"]);
  assert.deepEqual(shapeViolations({ lastMessageAt: "1", platform: "Matrix", participants: ["a"] }, "message-thread").sort(), ["lastMessageAt", "platform"]);
  assert.deepEqual(shapeViolations({ recording_id: 5, source: "" }, "transcript").sort(), ["recording_id", "source"]);
  assert.deepEqual(shapeViolations({ version: 2 }, "spec"), ["version"]);
  // what the guard writes is always clean
  for (const tag of LINT_TAGS) {
    const shaped = shapeMetadata({ aliases: "", projects: "", confidence: 0.5, status: "tracked", recording_id: 3, version: 1, lastMessageAt: "5", platform: "Telegram", source: "Fathom" }, [tag], "create")!;
    assert.deepEqual(shapeViolations(shaped, tag), [], tag);
  }
});

test("lint: rates, threshold, rise and persistence (injected listing)", async () => {
  const cursors = new Map<string, string>();
  const deps = {
    getCursor: (v: string, n: string) => cursors.get(`${v}:${n}`) ?? null,
    setCursor: (v: string, n: string, val: string) => void cursors.set(`${v}:${n}`, val),
    sample: 10,
    maxRate: 0.2,
    minSample: 5,
    now: () => Date.parse("2026-10-08T12:00:00Z"),
  };
  const clean = (tag: string) => Array.from({ length: 10 }, () => ({ metadata: tag === "person" ? { aliases: ["x"] } : {} }));
  const first = await runVaultLintOnce("primary", { ...deps, list: async (tag) => clean(tag) });
  assert.equal(first.status, "ok");
  assert.equal(first.tags.person!.rate, 0);
  // person drifts: 4 of 10 carry "" again
  const second = await runVaultLintOnce("primary", {
    ...deps,
    list: async (tag) => (tag === "person" ? [...Array.from({ length: 4 }, () => ({ metadata: { aliases: "" } })), ...clean("person").slice(4)] : clean(tag)),
  });
  assert.equal(second.status, "failing");
  assert.deepEqual(second.over, ["person"]);
  assert.deepEqual(second.rose, ["person"]);
  assert.equal(second.tags.person!.fields.aliases, 4);
  assert.equal(lastVaultLintOutcome("primary", deps.getCursor)!.status, "failing");
  // a vault's own validation_status counts too; a listing error stops the run
  assert.equal(lintRows([{ metadata: {}, validation_status: { warnings: [{ field: "x" }] } }], "task").warned, 1);
  // Two tags that define one field differently (a spec that is also a report): about the tag pair, not this note's data.
  assert.equal(lintRows([{ metadata: {}, validation_status: { warnings: [{ field: "status", reason: "schema_conflict" }] } }], "spec").warned, 0);
  assert.equal(lintRows([{ metadata: {}, validation_status: { warnings: [{ field: "status", reason: "schema_conflict" }, { field: "status", reason: "enum_mismatch" }] } }], "spec").warned, 1);
  const broken = await runVaultLintOnce("primary", { ...deps, list: async () => { throw new Error("GET /notes: 503"); } });
  assert.equal(broken.status, "error");
  assert.match(broken.error!, /503/);
});

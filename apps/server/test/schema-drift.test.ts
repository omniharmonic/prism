/**
 * Schema change control: ONE contract (`packages/core/src/lib/schemas/vault-shapes.json`)
 * and four things that must agree with it — the seeded tag schemas (tag-schemas.json),
 * the approved corrections (scripts/vault-hygiene/schema-fixes.json), the server's
 * guard + lint (src/vault-shapes.ts, worker/vault-lint.ts) and the generated prompt
 * block (docs/vault-field-shapes.md + the prompt files that carry it).
 *
 * A failure here means a schema change was made in one place only. The fix is
 * always the same: change the contract, regenerate, and follow
 * docs/vault-schema-change.md. Offline: files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARED_FIELDS, isExemptTag, renderFieldShapesBody, renderFieldShapesRule, VAULT_SHAPES as C } from "@prism/core/vault-shapes";
import {
  ALWAYS_LIST,
  CONFIDENCE_LABELS,
  CONFIDENCE_TAGS,
  declaredViolations,
  LIST_FIELDS_BY_TAG,
  lintKeys,
  PROVENANCE_KEYS,
  shapeMetadata,
  shapeViolations,
  TASK_STATUSES,
  TASK_STATUS_SYNONYMS,
  THREAD_PLATFORMS,
  writerBucket,
} from "../src/vault-shapes";
import { alertTags, LINT_TAGS, lintRows, runVaultLintOnce } from "../src/worker/vault-lint";
import { FIELD_SHAPES_RULE, buildPrompt } from "../src/agent-exec";
import { buildSessionPrompt } from "../src/agent-sessions";
import { BLOCK_PATH, expectedBlockFile, PROMPT_FILES, stalePromptFiles, withBlock } from "../../../scripts/vault-hygiene/gen-field-shapes";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const fixes = JSON.parse(readFileSync(join(ROOT, "scripts/vault-hygiene/schema-fixes.json"), "utf8")) as {
  changes: Array<{ id: string; tag: string; field: string; optional?: boolean; to: { type?: string; enum?: string[]; default?: unknown } }>;
};
const seeded = JSON.parse(readFileSync(join(ROOT, "packages/core/src/lib/schemas/tag-schemas.json"), "utf8")) as {
  tags: Record<string, { fields: Record<string, { type: string; enum?: string[]; default?: unknown }> }>;
};
const sorted = (xs: Iterable<string>) => [...xs].sort();
const named = (o: Record<string, unknown>) => Object.entries(o).filter(([k]) => k !== "_note");

test("drift: tag-schemas.json holds every approved correction (and none of the optional ones)", () => {
  for (const c of fixes.changes) {
    const have = seeded.tags[c.tag]?.fields?.[c.field];
    if (c.optional) {
      assert.equal(have, undefined, `${c.id}: optional (S12/S13) fields stay out of the seed file`);
      continue;
    }
    assert.ok(have, `${c.id}: ${c.tag}.${c.field} is missing from tag-schemas.json`);
    assert.equal(have.type, c.to.type, `${c.id}: type`);
    assert.deepEqual(have.enum, c.to.enum, `${c.id}: allowed values`);
    assert.deepEqual(have.default, c.to.default, `${c.id}: default`);
  }
});

test("drift: the contract's list fields are exactly the declared array fields (+ the named undeclared ones)", () => {
  const undeclared = Object.fromEntries(named(C.undeclaredListFields)) as Record<string, string[]>;
  const exemptArrays = Object.fromEntries(named(C.exemptArrayFields)) as Record<string, Record<string, string>>;
  for (const [tag, def] of Object.entries(seeded.tags)) {
    if (isExemptTag(tag)) {
      assert.equal(C.listFields[tag], undefined, `${tag} is exempt: it must not be in listFields`);
      continue;
    }
    const declaredArrays = Object.entries(def.fields).filter(([, f]) => f.type === "array").map(([name]) => name);
    for (const f of declaredArrays) {
      const covered = (C.listFields[tag] ?? []).includes(f) || exemptArrays[tag]?.[f] !== undefined;
      assert.ok(covered, `${tag}.${f} is declared an array in tag-schemas.json but the contract neither lists nor exempts it`);
    }
  }
  for (const [tag, fields] of Object.entries(C.listFields)) {
    assert.ok(seeded.tags[tag], `listFields names an unknown tag: ${tag}`);
    for (const f of fields) {
      const declared: { type: string } | undefined = seeded.tags[tag]!.fields[f];
      const isUndeclared = (undeclared[tag] ?? []).includes(f);
      if (declared) {
        assert.equal(declared.type, "array", `${tag}.${f} is a list in the contract but ${declared.type} in tag-schemas.json`);
        assert.ok(!isUndeclared, `${tag}.${f} is now declared: remove it from undeclaredListFields`);
      } else {
        assert.ok(isUndeclared, `${tag}.${f} is a list in the contract but not declared in tag-schemas.json — declare it, or name it in undeclaredListFields`);
      }
    }
  }
  for (const [tag, fields] of Object.entries(undeclared)) for (const f of fields) assert.ok((C.listFields[tag] ?? []).includes(f), `undeclaredListFields ${tag}.${f} is not a list field`);
  // An approved correction that makes a field a list must be in the contract.
  for (const c of fixes.changes) if (c.to.type === "array" && !exemptArrays[c.tag]?.[c.field]) assert.ok((C.listFields[c.tag] ?? []).includes(c.field), `${c.id}: schema-fixes makes it a list, the contract does not`);
});

test("drift: vocabularies and scalar types match the seeded schemas", () => {
  for (const tag of C.confidence.tags) assert.deepEqual(sorted(seeded.tags[tag]!.fields.confidence!.enum!), sorted(C.confidence.labels), `${tag}.confidence`);
  for (const [tag, def] of Object.entries(seeded.tags)) {
    if (isExemptTag(tag) || !def.fields.confidence) continue;
    assert.ok(C.confidence.tags.includes(tag), `${tag} declares confidence but is not in confidence.tags`);
  }
  assert.deepEqual(sorted(seeded.tags.task!.fields.status!.enum!), sorted(C.taskStatus.values), "task.status");
  for (const [from, to] of Object.entries(C.taskStatus.synonyms)) {
    assert.ok(C.taskStatus.values.includes(to), `synonym ${from} → ${to}: not a status`);
    assert.ok(!C.taskStatus.values.includes(from), `synonym ${from} is itself a status`);
  }
  for (const s of C.taskStatus.mirrorOnly) assert.ok(C.taskStatus.values.includes(s));
  assert.deepEqual(sorted(seeded.tags["message-thread"]!.fields.platform!.enum!), sorted(C.threadPlatforms), "message-thread.platform");
  for (const tag of C.source.tags) {
    const f = seeded.tags[tag]!.fields.source!;
    assert.equal(f.type, "string");
    assert.equal(f.enum, undefined, `${tag}.source is free text (S9): the contract's "known" list is advice, not an enum`);
  }
  for (const [tag, fields] of Object.entries(C.textFields)) {
    for (const f of fields) for (const t of tag === "*" ? Object.keys(seeded.tags) : [tag]) if (seeded.tags[t]!.fields[f]) assert.equal(seeded.tags[t]!.fields[f]!.type, "string", `${t}.${f}`);
  }
  for (const [tag, fields] of Object.entries(C.integerFields)) for (const f of fields) assert.equal(seeded.tags[tag]!.fields[f]!.type, "integer", `${tag}.${f}`);
  for (const tag of C.lowercaseStatusTags) for (const v of seeded.tags[tag]!.fields.status!.enum!) assert.equal(v, v.toLowerCase(), `${tag}.status ${v}`);
});

test("drift: the server guard is built from the contract, value for value", () => {
  assert.deepEqual(LIST_FIELDS_BY_TAG, C.listFields);
  assert.deepEqual(sorted(ALWAYS_LIST), sorted(new Set(Object.values(C.listFields).flat())));
  assert.deepEqual(sorted(CONFIDENCE_TAGS), sorted(C.confidence.tags));
  assert.deepEqual([...CONFIDENCE_LABELS], C.confidence.labels);
  assert.deepEqual(sorted(TASK_STATUSES), sorted(C.taskStatus.values));
  assert.deepEqual(TASK_STATUS_SYNONYMS, C.taskStatus.synonyms);
  assert.deepEqual(sorted(THREAD_PLATFORMS), sorted(C.threadPlatforms));
  // Behaviour, driven by the contract's own data (so a rule added to the JSON is exercised).
  for (const [tag, fields] of Object.entries(C.listFields)) {
    const dirty = Object.fromEntries(fields.map((f, i) => [f, i % 2 ? "" : "one"]));
    const shaped = shapeMetadata(dirty, [tag], "create")!;
    for (const f of fields) assert.ok(shaped[f] === undefined || Array.isArray(shaped[f]), `${tag}.${f}`);
    assert.deepEqual(shapeViolations(shaped, tag), [], `the guard's output passes the lint (${tag})`);
    assert.ok(shapeViolations(dirty, tag).length > 0, `the lint sees the dirty ${tag}`);
  }
  for (const f of C.textFields["*"] ?? []) assert.equal(shapeMetadata({ [f]: 12 }, undefined, "update")![f], "12");
  for (const [tag, fs] of Object.entries(C.textFields)) if (tag !== "*") for (const f of fs) assert.equal(shapeMetadata({ [f]: 2 }, [tag], "create")![f], "2");
  for (const [tag, fs] of Object.entries(C.integerFields)) for (const f of fs) assert.equal(shapeMetadata({ [f]: "2026-10-01T00:00:00Z" }, [tag], "create")![f], 1790812800000);
  const folder = `[[${C.projectLink.folder}/x]]`;
  for (const f of C.projectLink.fields) {
    assert.deepEqual(shapeViolations({ [f]: [folder] }, "report"), [`${f}:folder-link`]);
    assert.deepEqual(shapeViolations({ [f]: [`[[${C.projectLink.folder}/x/${C.projectLink.noteName}]]`] }, "report"), []);
  }
});

test("drift: the lint covers every schema'd tag of the personal vault", () => {
  assert.deepEqual([...LINT_TAGS], C.lintTags);
  assert.equal(new Set(LINT_TAGS).size, LINT_TAGS.length);
  for (const tag of LINT_TAGS) assert.ok(seeded.tags[tag], `lintTags names an unknown tag: ${tag}`);
  for (const [tag, def] of Object.entries(seeded.tags)) {
    if (isExemptTag(tag) || Object.keys(def.fields).length === 0) continue;
    assert.ok(LINT_TAGS.includes(tag), `${tag} has a schema but the lint never samples it — add it to lintTags`);
  }
  for (const tag of Object.keys(C.listFields)) assert.ok(LINT_TAGS.includes(tag), `${tag} has list rules but is not linted`);
  for (const tag of C.lintAlertTags) assert.ok(LINT_TAGS.includes(tag), `lintAlertTags names ${tag}, which is not linted`);
  assert.deepEqual(sorted(alertTags("default")), sorted(C.lintAlertTags));
  assert.deepEqual(sorted(alertTags("all")), sorted(LINT_TAGS));
  assert.deepEqual(sorted(alertTags("email, research, nope")), ["email", "research"]);
  // The lean listing asks for every key a check reads, and for nothing unbounded.
  for (const tag of LINT_TAGS) {
    const keys = lintKeys(tag);
    for (const f of [...(C.listFields[tag] ?? []), ...Object.keys(DECLARED_FIELDS[tag] ?? {}), ...PROVENANCE_KEYS, ...C.projectLink.fields]) assert.ok(keys.includes(f), `${tag}: ${f}`);
    assert.ok(keys.length <= 40, `${tag}: ${keys.length} keys`);
  }
});

test("lint: declared-schema violations are named by field and kind, never counted twice", () => {
  assert.deepEqual(declaredViolations({ status: "Done", priority: "high" }, "proposal"), ["status:enum"]);
  assert.deepEqual(declaredViolations({ status: "" }, "proposal"), ["status:empty"]);
  assert.deepEqual(declaredViolations({ isUnread: "yes", messageCount: 1.5, subject: "x" }, "email").sort(), ["isUnread:type", "messageCount:type"]);
  assert.deepEqual(declaredViolations({ status: null, url: undefined }, "writing"), []);
  // `confidence` is the guard's field: when shapeViolations reported it, the declared check stays quiet.
  const md = { confidence: 0.9, role: "" };
  const bad = shapeViolations(md, "person");
  assert.deepEqual(bad, ["confidence"]);
  assert.deepEqual(declaredViolations(md, "person", bad), ["role:empty"]);
  // Reported, but not part of the rate unless enforced.
  const rows = [{ metadata: { status: "Done" } }, { metadata: { status: "draft" } }];
  assert.deepEqual(lintRows(rows, "proposal").declared, { "status:enum": 1 });
  assert.equal(lintRows(rows, "proposal").warned, 0);
  assert.equal(lintRows(rows, "proposal", { declaredEnforce: true }).warned, 1);
});

test("lint: fresh drift (written since the last run) and who wrote it", async () => {
  assert.equal(writerBucket({ source: "ClickUp" }), "clickup");
  assert.equal(writerBucket({ source: "https://example.org/x" }), "unknown", "only a short vocabulary word is ever a bucket");
  assert.equal(writerBucket({ calendarEventId: "e" }), "calendar");
  assert.equal(writerBucket({ processed_by: "x" }), "routine");
  assert.equal(writerBucket({ prism_last_writer: "u_0123456789abcdef" }), "prism-user");
  assert.equal(writerBucket({}), "unknown");

  const store = new Map<string, string>();
  const T0 = Date.parse("2026-10-09T10:00:00Z");
  let clock = T0;
  const deps = {
    getCursor: (v: string, n: string) => store.get(`${v}:${n}`) ?? null,
    setCursor: (v: string, n: string, val: string) => void store.set(`${v}:${n}`, val),
    now: () => clock,
    sample: 100,
    maxRate: 0.2,
    minSample: 10,
  };
  const clean = (n: number) => Array.from({ length: n }, () => ({ metadata: { aliases: ["a"] }, updatedAt: "2026-10-01T00:00:00Z" }));
  const first = await runVaultLintOnce("primary", { ...deps, list: async (tag) => (tag === "person" ? clean(100) : []) });
  assert.equal(first.status, "ok");
  assert.equal(first.tags.person!.fresh, 0, "the first run has nothing to compare with");
  assert.equal(first.lastGoodAt, new Date(T0).toISOString());

  // Next day: 3 person notes written overnight by a routine carry `""` in a list. 3% is far
  // under the 20% rate threshold — the rate alone would never alert.
  clock = T0 + 86_400_000;
  const drifted = [
    ...Array.from({ length: 3 }, () => ({ metadata: { aliases: "", processed_by: "weave" }, updatedAt: "2026-10-10T04:05:00Z" })),
    { metadata: { organizations: "" }, updatedAt: "2026-09-01T00:00:00Z" }, // legacy: mis-shaped but not new
    ...clean(96),
  ];
  const list = async (tag: string) => (tag === "person" ? drifted : []);
  const reportOnly = await runVaultLintOnce("primary", { ...deps, list });
  assert.equal(reportOnly.tags.person!.rate, 0.04);
  assert.equal(reportOnly.tags.person!.fresh, 3);
  assert.deepEqual(reportOnly.tags.person!.writers, { routine: 3, unknown: 1 });
  assert.equal(reportOnly.status, "ok", "VAULT_LINT_FRESH_MAX defaults to 0: report only");

  store.set("primary:vault-lint", JSON.stringify(first));
  const enforced = await runVaultLintOnce("primary", { ...deps, list, freshMax: 3 });
  assert.equal(enforced.status, "failing");
  assert.deepEqual(enforced.freshOver, ["person"]);
  assert.deepEqual(enforced.over, []);

  // A newly covered tag (email) over the rate threshold is REPORTED, not alerted on,
  // until it is named in VAULT_LINT_ALERT_TAGS; a long-standing tag (person) alerts.
  const dirtyTag = (bad: string) => async (tag: string) => (tag === bad ? Array.from({ length: 20 }, () => ({ metadata: { projects: ["[[vault/projects/x]]"] } })) : []);
  store.clear();
  const emailBad = await runVaultLintOnce("primary", { ...deps, list: dirtyTag("email") });
  assert.equal(emailBad.status, "ok");
  assert.deepEqual(emailBad.overReportOnly, ["email"]);
  assert.equal((await runVaultLintOnce("primary", { ...deps, list: dirtyTag("email"), alertTags: alertTags("all") })).status, "failing");
  assert.deepEqual((await runVaultLintOnce("primary", { ...deps, list: dirtyTag("person") })).over, ["person"]);

  // A vault outage must not hide a day of drift: the errored run keeps the last good mark.
  store.set("primary:vault-lint", JSON.stringify(first));
  clock = T0 + 86_400_000;
  const broken = await runVaultLintOnce("primary", { ...deps, list: async () => { throw new Error("503"); } });
  assert.equal(broken.status, "error");
  assert.equal(broken.lastGoodAt, first.lastGoodAt);
  clock = T0 + 2 * 86_400_000;
  const after = await runVaultLintOnce("primary", { ...deps, list, freshMax: 3 });
  assert.equal(after.tags.person!.fresh, 3);
  // Names and counts only.
  assert.ok(!JSON.stringify(after).includes("weave"));
});

test("drift: the generated prompt block is current everywhere it is pasted", () => {
  assert.equal(readFileSync(BLOCK_PATH, "utf8"), expectedBlockFile(), "docs/vault-field-shapes.md is stale: node --import tsx scripts/vault-hygiene/gen-field-shapes.ts --write");
  assert.deepEqual(stalePromptFiles(), [], "a prompt file carries a stale block");
  for (const rel of PROMPT_FILES) assert.ok(withBlock(readFileSync(join(ROOT, rel), "utf8"), "x") !== null, rel);
  const body = renderFieldShapesBody();
  assert.ok(!/\{[A-Za-z]+\}/.test(body.replace(/query-notes \{[^}]*\}/g, "")), "an unfilled {placeholder} in the block");
  for (const [tag, fields] of Object.entries(C.listFields)) for (const f of fields) assert.ok(body.includes(`\`${f}\``) && body.includes(`${tag}:`), `${tag}.${f} is not in the block`);
  for (const v of [...C.confidence.labels, ...C.taskStatus.values, ...C.source.known]) assert.ok(body.includes(`\`${v}\``), v);
  assert.ok(body.includes(`[[${C.projectLink.folder}/<slug>/${C.projectLink.noteName}]]`));
});

test("drift: every agent that can write is told the field shapes; read-only ones are not", () => {
  assert.equal(FIELD_SHAPES_RULE, renderFieldShapesRule());
  for (const fields of Object.values(C.listFields)) for (const f of fields) assert.ok(FIELD_SHAPES_RULE.includes(f), f);
  for (const v of C.taskStatus.values) assert.ok(FIELD_SHAPES_RULE.includes(v), v);
  assert.ok(FIELD_SHAPES_RULE.length < 1500, "this rule is sent on every turn: keep it short");
  assert.ok(buildPrompt("do it", "weave", null).includes(FIELD_SHAPES_RULE));
  assert.ok(buildSessionPrompt("x", { profile: "vault-rw", firstTurn: true }).includes(FIELD_SHAPES_RULE));
  assert.ok(buildSessionPrompt("x", { profile: "vault-rw", firstTurn: false }).includes(FIELD_SHAPES_RULE), "on later turns too");
  assert.ok(!buildSessionPrompt("x", { profile: "vault-ro", firstTurn: true }).includes(FIELD_SHAPES_RULE));
});

test("drift: no prompt in the repo teaches the folder form of a project link", () => {
  const offenders: string[] = [];
  const folderLink = new RegExp(`\\[\\[${C.projectLink.folder}/[^\\]/|#]+\\]\\]`);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) {
        // A line may QUOTE the folder form to forbid it ("never", "resolves to nothing").
        for (const line of readFileSync(p, "utf8").split("\n")) if (folderLink.test(line) && !/never|resolves to nothing|not the folder|dangl/i.test(line)) offenders.push(`${p.slice(ROOT.length)}: ${line.trim().slice(0, 80)}`);
      }
    }
  };
  walk(join(ROOT, ".claude"));
  assert.deepEqual(offenders, []);
});

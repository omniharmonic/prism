/**
 * Server skill scheduler (WP1.1): due computation (interval / runAtHour /
 * dependsOn), SKILLS_ENABLED gating, the runner lease, local admission refusal,
 * structured-skill parse/apply, lastRun + dispatch-note shape, claude routing,
 * the LM Studio client, and health reporting. Everything is faked: no vault, no
 * LM Studio, no claude CLI. All prompts/notes are synthetic fixtures.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultConflictError, type Note } from "../src/parachute";
import { config } from "../src/config";
import {
  _resetSkillsState,
  buildNotePrompt,
  dependencyRanToday,
  dispatchNote,
  effectiveRouting,
  extractJson,
  isDue,
  lmStudioClient,
  localAdmission,
  LocalUnavailableError,
  parseRfc3339,
  parseStructuredConfig,
  readSchedule,
  resolveTemplate,
  runnerDispatcher,
  runSkillsOnce,
  runStructured,
  settleSkillWrites,
  stripUrls,
  structuredFallbackPrompt,
  REVIEW_TAG,
  type ClaudeDispatcher,
  type LocalModel,
  type LocalStatus,
  type RunResult,
  type SkillsDeps,
  type SkillsSettings,
  type SkillVault,
} from "../src/worker/skills";
import { runSkillsPass } from "../src/worker/scheduler";
import { getSourceHealth, resetSourceHealth } from "../src/worker/health";
import { _resetDispatches, configureAgentRunner, ensureAgentCwd, type MemorySample, type SpawnedProc } from "../src/agent-exec";

// ── fakes ────────────────────────────────────────────────────────────────────

/** UTC stands in for the host's local time so tests are TZ-independent. */
const utcParts = (d: Date) => ({ hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) });

class FakeVault implements SkillVault {
  notes = new Map<string, Note>();
  calls: Array<{ op: string; id?: string; body?: unknown }> = [];
  private seq = 0;
  /** Simulate a concurrent edit landing just before the next metadata write. */
  concurrentEdit: ((n: Note) => void) | null = null;

  private stamp(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq++)).toISOString();
  }
  add(n: Partial<Note> & { id: string }): Note {
    const note: Note = { content: "", path: null, metadata: null, createdAt: this.stamp(), updatedAt: null, tags: [], ...n };
    note.updatedAt = note.updatedAt ?? this.stamp();
    this.notes.set(note.id, note);
    return note;
  }
  async listNotes(o: { tags?: string[]; limit?: number; includeContent?: boolean }): Promise<Note[]> {
    this.calls.push({ op: "list", body: o });
    const tag = o.tags?.[0];
    return [...this.notes.values()]
      .filter((n) => !tag || (n.tags ?? []).includes(tag))
      .slice(0, o.limit ?? 50000)
      .map((n) => structuredClone(n));
  }
  async getNote(id: string): Promise<Note> {
    this.calls.push({ op: "get", id });
    return structuredClone(this.notes.get(id)!);
  }
  async createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note> {
    this.calls.push({ op: "create", body: p });
    return this.add({ id: `n${this.seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? [] });
  }
  async updateNote(id: string, p: { metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note> {
    this.calls.push({ op: "update", id, body: p });
    const n = this.notes.get(id)!;
    if (this.concurrentEdit) {
      const f = this.concurrentEdit;
      this.concurrentEdit = null;
      f(n);
      n.updatedAt = this.stamp();
    }
    if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== n.updatedAt) throw new VaultConflictError(409, {}, "conflict");
    if (p.metadata) n.metadata = { ...(n.metadata ?? {}), ...p.metadata };
    n.updatedAt = this.stamp();
    return structuredClone(n);
  }
  async addTags(id: string, tags: string[]): Promise<void> {
    this.calls.push({ op: "addTags", id, body: tags });
    const n = this.notes.get(id)!;
    n.tags = [...new Set([...(n.tags ?? []), ...tags])];
  }
  dispatchNotes(): Note[] {
    return [...this.notes.values()].filter((n) => (n.tags ?? []).includes("agent-dispatch"));
  }
}

class FakeLocal implements LocalModel {
  status_: LocalStatus = { reachable: true, loaded: true };
  calls: Array<{ system: string; user: string; schemaName: string; model: string }> = [];
  /** Per-call responder: return JSON or throw. */
  respond: (user: string, attempt: number) => unknown = () => ({ importance: "informational" });
  async status(): Promise<LocalStatus> {
    return this.status_;
  }
  async structured(system: string, user: string, schemaName: string, _schema: unknown, model: string): Promise<unknown> {
    this.calls.push({ system, user, schemaName, model });
    return this.respond(user, this.calls.length);
  }
}

function fakeClaude() {
  const calls: Array<{ skill: string; prompt: string; finish: (r: RunResult) => void }> = [];
  let refuse: string | null = null;
  const dispatcher: ClaudeDispatcher = (req, onFinish) => {
    if (refuse) throw new Error(refuse);
    const id = `c${calls.length}0000000-aaaa`;
    calls.push({ ...req, finish: (r) => onFinish(id, r) });
    return { id };
  };
  return { dispatcher, calls, refuseWith: (r: string | null) => (refuse = r) };
}

const SETTINGS: SkillsSettings = {
  enabled: true,
  defaultProvider: "local",
  localBaseUrl: "http://lm.test/v1",
  localModel: "test/model-small",
  swapMaxPct: 80,
  freeMinPct: 15,
  loadFreeMinPct: 35,
  localRunTimeoutMs: 60_000,
};

const NOW = new Date("2026-03-10T09:30:00.000Z");

function makeDeps(over: Partial<SkillsDeps> = {}) {
  const vault = new FakeVault();
  const local = new FakeLocal();
  const claude = fakeClaude();
  const logs: string[] = [];
  let sample: MemorySample | null = { swapUsedPct: 10, freePct: 60 };
  const deps: SkillsDeps = {
    vault,
    local,
    claude: claude.dispatcher,
    memoryProbe: () => sample,
    now: () => NOW,
    localParts: utcParts,
    settings: { ...SETTINGS },
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, vault, local, claude, logs, setMemory: (s: MemorySample | null) => (sample = s) };
}

/** A synthetic structured classifier skill. */
function classifierSkill(vault: FakeVault, meta: Record<string, unknown> = {}): Note {
  return vault.add({
    id: "skill-classify",
    path: "vault/agent/skills/test-classify",
    tags: ["agent-skill"],
    content: "Classify the note as one of: alpha, beta.",
    metadata: {
      type: "agent-skill",
      skillName: "test-classify",
      description: "synthetic",
      enabled: true,
      intervalSecs: 3600,
      lastRun: null,
      executionMode: "structured",
      structured: {
        sourceTags: ["sample-a", "sample-b"],
        excludeTags: ["done-flag"],
        limit: 20,
        schema: { type: "object", properties: { importance: { type: "string", enum: ["alpha", "beta"] } }, required: ["importance"] },
        resultField: "importance",
        allowedValues: ["alpha", "beta"],
        alsoAddTags: ["done-flag"],
        shortcutLabels: { LABEL_PROMO: "beta" },
      },
      ...meta,
    },
  });
}

beforeEach(() => {
  _resetSkillsState();
  resetSourceHealth();
});

// ── due computation ──────────────────────────────────────────────────────────

test("parseRfc3339 is strict like chrono (offset required; bare dates/garbage = never run)", () => {
  assert.equal(parseRfc3339("2026-03-10T08:00:00Z"), Date.parse("2026-03-10T08:00:00Z"));
  assert.equal(parseRfc3339("2026-03-10T08:00:00.123456789+00:00"), Date.parse("2026-03-10T08:00:00.123Z"));
  assert.equal(parseRfc3339("2026-03-10"), null);
  assert.equal(parseRfc3339("2026-03-10T08:00:00"), null);
  assert.equal(parseRfc3339(null), null);
  assert.equal(parseRfc3339(12345), null);
});

test("readSchedule: desktop defaults (intervalSecs 3600, enabled must be boolean true, as_u64 semantics)", () => {
  const s = readSchedule({ enabled: "true", intervalSecs: 1.5, runAtHour: -1 });
  assert.equal(s.enabled, false);
  assert.equal(s.intervalSecs, 3600);
  assert.equal(s.runAtHour, undefined);
  assert.equal(readSchedule({ enabled: true, intervalSecs: 60, runAtHour: 7 }).runAtHour, 7);
});

test("isDue: interval skills", () => {
  const base = { enabled: true, intervalSecs: 3600, runAtHour: undefined, dependsOn: undefined };
  assert.equal(isDue({ ...base, lastRun: null }, NOW, utcParts), true, "never run → due");
  assert.equal(isDue({ ...base, lastRun: NOW.getTime() - 3599_000 }, NOW, utcParts), false);
  assert.equal(isDue({ ...base, lastRun: NOW.getTime() - 3600_000 }, NOW, utcParts), true, ">= interval → due");
  assert.equal(isDue({ ...base, lastRun: NOW.getTime() + 60_000 }, NOW, utcParts), false, "future lastRun is not due");
  // runAtHour is ignored for sub-daily intervals.
  assert.equal(isDue({ ...base, runAtHour: 23, lastRun: NOW.getTime() - 3600_000 }, NOW, utcParts), true);
});

test("isDue: daily runAtHour skills (local hour + local date)", () => {
  const daily = { enabled: true, intervalSecs: 86400, dependsOn: undefined };
  // NOW is 09:30 local.
  assert.equal(isDue({ ...daily, runAtHour: 10, lastRun: null }, NOW, utcParts), false, "before the hour");
  assert.equal(isDue({ ...daily, runAtHour: 9, lastRun: null }, NOW, utcParts), true, "past the hour, never ran");
  assert.equal(isDue({ ...daily, runAtHour: 7, lastRun: Date.parse("2026-03-10T07:05:00Z") }, NOW, utcParts), false, "already ran today");
  assert.equal(isDue({ ...daily, runAtHour: 7, lastRun: Date.parse("2026-03-09T23:59:00Z") }, NOW, utcParts), true, "ran yesterday");
  // Without runAtHour a daily skill is a plain 24h interval.
  assert.equal(isDue({ ...daily, runAtHour: undefined, lastRun: Date.parse("2026-03-09T10:00:00Z") }, NOW, utcParts), false);
});

test("dependsOn: waits for the named skill (enabled or not) to have run today", () => {
  const dep = (lastRun: string | null, enabled = false): Note => ({
    id: "d", content: "", path: null, createdAt: "", updatedAt: null, tags: ["agent-skill"],
    metadata: { skillName: "upstream", enabled, lastRun },
  });
  assert.equal(dependencyRanToday("upstream", [dep(null)], NOW, utcParts), false);
  assert.equal(dependencyRanToday("upstream", [dep("2026-03-09T20:00:00Z")], NOW, utcParts), false);
  assert.equal(dependencyRanToday("upstream", [dep("2026-03-10T06:00:00Z")], NOW, utcParts), true);
  assert.equal(dependencyRanToday("other", [dep("2026-03-10T06:00:00Z")], NOW, utcParts), false);
});

test("pass: a dependent skill waits on this pass's snapshot, then runs next pass", async () => {
  const { deps, vault, claude } = makeDeps({ settings: { ...SETTINGS, defaultProvider: "claude" } });
  vault.add({ id: "up", tags: ["agent-skill"], content: "upstream task", metadata: { skillName: "upstream", enabled: true, intervalSecs: 86400, runAtHour: 6, lastRun: null } });
  vault.add({ id: "down", tags: ["agent-skill"], content: "downstream task", metadata: { skillName: "downstream", enabled: true, intervalSecs: 86400, runAtHour: 7, dependsOn: "upstream", lastRun: null } });
  const r1 = await runSkillsOnce(deps);
  assert.deepEqual(r1.dispatched, ["upstream"]);
  const r2 = await runSkillsOnce(deps);
  assert.deepEqual(r2.dispatched, ["downstream"]);
  assert.equal(claude.calls.length, 2);
});

test("resolveTemplate: {{today}}/{{yesterday}} UTC dates, {{now}} RFC 3339, every occurrence", () => {
  assert.equal(
    resolveTemplate("a {{today}} b {{yesterday}} c {{now}} d {{today}}", NOW),
    "a 2026-03-10 b 2026-03-09 c 2026-03-10T09:30:00.000Z d 2026-03-10",
  );
});

test("effectiveRouting: note override > defaults; local needs provider local|ollama + base url + model", () => {
  assert.deepEqual(effectiveRouting({}, SETTINGS), { useLocal: true, model: "test/model-small", provider: "local" });
  assert.equal(effectiveRouting({ provider: "claude" }, SETTINGS).useLocal, false);
  assert.equal(effectiveRouting({ provider: "ollama", model: "x" }, { ...SETTINGS, defaultProvider: "claude" }).useLocal, true);
  assert.equal(effectiveRouting({ provider: "" , model: "" }, SETTINGS).model, "test/model-small", "empty override falls back");
  assert.equal(effectiveRouting({}, { ...SETTINGS, localModel: "" }).useLocal, false, "no model → claude");
  assert.equal(effectiveRouting({}, { ...SETTINGS, localBaseUrl: "" }).useLocal, false, "no local server → claude");
});

// ── gating + lease ───────────────────────────────────────────────────────────

test("SKILLS_ENABLED=false: nothing runs and nothing is read or written", async () => {
  const { deps, vault, local, claude } = makeDeps({ settings: { ...SETTINGS, enabled: false } });
  classifierSkill(vault);
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res, { dispatched: [], refused: [], leased: [], finished: [] });
  assert.equal(vault.calls.length, 0);
  assert.equal(local.calls.length, 0);
  assert.equal(claude.calls.length, 0);
});

test("SKILLS_ENABLED defaults to false in config", () => {
  assert.equal(config.skillsEnabled, false);
});

test("lease: enabled skills get runner=server (with if_updated_at); desktop-pinned and disabled are untouched", async () => {
  const { deps, vault, logs } = makeDeps({ settings: { ...SETTINGS, defaultProvider: "claude" } });
  const aStamp = vault.add({ id: "a", tags: ["agent-skill"], content: "p", metadata: { skillName: "a", enabled: true, lastRun: NOW.toISOString() } }).updatedAt;
  vault.add({ id: "b", tags: ["agent-skill"], content: "p", metadata: { skillName: "b", enabled: true, runner: "desktop", lastRun: null } });
  vault.add({ id: "c", tags: ["agent-skill"], content: "p", metadata: { skillName: "c", enabled: false } });
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res.leased, ["a"]);
  assert.deepEqual(res.dispatched, [], "a is not due; b is pinned to desktop");
  assert.equal(vault.notes.get("a")!.metadata!.runner, "server");
  assert.equal(vault.notes.get("b")!.metadata!.runner, "desktop");
  assert.equal(vault.notes.get("c")!.metadata!.runner, undefined);
  const upd = vault.calls.find((c) => c.op === "update" && c.id === "a")!.body as { ifUpdatedAt?: string };
  assert.equal(upd.ifUpdatedAt, aStamp);
  assert.ok(logs.some((l) => l.includes("pinned")));
  // Already leased → no second write.
  const before = vault.calls.filter((c) => c.op === "update").length;
  await runSkillsOnce(deps);
  assert.equal(vault.calls.filter((c) => c.op === "update").length, before);
});

// ── structured skills ────────────────────────────────────────────────────────

test("parseStructuredConfig: defaults + actionable errors", () => {
  const ok = parseStructuredConfig({ structured: { sourceTags: ["x"], schema: {}, resultField: "f" } });
  assert.equal(ok.limit, 50);
  assert.deepEqual(ok.excludeTags, []);
  assert.equal(ok.shortcutLabels.size, 0);
  assert.throws(() => parseStructuredConfig({}), /missing 'structured' config block/);
  assert.throws(() => parseStructuredConfig({ structured: { sourceTags: [] } }), /sourceTags' is missing or empty/);
  assert.throws(() => parseStructuredConfig({ structured: { sourceTags: ["x"] } }), /schema' is missing/);
  assert.throws(() => parseStructuredConfig({ structured: { sourceTags: ["x"], schema: {} } }), /resultField' is missing/);
});

test("stripUrls / buildNotePrompt / extractJson match the desktop helpers", () => {
  assert.equal(stripUrls("see https://x.test/a?b=c now\nand ftp://y z"), "see <link> now\nand <link> z");
  const n: Note = {
    id: "1", path: "vault/messages/sample/Hello World", createdAt: "", updatedAt: null, tags: [],
    content: "Body with https://link.test/abc text",
    metadata: { from: "Sender A", date: "2026-03-09", labels: ["L1", "L2"] },
  };
  assert.equal(
    buildNotePrompt(n, "2026-03-10", 2500),
    "Today's date: 2026-03-10\nFrom: Sender A\nMessage date: 2026-03-09\nSource labels: L1, L2\nTitle: Hello World\n\nBody with <link> text",
  );
  assert.ok(buildNotePrompt(n, "2026-03-10", 4).endsWith("\n\nBody"));
  assert.ok(buildNotePrompt({ ...n, path: null, metadata: null }, "d", 10).includes("Title: Untitled"));
  assert.deepEqual(extractJson('  {"a":1} '), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":"b"} done'), { a: "b" });
  assert.equal(extractJson("nothing here"), undefined);
});

function seedCandidates(vault: FakeVault) {
  vault.add({ id: "m1", path: "vault/s/one", tags: ["sample-a"], content: "first", metadata: {} });
  vault.add({ id: "m2", path: "vault/s/two", tags: ["sample-a", "sample-b"], content: "second (both tags)", metadata: {} });
  vault.add({ id: "m3", path: "vault/s/three", tags: ["sample-b", "done-flag"], content: "already done", metadata: {} });
  vault.add({ id: "m4", path: "vault/s/four", tags: ["sample-b", REVIEW_TAG], content: "flagged before", metadata: {} });
  vault.add({ id: "m5", path: "vault/s/five", tags: ["sample-b"], content: "promo", metadata: { labels: ["LABEL_PROMO"] } });
  vault.add({ id: "m6", path: "vault/s/six", tags: ["sample-b"], content: "weird", metadata: {} });
}

test("runStructured: union+dedup, exclusions, shortcut, retry, allowlist → review tag, summary text", async () => {
  const vault = new FakeVault();
  const local = new FakeLocal();
  seedCandidates(vault);
  const cfg = parseStructuredConfig(classifierSkill(vault).metadata!);
  const attempts = new Map<string, number>();
  local.respond = (user) => {
    const title = /Title: (\S+)/.exec(user)![1]!;
    const n = (attempts.get(title) ?? 0) + 1;
    attempts.set(title, n);
    if (title === "one") return { importance: "alpha" };
    if (title === "two") {
      if (n === 1) throw new Error("local AI returned 400: context overflow");
      return { importance: "beta" }; // succeeds on the truncated retry
    }
    if (title === "six") return { importance: "gamma" }; // not allowed → flagged, not retried
    throw new Error("unexpected " + title);
  };
  const summary = await runStructured(vault, local, "RUBRIC", cfg, "test/model-small", { today: "2026-03-10" });
  assert.equal(summary, "Structured tagging complete — 3 of 4 note(s) classified, 1 flagged for review (triage-failed).\nalpha: 1, beta: 2");
  assert.deepEqual(vault.notes.get("m1")!.tags, ["sample-a", "alpha", "done-flag"]);
  assert.deepEqual(vault.notes.get("m2")!.tags, ["sample-a", "sample-b", "beta", "done-flag"]);
  assert.deepEqual(vault.notes.get("m5")!.tags, ["sample-b", "beta", "done-flag"], "shortcut label, no model call");
  assert.deepEqual(vault.notes.get("m6")!.tags, ["sample-b", REVIEW_TAG]);
  assert.deepEqual(vault.notes.get("m3")!.tags, ["sample-b", "done-flag"], "excluded");
  assert.equal(attempts.get("five"), undefined);
  assert.equal(attempts.get("two"), 2);
  assert.equal(attempts.get("six"), 1, "a disallowed value is not retried");
  // Retry prompt is the truncated one; rubric is the system prompt; schema name fixed.
  assert.ok(local.calls.every((c) => c.system === "RUBRIC" && c.schemaName === "classification"));
  assert.ok(local.calls[0]!.user.startsWith("Today's date: 2026-03-10\n"));
});

test("runStructured: nothing to do → the desktop's message", async () => {
  const vault = new FakeVault();
  const cfg = parseStructuredConfig(classifierSkill(vault).metadata!);
  assert.equal(await runStructured(vault, new FakeLocal(), "R", cfg, "m", { today: "d" }), "No unprocessed notes to classify.");
});

test("runStructured: an unreachable LM Studio aborts the run without flagging notes", async () => {
  const vault = new FakeVault();
  const local = new FakeLocal();
  seedCandidates(vault);
  const cfg = parseStructuredConfig(classifierSkill(vault).metadata!);
  local.respond = () => {
    throw new LocalUnavailableError("local AI HTTP error: connection refused");
  };
  await assert.rejects(runStructured(vault, local, "R", cfg, "m", { today: "d" }), /connection refused/);
  assert.equal([...vault.notes.values()].filter((n) => (n.tags ?? []).includes(REVIEW_TAG)).length, 1, "only the pre-existing flag");
});

test("runStructured: memory pressure between notes stops early and says so", async () => {
  const vault = new FakeVault();
  const local = new FakeLocal();
  seedCandidates(vault);
  const cfg = parseStructuredConfig(classifierSkill(vault).metadata!);
  local.respond = () => ({ importance: "alpha" });
  let checks = 0;
  const summary = await runStructured(vault, local, "R", cfg, "m", { today: "d", pressure: () => (++checks >= 1 ? "memory pressure: 9% free (< 15%)" : null) });
  assert.match(summary, /^Structured tagging complete — 1 of 4 note\(s\) classified\.\nalpha: 1\nStopped early after 1 of 4 \(memory pressure: 9% free/);
});

test("pass: structured local run writes lastRun (metadata preserved) + a desktop-shaped dispatch note", async () => {
  const { deps, vault, local } = makeDeps();
  seedCandidates(vault);
  classifierSkill(vault, { runner: "server", model: "test/pinned-model", extraField: 7 });
  local.respond = () => ({ importance: "alpha" });
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res.dispatched, ["test-classify"]);
  assert.deepEqual(res.finished, [{ skill: "test-classify", status: "completed" }]);
  assert.ok(local.calls.every((c) => c.model === "test/pinned-model"), "the skill note's model wins");

  const meta = vault.notes.get("skill-classify")!.metadata!;
  assert.equal(meta.lastRun, NOW.toISOString());
  assert.equal(meta.extraField, 7);
  assert.equal(meta.runner, "server");
  assert.ok(meta.structured, "structured block carried over");

  const [d] = vault.dispatchNotes();
  assert.ok(d);
  assert.deepEqual(d.tags, ["agent-dispatch", "agent-output"]);
  assert.match(d.path!, /^vault\/agent\/dispatches\/\d{4}-\d{2}-\d{2}\/test-classify-[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(d.metadata!).sort(), ["completedAt", "durationSecs", "runner", "skill", "startedAt", "status", "type"]);
  assert.equal(d.metadata!.type, "agent-dispatch");
  assert.equal(d.metadata!.skill, "test-classify");
  assert.equal(d.metadata!.status, "completed");
  assert.match(d.content, /^# Agent: test-classify\n\n\*\*Status:\*\* Completed\n\*\*Started:\*\* .+\n\*\*Completed:\*\* .+\n\*\*Duration:\*\* \d+s\n\n---\n\nStructured tagging complete — /);

  // Not due again within the interval.
  const again = await runSkillsOnce(deps);
  assert.deepEqual(again.dispatched, []);
});

test("dispatchNote: failed shape (error section, no output), slug lowercases + dashes spaces", () => {
  const n = dispatchNote("abcdef12-3456", "My Skill", { status: "failed", output: null, error: "boom", startedAt: Date.parse("2026-03-10T01:02:03Z"), completedAt: Date.parse("2026-03-10T01:02:05Z"), durationSecs: 2 });
  assert.equal(n.path, "vault/agent/dispatches/2026-03-10/my-skill-abcdef12");
  assert.equal(
    n.content,
    "# Agent: My Skill\n\n**Status:** Failed\n**Started:** 2026-03-10T01:02:03.000Z\n**Completed:** 2026-03-10T01:02:05.000Z\n**Duration:** 2s\n\n## Error\n\nboom\n",
  );
  assert.equal(n.metadata.status, "failed");
});

test("pass: a misconfigured structured skill is a FAILED dispatch (lastRun still written, like the desktop)", async () => {
  const { deps, vault, local } = makeDeps();
  vault.add({ id: "bad", tags: ["agent-skill"], content: "r", metadata: { skillName: "bad", enabled: true, runner: "server", executionMode: "structured" } });
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res.finished, [{ skill: "bad", status: "failed" }]);
  assert.equal(local.calls.length, 0);
  assert.equal(vault.notes.get("bad")!.metadata!.lastRun, NOW.toISOString());
  const [d] = vault.dispatchNotes();
  assert.match(d!.content, /structured skill misconfigured: missing 'structured' config block/);
  assert.equal(d!.metadata!.durationSecs, 0);
});

// ── admission ────────────────────────────────────────────────────────────────

test("localAdmission: unreachable / swap / free / JIT-load thresholds", () => {
  const up: LocalStatus = { reachable: true, loaded: true };
  const s = { swapMaxPct: 80, freeMinPct: 15, loadFreeMinPct: 35 };
  assert.equal(localAdmission({ swapUsedPct: 10, freePct: 60 }, up, "m", s).ok, true);
  assert.match(localAdmission(null, { reachable: false, loaded: null, error: "ECONNREFUSED" }, "m", s).reason!, /unreachable \(ECONNREFUSED\)/);
  assert.match(localAdmission({ swapUsedPct: 85, freePct: 60 }, up, "m", s).reason!, /swap 85% used/);
  assert.match(localAdmission({ swapUsedPct: 10, freePct: 10 }, up, "m", s).reason!, /10% free \(< 15%\)/);
  // Loaded model at 20% free: fine (no JIT load). Not loaded at 20%: refused.
  assert.equal(localAdmission({ swapUsedPct: 10, freePct: 20 }, up, "m", s).ok, true);
  assert.match(localAdmission({ swapUsedPct: 10, freePct: 20 }, { reachable: true, loaded: false }, "m", s).reason!, /not loaded and only 20% memory is free \(< 35%\)/);
  // Unknown loaded state is treated as "would load" (fail-safe for memory).
  assert.equal(localAdmission({ swapUsedPct: 10, freePct: 20 }, { reachable: true, loaded: null }, "m", s).ok, false);
  // Unreadable memory probe admits (fail-open, like the runner).
  assert.equal(localAdmission(null, { reachable: true, loaded: false }, "m", s).ok, true);
});

test("pass: admission refusal keeps the skill due (no lastRun, no dispatch note, no model call), logs once, runs when memory frees", async () => {
  const { deps, vault, local, logs, setMemory } = makeDeps();
  seedCandidates(vault);
  classifierSkill(vault, { runner: "server" });
  local.status_ = { reachable: true, loaded: false };
  setMemory({ swapUsedPct: 30, freePct: 22 });

  const r1 = await runSkillsOnce(deps);
  const r2 = await runSkillsOnce(deps);
  assert.equal(r1.refused.length, 1);
  assert.match(r1.refused[0]!.reason, /refusing to JIT-load/);
  assert.equal(r2.refused.length, 1);
  assert.equal(vault.notes.get("skill-classify")!.metadata!.lastRun, null);
  assert.equal(vault.dispatchNotes().length, 0);
  assert.equal(local.calls.length, 0);
  assert.equal(logs.filter((l) => l.includes("deferred")).length, 1, "same reason is logged once");

  setMemory({ swapUsedPct: 30, freePct: 50 });
  const r3 = await runSkillsOnce(deps);
  assert.deepEqual(r3.dispatched, ["test-classify"]);
  assert.equal(vault.dispatchNotes().length, 1);
});

test("pass: LM Studio unreachable → refused (stays due), nothing flagged", async () => {
  const { deps, vault } = makeDeps();
  seedCandidates(vault);
  classifierSkill(vault, { runner: "server" });
  (deps.local as FakeLocal).status_ = { reachable: false, loaded: null, error: "fetch failed" };
  const r = await runSkillsOnce(deps);
  assert.match(r.refused[0]!.reason, /unreachable/);
  assert.equal(vault.notes.get("skill-classify")!.metadata!.lastRun, null);
});

// ── claude routing ───────────────────────────────────────────────────────────

test("pass: agentic skills go to the claude runner with the resolved prompt; the dispatch note lands on finish", async () => {
  const { deps, vault, claude, local } = makeDeps();
  vault.add({ id: "ag", tags: ["agent-skill"], content: "Summarize {{today}}.", metadata: { skillName: "Daily Thing", enabled: true, runner: "server" } });
  const res = await runSkillsOnce(deps);
  assert.deepEqual(res.dispatched, ["Daily Thing"]);
  assert.equal(local.calls.length, 0, "agentic never runs the local tool loop on the server");
  assert.deepEqual(claude.calls.map((c) => [c.skill, c.prompt]), [["Daily Thing", "Summarize 2026-03-10."]]);
  assert.equal(vault.notes.get("ag")!.metadata!.lastRun, NOW.toISOString(), "lastRun written on ACCEPT");
  assert.equal(vault.dispatchNotes().length, 0, "not persisted until it finishes");
  claude.calls[0]!.finish({ status: "completed", output: "did it", error: null, startedAt: NOW.getTime(), completedAt: NOW.getTime() + 5000, durationSecs: 5 });
  await settleSkillWrites();
  const [d] = vault.dispatchNotes();
  assert.equal(d!.path, "vault/agent/dispatches/2026-03-10/daily-thing-c0000000");
  assert.match(d!.content, /\n---\n\ndid it\n$/);
});

test("pass: structured with no local model falls back to claude with the desktop's rubric prompt", async () => {
  const { deps, vault, claude } = makeDeps({ settings: { ...SETTINGS, localModel: "" } });
  classifierSkill(vault, { runner: "server" });
  await runSkillsOnce(deps);
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0]!.prompt, structuredFallbackPrompt("Classify the note as one of: alpha, beta."));
  assert.match(claude.calls[0]!.prompt, /^You are a background agent for Prism\. Apply the following classification rubric/);
});

test("pass: a claude runner refusal (queue full) leaves the skill due", async () => {
  const { deps, vault, claude } = makeDeps({ settings: { ...SETTINGS, defaultProvider: "claude" } });
  vault.add({ id: "ag", tags: ["agent-skill"], content: "x", metadata: { skillName: "ag", enabled: true, runner: "server" } });
  claude.refuseWith("agent queue full (20 waiting)");
  const r = await runSkillsOnce(deps);
  assert.match(r.refused[0]!.reason, /queue full/);
  assert.equal(vault.notes.get("ag")!.metadata!.lastRun, undefined);
});

test("lastRun write: a concurrent edit (409) is refetched and merged, not clobbered", async () => {
  const { deps, vault } = makeDeps({ settings: { ...SETTINGS, defaultProvider: "claude" } });
  vault.add({ id: "ag", tags: ["agent-skill"], content: "x", metadata: { skillName: "ag", enabled: true, runner: "server", model: "old" } });
  vault.concurrentEdit = (n) => (n.metadata = { ...n.metadata, model: "edited-by-user" });
  await runSkillsOnce(deps);
  const m = vault.notes.get("ag")!.metadata!;
  assert.equal(m.model, "edited-by-user");
  assert.equal(m.lastRun, NOW.toISOString());
  assert.ok(vault.calls.some((c) => c.op === "get" && c.id === "ag"), "refetched after the conflict");
});

// ── LM Studio client ─────────────────────────────────────────────────────────

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const h = routes[url];
    if (!h) throw new TypeError("fetch failed");
    return h(init);
  };
  return { f, seen };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("lmStudioClient.status: native loaded state, JIT (not loaded), /v1 fallback, unreachable", async () => {
  const a = fakeFetch({ "http://lm.test/api/v0/models": () => json({ data: [{ id: "m", state: "loaded" }, { id: "n", state: "not-loaded" }] }) });
  const c = lmStudioClient("http://lm.test/v1/", a.f);
  assert.deepEqual(await c.status("m"), { reachable: true, loaded: true });
  assert.deepEqual(await c.status("n"), { reachable: true, loaded: false });
  assert.deepEqual(await c.status("absent"), { reachable: true, loaded: false });
  const b = fakeFetch({ "http://lm.test/api/v0/models": () => json({}, 404), "http://lm.test/v1/models": () => json({ data: [] }) });
  assert.deepEqual(await lmStudioClient("http://lm.test/v1", b.f).status("m"), { reachable: true, loaded: null });
  const d = fakeFetch({});
  assert.equal((await lmStudioClient("http://lm.test/v1", d.f).status("m")).reachable, false);
});

test("lmStudioClient.structured: strict json_schema request; content, reasoning_content, prose-wrapped; errors", async () => {
  let body: Record<string, unknown> = {};
  let reply: unknown = { choices: [{ message: { content: '{"importance":"alpha"}' } }] };
  const { f } = fakeFetch({
    "http://lm.test/v1/chat/completions": (init) => {
      body = JSON.parse(String(init!.body));
      return json(reply);
    },
  });
  const c = lmStudioClient("http://lm.test/v1", f);
  assert.deepEqual(await c.structured("SYS", "USER", "classification", { type: "object" }, "m", 1000), { importance: "alpha" });
  assert.deepEqual(body, {
    model: "m",
    messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }],
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: "classification", strict: true, schema: { type: "object" } } },
  });
  reply = { choices: [{ message: { content: "", reasoning_content: 'ok {"importance":"beta"}' } }] };
  assert.deepEqual(await c.structured("S", "U", "n", {}, "m", 1000), { importance: "beta" });
  reply = { choices: [{ message: { content: "no json" } }] };
  await assert.rejects(c.structured("S", "U", "n", {}, "m", 1000), /no parseable JSON; raw: no json/);
  const bad = fakeFetch({ "http://lm.test/v1/chat/completions": () => new Response("ctx overflow", { status: 400 }) });
  await assert.rejects(lmStudioClient("http://lm.test/v1", bad.f).structured("S", "U", "n", {}, "m", 1000), /local AI returned 400: ctx overflow/);
  const down = fakeFetch({});
  await assert.rejects(lmStudioClient("http://lm.test/v1", down.f).structured("S", "U", "n", {}, "m", 1000), (e: Error) => e instanceof LocalUnavailableError);
});

// ── health + the real runner seam ────────────────────────────────────────────

test("runSkillsPass: health records the skills source as a SERVER source when enabled", async () => {
  const prev = config.skillsEnabled;
  (config as { skillsEnabled: boolean }).skillsEnabled = true;
  try {
    const { deps, vault, local } = makeDeps();
    seedCandidates(vault);
    classifierSkill(vault, { runner: "server" });
    local.respond = () => ({ importance: "alpha" });
    await runSkillsPass(deps);
    const h = (await getSourceHealth({ list: async () => [] })).filter((x) => x.name === "skills");
    assert.equal(h.length, 1, "no duplicate desktop-inferred skills row");
    assert.equal(h[0]!.kind, "server");
    assert.equal(h[0]!.status, "ok");
    assert.ok(h[0]!.lastSuccessAt);

    // A failing listing is an error streak.
    const broken = makeDeps();
    broken.deps.vault.listNotes = async () => {
      throw new Error("vault down");
    };
    await runSkillsPass(broken.deps);
    const h2 = (await getSourceHealth({ list: async () => [] })).find((x) => x.name === "skills")!;
    assert.equal(h2.failureStreak, 1);
    assert.match(h2.lastError!, /vault down/);
  } finally {
    (config as { skillsEnabled: boolean }).skillsEnabled = prev;
  }
});

test("health: with SKILLS_ENABLED=false, skills stay a desktop-inferred source", async () => {
  const h = (await getSourceHealth({ list: async () => [] })).filter((x) => x.name === "skills");
  assert.equal(h.length, 1);
  assert.equal(h[0]!.kind, "desktop");
});

test("runnerDispatcher: hands the prompt to the WP0.1 runner and reports the finished run", async () => {
  const cwdRoot = mkdtempSync(join(tmpdir(), "prism-skills-test-"));
  _resetDispatches();
  let exit: ((c: number | null) => void) | null = null;
  let out: ((c: string) => void) | null = null;
  let spawnedArgs: string[] = [];
  configureAgentRunner({
    spawner: (_cmd, args) => {
      spawnedArgs = args;
      const p: SpawnedProc = {
        stdout: { on: (_e, cb) => (out = cb as (c: string) => void) },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === "exit") exit = cb as (c: number | null) => void;
        },
        kill: () => exit?.(null),
      };
      return p;
    },
    cwd: () => ensureAgentCwd(join(cwdRoot, "agent-cwd")),
    claudePath: () => "/opt/fake/claude",
    memoryProbe: () => ({ swapUsedPct: 1, freePct: 90 }),
  });
  try {
    const results: Array<{ id: string; r: RunResult }> = [];
    const { id } = runnerDispatcher({ skill: "syn", prompt: "Do the synthetic task." }, (rid, r) => results.push({ id: rid, r }));
    assert.equal(spawnedArgs.at(-1)!.endsWith("Do the synthetic task."), true);
    assert.ok(spawnedArgs.includes("--strict-mcp-config"), "the hardened argv, not a new spawn path");
    out!("all done\n");
    exit!(0);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, id);
    assert.equal(results[0]!.r.status, "completed");
    assert.equal(results[0]!.r.output, "all done");
  } finally {
    _resetDispatches();
    rmSync(cwdRoot, { recursive: true, force: true });
  }
});

afterEach(async () => {
  await settleSkillWrites();
});

/**
 * Link health (src/worker/link-health.ts): read-only measures of how well the
 * newest notes are linked. Offline: the listings are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTargets,
  floorsFromEnv,
  lastLinkHealthOutcome,
  LINK_MEASURES,
  measureLinks,
  projectValueResolves,
  runLinkHealthOnce,
  wikilinkTarget,
  type LinkRow,
} from "../src/worker/link-health";

const person = (id: string, slug: string): LinkRow => ({ id, path: `vault/people/${slug}`, tags: ["person"], metadata: {} });
const PEOPLE = [person("p1", "ann"), person("p2", "bo")];
const PROJECTS: LinkRow[] = [
  { id: "j1", path: "vault/projects/opencivics/PROJECT", tags: ["project"], metadata: { title: "OpenCivics", aliases: ["OC"] } },
  { id: "j2", path: "vault/projects/legacy", tags: ["project"], metadata: {} },
];
const ORGS: LinkRow[] = [{ id: "o1", path: "vault/organizations/acme", tags: ["organization"], metadata: {} }];
const link = (sourceId: string, targetId: string, relationship: string) => ({ sourceId, targetId, relationship });

test("link-health: wikilink targets and project values", () => {
  assert.equal(wikilinkTarget("[[vault/people/ann|Ann]]"), "vault/people/ann");
  assert.equal(wikilinkTarget("[[vault/projects/x/PROJECT#Goals]]"), "vault/projects/x/PROJECT");
  assert.equal(wikilinkTarget("ann@x.org"), null);
  assert.equal(wikilinkTarget(7), null);
  const t = buildTargets(PEOPLE, PROJECTS, ORGS, 5000);
  assert.equal(projectValueResolves("[[vault/projects/opencivics/PROJECT]]", t), true);
  assert.equal(projectValueResolves("[[vault/projects/opencivics]]", t), false, "the folder form is not a note");
  assert.equal(projectValueResolves("[[vault/projects/legacy]]", t), true, "a legacy note AT the folder path is a note");
  assert.equal(projectValueResolves("opencivics", t), true);
  assert.equal(projectValueResolves("oc", t), true, "alias, any case");
  assert.equal(projectValueResolves("Sprint 6 (10/6 - 10/20)", t), false);
  assert.equal(projectValueResolves("", t), false);
});

test("link-health: every measure from sampled rows (pure)", () => {
  const t = buildTargets(PEOPLE, PROJECTS, ORGS, 5000);
  const m = measureLinks(
    {
      meeting: [
        { id: "m1", tags: ["meeting"], metadata: { attendees: ["ann@x.org"], projects: ["[[vault/projects/opencivics/PROJECT]]"] }, links: [link("m1", "p1", "attended-by")] },
        { id: "m2", tags: ["meeting"], metadata: { attendees: ["[[vault/people/bo]]", "[[vault/people/ghost]]"], projects: ["[[vault/projects/opencivics]]"] }, links: [] },
        { id: "m3", tags: ["meeting"], metadata: { attendees: ["Someone"] }, links: [] },
      ],
      transcript: [
        { id: "t1", tags: ["transcript", "meeting"], metadata: {}, links: [] },
        { id: "t2", tags: ["transcript"], metadata: { meetingNoteId: "m1" }, links: [] },
        { id: "t3", tags: ["transcript"], metadata: {}, links: [link("m2", "t3", "has-transcript")] },
        { id: "t4", tags: ["transcript"], metadata: {}, links: [link("t4", "p1", "attended-by")] },
      ],
      task: [
        { id: "k1", tags: ["task"], metadata: { project: "opencivics" }, links: [] },
        { id: "k2", tags: ["task"], metadata: { project: "Product Milestones" }, links: [link("k2", "j1", "belongs-to")] },
        { id: "k3", tags: ["task"], metadata: {}, links: [] },
      ],
      email: [
        { id: "e1", tags: ["email"], metadata: {}, links: [link("e1", "p2", "email-from")] },
        { id: "e2", tags: ["email"], metadata: {}, links: [] },
      ],
      "message-thread": [{ id: "h1", tags: ["message-thread"], metadata: {}, links: [link("h1", "p1", "messages-with")] }],
      person: [
        { id: "p1", tags: ["person"], metadata: {}, links: [link("m1", "p1", "attended-by")] },
        { id: "p2", tags: ["person"], metadata: {}, links: [] },
      ],
    },
    t,
  );
  assert.deepEqual(m["meeting.person"], { n: 3, hit: 2 }, "a vault link or a person wikilink counts; an address or a name does not");
  assert.deepEqual(m["meeting.project"], { n: 3, hit: 1 });
  assert.deepEqual(m["meeting.project.resolved"], { n: 2, hit: 1 });
  assert.deepEqual(m["transcript.meeting"], { n: 4, hit: 3 });
  assert.deepEqual(m["task.project"], { n: 3, hit: 2 });
  assert.deepEqual(m["task.project.resolved"], { n: 2, hit: 1 });
  assert.deepEqual(m["email.person"], { n: 2, hit: 1 });
  assert.deepEqual(m["thread.person"], { n: 1, hit: 1 });
  assert.deepEqual(m["person.linked"], { n: 2, hit: 1 });
  // Wikilinks into known folders: ann? no — bo (ok), ghost (dangling), opencivics/PROJECT (ok), opencivics folder (dangling).
  assert.deepEqual(m.dangling, { n: 4, hit: 2 });
  assert.deepEqual(Object.keys(m).sort(), [...LINK_MEASURES].sort());
});

test("link-health: a truncated target listing never produces dangling counts", () => {
  const t = buildTargets(PEOPLE, PROJECTS, ORGS, 2); // people + projects hit the cap of 2
  assert.deepEqual(t.truncated, ["person", "project"]);
  const m = measureLinks({ meeting: [{ id: "m", tags: ["meeting"], metadata: { attendees: ["[[vault/people/ghost]]"], projects: ["[[vault/projects/nope/PROJECT]]"], organizations: ["[[vault/organizations/nope]]"] }, links: [] }] }, t);
  assert.deepEqual(m.dangling, { n: 1, hit: 1 }, "only the organization listing is complete");
});

test("link-health: floors come from the environment, by measure", () => {
  assert.deepEqual(floorsFromEnv({ LINK_HEALTH_MIN_MEETING_PROJECT_RESOLVED: "0.8", LINK_HEALTH_MAX_DANGLING: "0.1", LINK_HEALTH_MIN_EMAIL_PERSON: "nope", LINK_HEALTH_MIN_TASK_PROJECT: "7" }), {
    "meeting.project.resolved": 0.8,
    dangling: 0.1,
  });
});

test("link-health: levels, the drop rule, floors, persistence and errors (injected listing)", async () => {
  const store = new Map<string, string>();
  const calls: Array<{ tag: string; keys: readonly string[]; limit: number; withLinks: boolean }> = [];
  const meetings = (linked: number, total: number): LinkRow[] =>
    Array.from({ length: total }, (_, i) => ({ id: `m${i}`, tags: ["meeting"], metadata: {}, links: i < linked ? [link(`m${i}`, "p1", "attended-by")] : [] }));
  let linked = 16;
  const deps = {
    getCursor: (v: string, n: string) => store.get(`${v}:${n}`) ?? null,
    setCursor: (v: string, n: string, val: string) => void store.set(`${v}:${n}`, val),
    sample: 20,
    minSample: 10,
    maxDrop: 0.2,
    targetCap: 5000,
    floors: {},
    list: async (tag: string, keys: readonly string[], limit: number, withLinks: boolean) => {
      calls.push({ tag, keys, limit, withLinks });
      if (tag === "person") return withLinks ? [] : PEOPLE;
      if (tag === "project") return PROJECTS;
      if (tag === "organization") return ORGS;
      return tag === "meeting" ? meetings(linked, 20) : [];
    },
  };
  const first = await runLinkHealthOnce("primary", deps);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.measures["meeting.person"], { n: 20, hit: 16, share: 0.8, level: 0.8 });
  assert.equal(first.measures["email.person"]!.level, null, "no sample, no level");
  // Bounded, lean: three capped target listings without links, then one sample listing per tag with links.
  assert.deepEqual(calls.slice(0, 3).map((c) => [c.tag, c.limit, c.withLinks]), [["person", 5000, false], ["project", 5000, false], ["organization", 5000, false]]);
  assert.ok(calls.slice(3).every((c) => c.limit === 20 && c.withLinks));
  assert.ok(calls.every((c) => c.keys.length > 0), "never the whole metadata blob");

  linked = 15; // a small dip: not low, the level follows slowly
  const second = await runLinkHealthOnce("primary", deps);
  assert.equal(second.status, "ok");
  assert.equal(second.measures["meeting.person"]!.level, 0.79);

  linked = 4; // the linker stopped
  const third = await runLinkHealthOnce("primary", deps);
  assert.equal(third.status, "failing");
  assert.deepEqual(third.low, ["meeting.person"]);
  assert.equal(third.measures["meeting.person"]!.level, 0.79, "the level is frozen while the measure is low");
  const fourth = await runLinkHealthOnce("primary", deps);
  assert.equal(fourth.status, "failing", "still failing the next day: it is compared with how things were");
  assert.equal(lastLinkHealthOutcome("primary", deps.getCursor)!.status, "failing");

  linked = 15;
  assert.equal((await runLinkHealthOnce("primary", deps)).status, "ok", "recovers when linking does");

  // An explicit floor fails a measure that never dropped.
  const floored = await runLinkHealthOnce("primary", { ...deps, floors: { "meeting.person": 0.9 } });
  assert.deepEqual(floored.low, ["meeting.person"]);

  // A vault that cannot be listed: an error, never a throw; the levels survive it.
  const broken = await runLinkHealthOnce("primary", { ...deps, list: async () => { throw new Error("GET /notes: 503"); } });
  assert.equal(broken.status, "error");
  assert.match(broken.error!, /503/);
  assert.equal(broken.measures["meeting.person"]!.level, 0.782, "0.79 moved a fifth of the way to 0.75 on the recovered run");
  // Nothing but numbers and measure names is persisted.
  assert.ok(!JSON.stringify(broken).includes("vault/people"));
  assert.ok(!JSON.stringify(first).includes("vault/people"));
});

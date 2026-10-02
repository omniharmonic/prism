/**
 * BEFORE / AFTER parity for the shared people index (worker/people.ts).
 *
 * Calendar, Gmail, Proton and Matrix ingest call `findOrCreate` on every pass,
 * so a change there is default-on. This harness runs the index as it was at
 * 6069ccd (test/fixtures/people-index-6069ccd.ts, a verbatim copy) and the
 * current one over the same synthetic corpus and asserts, for every query:
 *   - old LINKED note N  → new links N, or N's canonical person when N is a
 *     resolvable tombstone, or NOTHING when N is a non-human / unresolvable
 *     tombstone. It never creates.
 *   - old SKIPPED        → new never creates.
 * Synthetic data only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import { PeopleIndex as OldIndex } from "./fixtures/people-index-6069ccd";
import { PeopleIndex } from "../src/worker/people";
import { IdentityIndex, isNonHumanPerson, isTombstone } from "../src/identity";

let n = 0;
const person = (name: string, md: Record<string, unknown> = {}, o: { tags?: string[]; path?: string; content?: string } = {}): Note => ({
  id: `p${String(++n).padStart(3, "0")}`,
  content: o.content ?? `# ${name}`,
  path: o.path ?? `vault/people/${name}`,
  tags: ["person", ...(o.tags ?? [])],
  metadata: { name, ...md },
  createdAt: "",
  updatedAt: "u",
});

function corpus(): Note[] {
  n = 0;
  return [
    person("Ada North", { email: "ada@example.test" }),
    person("Bo South", { channels: { email: ["bo@example.test"], matrix: "@telegram_1000001:h.test" } }),
    // Multi-value string on a SECOND note must not make the first ambiguous (M7).
    person("Cy East", { email: "cy@example.test; ada@example.test" }),
    person("Dee West", { emails: ["dee@example.test", "d.west@example.test"], contact: "dee@example.test" }),
    // Non-humans that hold a real address (C1): a notetaker bot, an org mis-tagged person.
    person("Notetaker", { email: "notetaker@bots.test" }, { tags: ["bot"] }),
    person("Meeting Recorder", { email: "recorder@bots.test", type: "bot" }),
    person("Acme Org", { email: "team-inbox@acme.test" }, { tags: ["organization"] }),
    person("Helper Thing", { email: "helper@bots.test" }, { tags: ["non-human"] }),
    // Tombstones of every shape.
    person("eve-example-test", { email: "eve@example.test", merged_into: "vault/people/Eve Field", status: "merged_into_canonical" }, { tags: ["merged-stub"], path: "vault/people/eve-example-test" }),
    person("Eve Field", { email: "eve@example.test" }),
    person("fay-old", { email: "fay@example.test", merged_into: "Fay Grove" }, { tags: ["merged-stub"], path: "vault/people/fay-old" }), // by exact NAME
    person("Fay Grove", {}),
    person("gus-old", { email: "gus@example.test", merged_into: "vault/people/Nobody Here" }, { tags: ["merged-stub"], path: "vault/people/gus-old" }), // dangling
    person("hal-old", { email: "hal@example.test", status: "merged_into_canonical" }, { path: "vault/people/hal-old" }), // by status only
    person("ivy-old", { email: "ivy@example.test" }, { tags: ["superseded"], path: "vault/people/ivy-old" }), // by tag only
    person("jo-old", { email: "jo@example.test", merged_into: "" }, { tags: ["merged-stub"], path: "vault/people/jo-old" }),
    person("kit-a", { email: "kit@example.test", mergedInto: "vault/people/kit-b" }, { path: "vault/people/kit-a" }), // a cycle
    person("kit-b", { email: "kit@example.test", merged_into: "vault/people/kit-a" }, { path: "vault/people/kit-b" }),
    // Names: an alias, a slug variant, a title that is a job title, a shared name.
    person("Lou Marsh", { aliases: "Louis Marsh, L. Marsh", title: "Head of Research" }),
    person("mia-stone", {}, { path: "vault/people/mia-stone" }),
    person("Ned Pike", { email: "ned1@example.test" }),
    person("Ned Pike", { email: "ned2@example.test" }, { path: "vault/people/ned-pike" }),
    person("Oz Reed", { matrixId: "@oz:h.test", matrixRoomIds: ["!dm1:h.test"] }),
    person("Pat_Underscore", { matrix: "@pat_underscore:h.test" }),
    person("Quinn Vale", { email: "QUINN@Example.Test" }),
  ];
}

const QUERIES: Array<{ name: string; email?: string; matrixId?: string }> = [];
const NAMES = ["Ada North", "Bo South", "Cy East", "Notetaker", "Acme Org", "Eve Field", "Fay Grove", "Louis Marsh", "L. Marsh", "Head of Research", "Mia Stone", "mia-stone", "Ned Pike", "Brand New", "Zed", "12345678", "someone@new.test", "Pat_Underscore", "Quinn Vale (Telegram)"];
const EMAILS = [undefined, "ada@example.test", "cy@example.test", "bo@example.test", "dee@example.test", "d.west@example.test", "notetaker@bots.test", "recorder@bots.test", "team-inbox@acme.test", "helper@bots.test", "eve@example.test", "fay@example.test", "gus@example.test", "hal@example.test", "ivy@example.test", "jo@example.test", "kit@example.test", "ned1@example.test", "quinn@example.test", "brand@new.test", "noreply@service.test"];
const MXIDS = [undefined, "@telegram_1000001:h.test", "@oz:h.test", "!dm1:h.test", "@pat_underscore:h.test", "@telegram_9999999:h.test"];
for (const name of NAMES) for (const email of EMAILS) QUERIES.push({ name, email });
for (const name of ["Bo South", "Oz Reed", "Brand New", "Pat_Underscore"]) for (const matrixId of MXIDS) QUERIES.push({ name, matrixId });

type Outcome = { kind: "link"; id: string } | { kind: "skip" } | { kind: "create" };
async function run(Index: typeof OldIndex | typeof PeopleIndex, q: (typeof QUERIES)[number], allowCreate: boolean): Promise<Outcome> {
  const idx = new (Index as typeof PeopleIndex)(corpus());
  const vault = {
    createNote: async (p: { path?: string; metadata?: Record<string, unknown>; tags?: string[]; content: string }) => ({ id: "created", content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? [], createdAt: "", updatedAt: "", existed: false }),
  };
  const r = await idx.findOrCreate(vault, q.name, { email: q.email, matrixId: q.matrixId, allowCreate });
  return !r ? { kind: "skip" } : r.created ? { kind: "create" } : { kind: "link", id: r.id };
}

test(`parity: the new index never creates where the 6069ccd index linked or skipped (${QUERIES.length * 2} cases)`, async () => {
  const byId = new Map(corpus().map((p) => [p.id, p]));
  const identity = new IdentityIndex(corpus());
  let linkedBefore = 0, redirected = 0, blocked = 0, fixed = 0;
  for (const q of QUERIES)
    for (const allowCreate of [true, false]) {
      const before = await run(OldIndex, q, allowCreate);
      const after = await run(PeopleIndex, q, allowCreate);
      const label = `${JSON.stringify(q)} allowCreate=${allowCreate}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
      if (before.kind === "link") {
        linkedBefore++;
        const was = byId.get(before.id)!;
        assert.notEqual(after.kind, "create", `created where the old index linked — ${label}`);
        if (isNonHumanPerson(was)) {
          assert.equal(after.kind, "skip", `a non-human claimant: claimed, neither linked nor re-created — ${label}`);
          blocked++;
        } else if (isTombstone(was)) {
          const canonical = identity.canonicalOf(was);
          if (canonical) {
            assert.deepEqual(after, { kind: "link", id: canonical.id }, `a tombstone redirects to its canonical — ${label}`);
            redirected++;
          } else {
            assert.equal(after.kind, "skip", `an unresolvable tombstone: claimed, neither linked nor re-created — ${label}`);
            blocked++;
          }
        } else assert.deepEqual(after, before, `an existing verified link must not regress — ${label}`);
      } else if (before.kind === "skip") {
        assert.notEqual(after.kind, "create", `created where the old index skipped — ${label}`);
        if (after.kind === "link") fixed++;
      }
    }
  // The corpus really exercises every branch.
  assert.ok(linkedBefore > 50 && redirected > 0 && blocked > 5 && fixed > 0, JSON.stringify({ linkedBefore, redirected, blocked, fixed }));
});

test("C1: a bot-tagged person's address is never re-minted as a new human; a tombstone named by exact name redirects", async () => {
  const bot = await run(PeopleIndex, { name: "Fathom Notetaker", email: "notetaker@bots.test" }, true);
  assert.deepEqual(bot, { kind: "skip" });
  assert.deepEqual(await run(OldIndex, { name: "Fathom Notetaker", email: "notetaker@bots.test" }, true), { kind: "link", id: "p005" }, "the old index linked the bot note");
  const fay = await run(PeopleIndex, { name: "Fay G", email: "fay@example.test" }, true);
  assert.equal(fay.kind, "link");
  const dangling = await run(PeopleIndex, { name: "Gus Person", email: "gus@example.test" }, true);
  assert.deepEqual(dangling, { kind: "skip" }, "an unresolvable tombstone still owns its address");
});

test("M7: a multi-value address string on another note does not make an exact claimant ambiguous", async () => {
  assert.deepEqual(await run(PeopleIndex, { name: "Ada North", email: "ada@example.test" }, true), { kind: "link", id: "p001" });
  // …and the second address in that string is now found instead of re-created.
  const idx = new PeopleIndex(corpus());
  assert.equal(idx.find({ email: "cy@example.test" })?.id, "p003");
});

test("M7: an alias / slug-variant name match blocks creation only when the miss is REPORTED (review sink)", async () => {
  const mk = () => new PeopleIndex(corpus());
  const vault = { createNote: async (p: { path?: string }) => ({ id: "created", content: "", path: p.path ?? null, metadata: {}, tags: ["person"], createdAt: "", updatedAt: "", existed: false }) };
  // No sink (PEOPLE_QUEUE_ON_INGEST off): exactly the old behaviour — created.
  const silent = await mk().findOrCreate(vault, "Louis Marsh", { email: "louis@new.test" });
  assert.deepEqual(silent, { id: "created", created: true });
  // With a sink: not created, and the sink hears about it with the live candidate.
  const heard: Array<{ reason: string; candidates: string[] }> = [];
  const queued = await mk().findOrCreate(vault, "Louis Marsh", { email: "louis@new.test", review: (r) => heard.push({ reason: r.reason, candidates: r.candidates.map((c) => c.id) }) });
  assert.equal(queued, null);
  assert.equal(heard.length, 1);
  assert.equal(heard[0]!.candidates.length, 1);
  // An ambiguous address reaches the sink too (calendar had no queue before).
  const amb: string[] = [];
  await mk().findOrCreate(vault, "Kit", { email: "ned1@example.test", matrixId: "@oz:h.test", review: (r) => amb.push(r.reason) });
  assert.deepEqual(amb, ["ambiguous-key"]);
});

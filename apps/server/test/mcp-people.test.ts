/**
 * Graph-maintenance MCP tools (mcp/tool-people.ts): an agent holding the
 * OWNER's Prism credential works the identity review queue. Fake vault,
 * synthetic people. Pinned here:
 *
 *  - visibility: the server owner only (by email) — a vault admin, a vault-role
 *    owner, a member and a guest get none of them, and a call answers exactly
 *    like a tool that does not exist; a read-scope credential gets the reads only;
 *  - bounded, paged outputs;
 *  - decide = ONE links-only compare-and-swap write on ONE row to ONE of its
 *    candidates; name-only + add_identity refused; agent-filed and tombstone rows
 *    are owner-only; the daily cap; `busy` while another people operation runs;
 *  - recommend_merge never writes to the vault and never merges;
 *  - audit rows carry ids / hashes only (no key value, no rationale text).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, ensureUser, setMembership } from "../src/db";
import { issuePat } from "../src/auth/pat";
import { adminApi } from "../src/routes/admin";
import { enqueueCandidate, getCandidate, listCandidates } from "../src/identity-store";
import { _resetPeopleCache } from "../src/people-cache";
import { _resetPeopleLock, acquirePeopleLock } from "../src/people-lock";
import { PRISM_TOOLS } from "../src/mcp/router";
import { PEOPLE_READ_TOOL_NAMES, PEOPLE_WRITE_TOOL_NAMES } from "../src/mcp/tool-people";
import { installFakeVault, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const OWNER = config.ownerEmail;
const ADMIN = "admin@test.local";
const COOWNER = "coowner@test.local";
const MEMBER = "member@test.local";
const GUEST = "guest@test.local";
const READS = [...PEOPLE_READ_TOOL_NAMES].sort();
const ALL = [...PEOPLE_READ_TOOL_NAMES, ...PEOPLE_WRITE_TOOL_NAMES].sort();
const WHY = "Same thread history as note e0; candidate p2's address domain matches.";

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let ip: string;
/** config is readonly-typed; the caps are flipped per test and restored afterwards. */
const cfg = config as { -readonly [K in keyof typeof config]: (typeof config)[K] };
const caps = { d: config.peopleAgentDecisionsPerDay, f: config.peopleAgentFilesPerDay, r: config.peopleAgentRecommendationsPerDay };

beforeEach(() => {
  resetDb();
  _resetPeopleCache();
  _resetPeopleLock();
  fv = installFakeVault();
  app = createApp();
  ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  for (const e of [ADMIN, COOWNER, MEMBER, GUEST]) ensureUser(e);
  setMembership("primary", ADMIN, "admin", null);
  setMembership("primary", COOWNER, "owner", null);
  setMembership("primary", MEMBER, "member", null);
  fv.put({ id: "p1", path: "vault/people/Alex Example", tags: ["person"], metadata: { name: "Alex Example", email: "alex@example.test", organization: "Example Org" }, links: [{ sourceId: "p1", targetId: "proj", relationship: "member-of" }] as never });
  fv.put({ id: "p2", path: "vault/people/Blake Example", tags: ["person"], metadata: { name: "Blake Example", email: "blake@example.test" } });
  fv.put({ id: "p3", path: "vault/people/Casey Example", tags: ["person"], metadata: { name: "Casey Example" } });
  fv.put({ id: "proj", path: "vault/projects/garden", tags: ["project"], metadata: { name: "Garden" } });
  fv.put({ id: "e1", path: "vault/messages/email/one", tags: ["email"], metadata: { subject: "Seed order", from: "Sam <sam@elsewhere.test>" }, content: `<p>${"intro ".repeat(600)}</p><p>Regards, Sam Elsewhere of the garden team.</p><p>${"tail ".repeat(600)}</p>`, links: [{ sourceId: "e1", targetId: "proj", relationship: "references" }] as never });
  fv.put({ id: "e2", path: "vault/messages/email/two", tags: ["email"], metadata: { subject: "Second", from: "Sam <sam@elsewhere.test>" }, links: [] as never });
  fv.put({ id: "m1", path: "vault/meetings/2026-09-01/sync", tags: ["meeting"], metadata: { title: "Sync", attendees: ["Casey"] }, links: [] as never });
});
afterEach(() => {
  fv.restore();
  cfg.peopleAgentDecisionsPerDay = caps.d;
  cfg.peopleAgentFilesPerDay = caps.f;
  cfg.peopleAgentRecommendationsPerDay = caps.r;
});

let clock = Date.now() - 60_000;
const queue = (source: string, key: { kind: string; value: string }, extra: Partial<Parameters<typeof enqueueCandidate>[0]> = {}) =>
  enqueueCandidate({ vaultId: "primary", sourceNoteId: source, relationship: "email-from", key, candidateIds: ["p1", "p2"], reason: "ambiguous-key", origin: "backfill:emails", ...extra }, clock++);
const rowFor = (source: string) => listCandidates("primary", { limit: 200 }).candidates.find((c) => c.sourceNoteId === source)!.id;

const pat = (email: string, scope: "read" | "write" = "write") => issuePat({ email, vaultId: "primary", scope }).token;
async function connect(token: string): Promise<Client> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip, "x-forwarded-for": ip, authorization: `Bearer ${token}` };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const body = req.method === "POST" ? await req.text() : undefined;
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body });
  };
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}
type Out = { ok: true; data: any } | { ok: false; error: string; message?: string; detail?: any };
async function call(cl: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  try {
    const r: any = await cl.callTool({ name, arguments: args });
    if (r.isError) {
      const sc = r.structuredContent;
      return sc && typeof sc.error === "string" ? { ok: false, error: sc.error, message: sc.message, detail: sc.detail } : { ok: false, error: "protocol", message: JSON.stringify(r.content) };
    }
    return { ok: true, data: r.structuredContent };
  } catch (e) {
    return { ok: false, error: "protocol", message: String((e as Error).message) };
  }
}
const must = (o: Out): any => {
  assert.ok(o.ok, `expected success, got ${JSON.stringify(o)}`);
  return (o as { data: any }).data;
};
const fails = (o: Out, code: string): any => {
  assert.ok(!o.ok, `expected ${code}, got success ${JSON.stringify(o)}`);
  assert.equal((o as { error: string }).error, code, JSON.stringify(o));
  return o;
};
const peopleNames = async (cl: Client) => (await cl.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("prism_people_")).sort();
const writes = () => fv.calls.filter((c) => c.method !== "GET");
const audits = () => db.prepare("SELECT action, origin, via, status, target FROM action_audit ORDER BY id").all() as Array<{ action: string; origin: string; via: string; status: string; target: string }>;
const ledger = () => db.prepare("SELECT kind, candidate_id, person_id, rationale, outcome FROM people_agent_decisions ORDER BY id").all() as Array<{ kind: string; candidate_id: string | null; person_id: string | null; rationale: string; outcome: string }>;

test("catalog: the people tools exist with the scopes the profiles assume", () => {
  const byName = new Map(PRISM_TOOLS.map((t) => [t.name, t]));
  for (const n of PEOPLE_READ_TOOL_NAMES) assert.equal(byName.get(n)?.scope, "read", n);
  for (const n of PEOPLE_WRITE_TOOL_NAMES) assert.equal(byName.get(n)?.scope, "write", n);
  assert.deepEqual(PRISM_TOOLS.map((t) => t.name).filter((n) => n.startsWith("prism_people_")).sort(), ALL);
  assert.ok(!PRISM_TOOLS.some((t) => /merge/.test(t.name) && t.name !== "prism_people_recommend_merge"), "no tool merges");
  assert.ok(PRISM_TOOLS.filter((t) => t.name.startsWith("prism_people_")).every((t) => !t.annotations.destructiveHint));
});

test("visibility: server owner only; a read credential gets the reads; everyone else gets nothing and a call looks like an unknown tool", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" });
  assert.deepEqual(await peopleNames(await connect(pat(OWNER))), ALL);
  assert.deepEqual(await peopleNames(await connect(pat(OWNER, "read"))), READS);
  for (const who of [ADMIN, COOWNER, MEMBER, GUEST]) {
    const cl = await connect(pat(who));
    assert.deepEqual(await peopleNames(cl), [], who);
    const hidden = await call(cl, "prism_people_review_queue");
    const unknown = await call(cl, "prism_no_such_tool");
    assert.equal(hidden.ok, false);
    assert.equal((hidden as { error: string }).error, (unknown as { error: string }).error, `${who}: hidden == nonexistent`);
    assert.equal((await call(cl, "prism_people_review_decide", { id: rowFor("e1"), decision: "dismiss", rationale: WHY })).ok, false);
  }
  // A read-scope OWNER credential cannot reach a write tool.
  const ro = await connect(pat(OWNER, "read"));
  for (const [name, args] of [
    ["prism_people_review_decide", { id: rowFor("e1"), decision: "resolve", person_id: "p1", rationale: WHY }],
    ["prism_people_recommend_merge", { person_ids: ["p1", "p2"], canonical_id: "p1", rationale: WHY, confidence: 0.9 }],
    ["prism_people_file_review", { source_note_id: "m1", relationship: "attended-by", key: { kind: "name", value: "Casey" }, candidate_ids: ["p3"], rationale: WHY }],
  ] as const)
    assert.equal((await call(ro, name, args)).ok, false, name);
  assert.equal(writes().length, 0, "nothing reached the vault as a write");
  assert.equal(getCandidate("primary", rowFor("e1"))!.status, "open");
  assert.equal(ledger().length, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM people_merge_recommendations").get() as { n: number }).n, 0);
});

test("review_queue: bounded + paged, filters, candidate summaries, source titles", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" }, { display: "Sam Elsewhere" });
  queue("e2", { kind: "email", value: "sam@elsewhere.test" });
  queue("m1", { kind: "name", value: "Casey" }, { relationship: "attended-by", reason: "single-token-name", candidateIds: ["p3"], display: "Casey" });
  const cl = await connect(pat(OWNER, "read"));
  fails(await call(cl, "prism_people_review_queue", { limit: 26 }), "protocol"); // schema: at most 25
  const first = must(await call(cl, "prism_people_review_queue", { limit: 2 }));
  assert.equal(first.rows.length, 2);
  assert.ok(first.next);
  assert.deepEqual(first.open, { total: 3, byReason: { "ambiguous-key": 2, "single-token-name": 1 } });
  const row = first.rows[0];
  assert.deepEqual(
    { reason: row.reason, relationship: row.relationship, sourceKind: row.sourceKind, key: row.key, display: row.display, nameOnly: row.nameOnly, agentDecidable: row.agentDecidable },
    { reason: "ambiguous-key", relationship: "email-from", sourceKind: "email", key: { kind: "email", value: "sam@elsewhere.test" }, display: "Sam Elsewhere", nameOnly: false, agentDecidable: true },
  );
  assert.deepEqual(row.source, { id: "e1", title: "Seed order", path: "vault/messages/email/one" });
  assert.deepEqual(row.candidates.map((c: any) => [c.id, c.name, c.emailCount, c.live]), [["p1", "Alex Example", 1, true], ["p2", "Blake Example", 1, true]]);
  assert.deepEqual(row.candidates[0].organizations, ["Example Org"]);
  assert.equal(row.candidates[0].linkCount, 1);
  const rest = must(await call(cl, "prism_people_review_queue", { limit: 2, after: first.next }));
  assert.equal(rest.rows.length, 1);
  assert.equal(rest.next, null);
  assert.deepEqual(must(await call(cl, "prism_people_review_queue", { source_kind: "meeting" })).rows.map((r: any) => r.source.id), ["m1"]);
  assert.deepEqual(must(await call(cl, "prism_people_review_queue", { reason: "single-token-name" })).rows.map((r: any) => r.nameOnly), [true]);
  assert.equal(must(await call(cl, "prism_people_review_queue", { relationship: "email-to" })).rows.length, 0);
  assert.equal(writes().length, 0);
});

test("review_context: a bounded excerpt centred on the mention, and measured per-candidate signals", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" }, { display: "Sam Elsewhere" });
  // The same key was resolved to p2 once before.
  queue("e2", { kind: "email", value: "sam@elsewhere.test" });
  db.prepare("UPDATE identity_candidates SET status = 'resolved', resolved_person_id = 'p2' WHERE source_note_id = 'e2'").run();
  const cl = await connect(pat(OWNER, "read"));
  fails(await call(cl, "prism_people_review_context", { id: "nope" }), "not_found");
  const ctx = must(await call(cl, "prism_people_review_context", { id: rowFor("e1") }));
  assert.ok(ctx.source.excerpt.text.length <= 1500, "bounded");
  assert.equal(ctx.source.excerpt.truncated, true);
  assert.equal(ctx.source.excerpt.centredOnMention, true);
  assert.ok(ctx.source.excerpt.text.includes("Sam Elsewhere of the garden team"));
  assert.ok(!ctx.source.excerpt.text.includes("<p>"), "markup stripped");
  assert.equal(ctx.source.metadata.subject, "Seed order");
  assert.deepEqual(ctx.source.kinds, ["email"]);
  const [a, b] = ctx.candidates;
  assert.deepEqual({ id: a.id, prior: a.priorResolutionsOfThisKey, shared: a.sharedNeighbours, linked: a.alreadyLinked }, { id: "p1", prior: 0, shared: { count: 1, ids: ["proj"] }, linked: false });
  assert.deepEqual({ id: b.id, prior: b.priorResolutionsOfThisKey, shared: b.sharedNeighbours.count }, { id: "p2", prior: 1, shared: 0 });
  assert.deepEqual(a.emails, ["alex@example.test"]);
  assert.deepEqual(ctx.decide, { agentDecidable: true, addIdentityAllowed: true });
  assert.ok(JSON.stringify(ctx).length < 8000, "the whole answer is small");
});

test("decide/resolve: exactly ONE links-only CAS write for ONE row; ledger keeps the rationale; the audit row holds ids and hashes only", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" }, { display: "Sam Elsewhere" });
  queue("e2", { kind: "email", value: "sam@elsewhere.test" });
  const id = rowFor("e1");
  const before = fv.notes.get("e1")!.updatedAt;
  const cl = await connect(pat(OWNER));
  const out = must(await call(cl, "prism_people_review_decide", { id, decision: "resolve", person_id: "p2", rationale: WHY }));
  assert.deepEqual({ ok: out.ok, linked: out.linked, stillOpen: out.stillOpen, identityAdded: out.identityAdded, identitySkipped: out.identitySkipped, personId: out.personId }, { ok: true, linked: 1, stillOpen: false, identityAdded: false, identitySkipped: "not_requested", personId: "p2" });
  assert.equal(out.remainingToday, config.peopleAgentDecisionsPerDay - 1);
  const w = writes();
  assert.equal(w.length, 1, "one write");
  assert.equal(w[0]!.method, "PATCH");
  assert.deepEqual(w[0]!.body, { links: { add: [{ target: "p2", relationship: "email-from" }] }, if_updated_at: before });
  assert.deepEqual(fv.notes.get("e1")!.links!.filter((l) => l.relationship === "email-from"), [{ sourceId: "e1", targetId: "p2", relationship: "email-from" }]);
  assert.equal(getCandidate("primary", id)!.status, "resolved");
  assert.equal(getCandidate("primary", rowFor("e2"))!.status, "open", "the same key on another note is NOT covered (no applyToKey for agents)");
  assert.deepEqual(ledger(), [{ kind: "resolve", candidate_id: id, person_id: "p2", rationale: WHY, outcome: "ok" }]);
  const a = audits();
  assert.equal(a.length, 1);
  assert.deepEqual({ action: a[0]!.action, origin: a[0]!.origin, via: a[0]!.via, status: a[0]!.status }, { action: "admin.people-candidate-resolve", origin: "agent", via: "mcp:pat", status: "ok" });
  assert.ok(!a[0]!.target.includes("sam@elsewhere.test") && !a[0]!.target.includes("Sam") && !a[0]!.target.includes("thread history"), "no key value, name or rationale text");
  assert.ok(JSON.parse(a[0]!.target).rationaleHash && JSON.parse(a[0]!.target).agent === true);
  // Decided rows cannot be decided again.
  assert.equal(fails(await call(cl, "prism_people_review_decide", { id, decision: "dismiss", rationale: WHY }), "conflict").detail.reason, "not_open");
  // The owner reads the ledger.
  const res = await adminApi.request("/people/agent/decisions", { headers: { cookie: sessionCookie(makeSession(OWNER)) } });
  assert.equal(((await res.json()) as { decisions: Array<{ rationale: string }> }).decisions[0]!.rationale, WHY);
});

test("decide: a changed source is never forced — the row stays open; add_identity teaches a strong key only", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" });
  const id = rowFor("e1");
  const cl = await connect(pat(OWNER));
  fv.conflictOnNextWrite = true;
  const stale = must(await call(cl, "prism_people_review_decide", { id, decision: "resolve", person_id: "p1", rationale: WHY }));
  assert.deepEqual({ ok: stale.ok, stillOpen: stale.stillOpen, conflicts: stale.conflicts, linked: stale.linked }, { ok: false, stillOpen: true, conflicts: 1, linked: 0 });
  assert.equal(getCandidate("primary", id)!.status, "open");
  assert.ok(writes().every((c) => !(c.body as { force?: boolean } | undefined)?.force));
  const ok = must(await call(cl, "prism_people_review_decide", { id, decision: "resolve", person_id: "p1", add_identity: true, rationale: WHY }));
  assert.deepEqual({ linked: ok.linked, identityAdded: ok.identityAdded }, { linked: 1, identityAdded: true });
  assert.deepEqual(ledger().map((l) => l.outcome), ["open", "ok"]);
});

test("decide refusals: not a candidate, name-only + add_identity, missing rationale, agent-filed and tombstone rows; dismiss closes without a write", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" });
  queue("m1", { kind: "name", value: "Casey" }, { relationship: "attended-by", reason: "single-token-name", candidateIds: ["p3"], display: "Casey" });
  queue("e2", { kind: "email", value: "x@elsewhere.test" }, { reason: "name-only", candidateIds: ["p1"] });
  queue("p3", { kind: "name", value: "Casey Example" }, { relationship: "merged-into", reason: "tombstone-unresolved", candidateIds: ["p1"], origin: "backfill:tombstones" });
  const cl = await connect(pat(OWNER));
  const e1 = rowFor("e1"), m1 = rowFor("m1");
  fails(await call(cl, "prism_people_review_decide", { id: e1, decision: "resolve", person_id: "p3", rationale: WHY }), "invalid_request"); // p3 is not a candidate
  fails(await call(cl, "prism_people_review_decide", { id: e1, decision: "resolve", rationale: WHY }), "invalid_request"); // no person
  fails(await call(cl, "prism_people_review_decide", { id: e1, decision: "resolve", person_id: "p1" }), "protocol"); // rationale is required
  fails(await call(cl, "prism_people_review_decide", { id: e1, decision: "resolve", person_id: "p1", rationale: "ok" }), "protocol"); // …and not a token one
  fails(await call(cl, "prism_people_review_decide", { id: m1, decision: "resolve", person_id: "p3", add_identity: true, rationale: WHY }), "invalid_request"); // key kind = name
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("e2"), decision: "resolve", person_id: "p1", add_identity: true, rationale: WHY }), "invalid_request"); // reason = name-only
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("p3"), decision: "resolve", person_id: "p1", rationale: WHY }), "forbidden"); // would write merged_into
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("p3"), decision: "dismiss", rationale: WHY }), "forbidden");
  fails(await call(cl, "prism_people_review_decide", { id: "nope", decision: "dismiss", rationale: WHY }), "not_found");
  assert.equal(writes().length, 0);
  assert.equal(ledger().length, 0, "a refusal is not a decision");
  // name-only WITHOUT add_identity is allowed: it links one note and teaches nothing.
  const linked = must(await call(cl, "prism_people_review_decide", { id: m1, decision: "resolve", person_id: "p3", rationale: WHY }));
  assert.deepEqual({ linked: linked.linked, identityAdded: linked.identityAdded }, { linked: 1, identityAdded: false });
  assert.equal(writes().length, 1);
  // dismiss
  const d = must(await call(cl, "prism_people_review_decide", { id: e1, decision: "dismiss", rationale: WHY }));
  assert.equal(d.dismissed, 1);
  assert.equal(writes().length, 1, "a dismissal never writes to the vault");
  assert.equal(getCandidate("primary", e1)!.status, "dismissed");
  const a = audits().at(-1)!;
  assert.deepEqual({ action: a.action, origin: a.origin }, { action: "admin.people-candidate-dismiss", origin: "agent" });
});

test("daily cap per credential; busy while another people operation holds the lock (and busy costs no allowance)", async () => {
  cfg.peopleAgentDecisionsPerDay = 2;
  for (const s of ["e1", "e2", "m1"]) queue(s, { kind: "email", value: `${s}@elsewhere.test` }, s === "m1" ? { relationship: "attended-by" } : {});
  const token = pat(OWNER);
  const cl = await connect(token);
  const release = acquirePeopleLock("people-link-job")!;
  const busy = fails(await call(cl, "prism_people_review_decide", { id: rowFor("e1"), decision: "resolve", person_id: "p1", rationale: WHY }), "conflict");
  assert.deepEqual({ reason: busy.detail.reason, retry: busy.detail.retry }, { reason: "busy", retry: true });
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("e1"), decision: "dismiss", rationale: WHY }), "conflict");
  release();
  assert.equal(ledger().length, 0);
  must(await call(cl, "prism_people_review_decide", { id: rowFor("e1"), decision: "resolve", person_id: "p1", rationale: WHY }));
  must(await call(cl, "prism_people_review_decide", { id: rowFor("e2"), decision: "dismiss", rationale: WHY }));
  const capped = fails(await call(cl, "prism_people_review_decide", { id: rowFor("m1"), decision: "dismiss", rationale: WHY }), "rate_limited");
  assert.deepEqual({ reason: capped.detail.reason, limit: capped.detail.limit, used: capped.detail.used }, { reason: "daily_cap", limit: 2, used: 2 });
  assert.equal(getCandidate("primary", rowFor("m1"))!.status, "open");
  const st = must(await call(cl, "prism_people_link_status"));
  assert.deepEqual(st.allowance.decisions, { limit: 2, used: 2, remaining: 0 });
  // Another credential of the same owner has its own allowance.
  must(await call(await connect(pat(OWNER)), "prism_people_review_decide", { id: rowFor("m1"), decision: "dismiss", rationale: WHY }));
});

test("duplicates + recommend_merge: a recommendation is recorded for the owner and NOTHING is merged or written", async () => {
  fv.put({ id: "p4", path: "vault/people/alex-example", tags: ["person"], metadata: { name: "Alex Example", email: "alex@example.test" } });
  fv.put({ id: "own", path: "vault/people/Owner Person", tags: ["person"], metadata: { name: "Owner Person", email: OWNER } });
  const cl = await connect(pat(OWNER));
  const dup = must(await call(cl, "prism_people_duplicates", { strength: "strong" }));
  assert.equal(dup.total, 1);
  assert.deepEqual([dup.pairs[0].a.id, dup.pairs[0].b.id, dup.pairs[0].strength, dup.pairs[0].recommendation], ["p1", "p4", "strong", null]);
  assert.ok(dup.pairs[0].evidence.includes("email"));
  assert.ok(!JSON.stringify(dup).includes("alex@example.test"), "evidence is kinds, never values");
  fails(await call(cl, "prism_people_duplicates", { limit: 51 }), "protocol");

  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p1"], canonical_id: "p1", rationale: WHY, confidence: 0.9 }), "invalid_request");
  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p4"], canonical_id: "p2", rationale: WHY, confidence: 0.9 }), "invalid_request");
  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "e1"], canonical_id: "p1", rationale: WHY, confidence: 0.9 }), "not_found");
  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["own", "p2"], canonical_id: "p2", rationale: WHY, confidence: 0.9 }), "invalid_request"); // the owner can only survive
  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p4"], canonical_id: "p1", rationale: WHY, confidence: 1.5 }), "protocol");

  const snapshot = JSON.stringify([...fv.notes.values()]);
  const rec = must(await call(cl, "prism_people_recommend_merge", { person_ids: ["p4", "p1"], canonical_id: "p1", rationale: WHY, confidence: 0.9 }));
  assert.deepEqual({ ok: rec.ok, result: rec.result, merged: rec.merged, detected: rec.recommendation.detected, strength: rec.pair.strength }, { ok: true, result: "created", merged: false, detected: true, strength: "strong" });
  const again = must(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p4"], canonical_id: "p4", rationale: WHY, confidence: 0.5 }));
  assert.equal(again.result, "refreshed");
  assert.equal(again.recommendation.id, rec.recommendation.id, "one recommendation per pair");
  const undetected = must(await call(cl, "prism_people_recommend_merge", { person_ids: ["p2", "p3"], canonical_id: "p2", rationale: WHY, confidence: 0.3 }));
  assert.deepEqual({ detected: undetected.recommendation.detected, pair: undetected.pair }, { detected: false, pair: null });
  assert.equal(writes().length, 0, "no vault write at all");
  assert.equal(JSON.stringify([...fv.notes.values()]), snapshot, "no note changed: nothing was merged");
  assert.ok(![...fv.notes.values()].some((n) => (n.tags ?? []).includes("merged-stub")));

  // Shown to the owner beside the pairs (additive field) and to the agent on the pair.
  const owner = { cookie: sessionCookie(makeSession(OWNER)), "content-type": "application/json" };
  const body = (await (await adminApi.request("/people/duplicates", { headers: owner })).json()) as { pairs: unknown[]; recommendations: Array<{ id: string; canonicalId: string; rationale: string; confidence: number; personIds: string[] }> };
  assert.equal(body.recommendations.length, 2);
  assert.deepEqual({ canonicalId: body.recommendations[0]!.canonicalId, rationale: body.recommendations[0]!.rationale, confidence: body.recommendations[0]!.confidence, personIds: body.recommendations[0]!.personIds }, { canonicalId: "p4", rationale: WHY, confidence: 0.5, personIds: ["p1", "p4"] });
  assert.equal(must(await call(cl, "prism_people_duplicates")).pairs[0].recommendation.canonicalId, "p4");
  const a = audits().filter((x) => x.action === "agent.people-merge-recommend");
  assert.equal(a.length, 3);
  assert.ok(a.every((x) => x.origin === "agent" && !x.target.includes("thread history") && !x.target.includes("@")));

  // The owner dismisses one: it stays closed for the agent.
  assert.equal((await adminApi.request(`/people/recommendations/${rec.recommendation.id}/dismiss`, { method: "POST", headers: owner, body: "{}" })).status, 200);
  assert.equal((await adminApi.request(`/people/recommendations/${rec.recommendation.id}/dismiss`, { method: "POST", headers: owner, body: "{}" })).status, 404);
  const closed = must(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p4"], canonical_id: "p1", rationale: WHY, confidence: 0.9 }));
  assert.deepEqual({ ok: closed.ok, result: closed.result }, { ok: false, result: "closed" });

  // The merge itself still refuses an agent origin (the MCP layer has no route to it at all).
  cfg.peopleAgentRecommendationsPerDay = 2;
  fails(await call(cl, "prism_people_recommend_merge", { person_ids: ["p1", "p3"], canonical_id: "p1", rationale: WHY, confidence: 0.2 }), "rate_limited");
});

test("file_review: a gap goes INTO the queue for the owner; the agent that filed it can never decide it", async () => {
  const cl = await connect(pat(OWNER));
  fails(await call(cl, "prism_people_file_review", { source_note_id: "nope", relationship: "attended-by", key: { kind: "name", value: "Casey" }, rationale: WHY }), "not_found");
  fails(await call(cl, "prism_people_file_review", { source_note_id: "e1", relationship: "attended-by", key: { kind: "name", value: "Casey" }, rationale: WHY }), "invalid_request"); // an email is not a meeting
  fails(await call(cl, "prism_people_file_review", { source_note_id: "m1", relationship: "attended-by", key: { kind: "name", value: "Casey" }, candidate_ids: ["proj"], rationale: WHY }), "invalid_request"); // not a person
  fails(await call(cl, "prism_people_file_review", { source_note_id: "m1", relationship: "works-at", key: { kind: "name", value: "Casey" }, rationale: WHY }), "protocol");
  const filed = must(await call(cl, "prism_people_file_review", { source_note_id: "m1", relationship: "attended-by", key: { kind: "name", value: "Casey" }, candidate_ids: ["p3"], rationale: WHY }));
  assert.deepEqual({ ok: filed.ok, result: filed.result }, { ok: true, result: "created" });
  const unmatched = must(await call(cl, "prism_people_file_review", { source_note_id: "e1", relationship: "email-from", key: { kind: "email", value: "Sam@Elsewhere.test" }, display: "Sam Elsewhere", rationale: WHY }));
  assert.equal(unmatched.result, "created");
  assert.equal(writes().length, 0, "filing links nothing and creates no person");
  const rows = listCandidates("primary").candidates;
  assert.deepEqual(rows.map((r) => [r.sourceNoteId, r.reason, r.origin, r.candidateIds, r.key.value]), [["m1", "agent-flagged", "agent:mcp", ["p3"], "Casey"], ["e1", "agent-unmatched", "agent:mcp", [], "sam@elsewhere.test"]]);
  const q = must(await call(cl, "prism_people_review_queue"));
  assert.ok(q.rows.every((r: any) => r.agentDecidable === false));
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("m1"), decision: "resolve", person_id: "p3", rationale: WHY }), "forbidden");
  fails(await call(cl, "prism_people_review_decide", { id: rowFor("m1"), decision: "dismiss", rationale: WHY }), "forbidden");
  // …the owner can.
  const owner = { cookie: sessionCookie(makeSession(OWNER)), "content-type": "application/json" };
  assert.equal((await adminApi.request(`/people/candidates/${rowFor("m1")}/resolve`, { method: "POST", headers: owner, body: JSON.stringify({ personId: "p3" }) })).status, 200);
  assert.deepEqual(fv.notes.get("m1")!.links, [{ sourceId: "m1", targetId: "p3", relationship: "attended-by" }]);
  // Already linked now → nothing to file; and the cap.
  fails(await call(cl, "prism_people_file_review", { source_note_id: "m1", relationship: "attended-by", key: { kind: "name", value: "Casey E" }, candidate_ids: ["p3"], rationale: WHY }), "invalid_request");
  cfg.peopleAgentFilesPerDay = 2;
  fails(await call(cl, "prism_people_file_review", { source_note_id: "e2", relationship: "email-from", key: { kind: "name", value: "Sam" }, rationale: WHY }), "rate_limited");
  const a = audits().filter((x) => x.action === "agent.people-review-file");
  assert.ok(a.length === 2 && a.every((x) => !x.target.includes("elsewhere") && !x.target.includes("Casey")));
});

test("link_status: measured numbers before and after — queue depth, closed rows, agent actions, duplicates, recommendations", async () => {
  queue("e1", { kind: "email", value: "sam@elsewhere.test" });
  queue("e2", { kind: "email", value: "sam@elsewhere.test" });
  queue("m1", { kind: "name", value: "Casey" }, { relationship: "attended-by", reason: "single-token-name", candidateIds: ["p3"] });
  db.prepare("UPDATE identity_candidates SET created_at = ? WHERE source_note_id = 'e2'").run(Date.now() - 9 * 24 * 3600_000);
  const cl = await connect(pat(OWNER));
  const before = must(await call(cl, "prism_people_link_status"));
  assert.deepEqual({ total: before.queue.open.total, byReason: before.queue.open.byReason, byRelationship: before.queue.open.byRelationship, old: before.queue.open.olderThan7d, older: before.queue.open.olderThan30d }, {
    total: 3, byReason: { "ambiguous-key": 2, "single-token-name": 1 }, byRelationship: { "attended-by": 1, "email-from": 2 }, old: 1, older: 0,
  });
  assert.deepEqual([before.duplicates, before.openMergeRecommendations, before.running, before.lastJob, before.lastJobPlan], [{ strong: 0, medium: 0, weak: 0 }, 0, null, null, null]);
  assert.equal(before.allowance.decisions.limit, config.peopleAgentDecisionsPerDay);
  must(await call(cl, "prism_people_review_decide", { id: rowFor("e1"), decision: "resolve", person_id: "p1", rationale: WHY }));
  const after = must(await call(cl, "prism_people_link_status"));
  assert.equal(after.queue.open.total, 2);
  assert.deepEqual(after.queue.closedLastDay, { resolved: 1, dismissed: 0 });
  assert.deepEqual(after.agentActionsLastDay, { "resolve:ok": 1 });
  assert.equal(after.allowance.decisions.used, 1);
  // A read-scope credential can read the status too.
  assert.equal(must(await call(await connect(pat(OWNER, "read")), "prism_people_link_status")).queue.open.total, 2);
});

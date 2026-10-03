/**
 * GET /api/search (routes/search.ts, wave 2E: NP-SR-03/04) through the real
 * gateway app against the fake vault: view filtering, trash + private rules,
 * filters that only narrow, match offsets, bounds and the rate limit.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";
import { buildSnippet, findMatches, plainText, queryTerms } from "@prism/core/search";

let fv: FakeVault;
const OWNER = "owner@test.local";
const MEMBER = "member@test.local";
const login = (email: string) => sessionCookie(makeSession(email));

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  fv.put({ id: "w1", path: "Projects/Workshop principles", tags: ["project"], content: "<p>Shared context helps a <strong>workshop</strong> become decisions.</p>", metadata: { prism_creator: OWNER }, createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z" });
  fv.put({ id: "w2", path: "Library/Agenda", tags: ["note"], content: "<p>The workshop agenda for Saturday.</p>", metadata: { prism_creator: MEMBER, prism_last_writer: OWNER }, createdAt: "2026-07-01T09:00:00.000Z", updatedAt: "2026-07-02T10:00:00.000Z" });
  fv.put({ id: "w3", path: "Projects/Hidden workshop", tags: ["secret"], content: "<p>Secret workshop plans.</p>", metadata: {}, updatedAt: "2026-09-21T10:00:00.000Z" });
  fv.put({ id: "w4", path: "Projects/Private workshop", tags: ["project"], content: "<p>My private workshop notes.</p>", metadata: { prism_creator: OWNER, prism_visibility: "private" }, updatedAt: "2026-09-22T10:00:00.000Z" });
  fv.put({ id: "w5", path: "Projects/Trashed workshop", tags: ["project", "prism-trashed"], content: "<p>Old workshop.</p>", metadata: { prism_trashed_at: "2026-09-23" }, updatedAt: "2026-09-23T10:00:00.000Z" });
  fv.put({ id: "w6", path: "Tables/Workshop tracker", tags: ["project"], content: "", metadata: { prism_type: "database" }, updatedAt: "2026-09-24T10:00:00.000Z" });
});
afterEach(() => fv.restore());

function get(path: string, cookie?: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  return api.request(path, { headers: h });
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

test("owner: results carry title + snippet match offsets, trashed pages never appear", async () => {
  const r = await get("/search?q=workshop", login(OWNER));
  assert.equal(r.status, 200);
  const rows = (await r.json()) as Array<any>;
  assert.deepEqual(ids(rows), ["w1", "w2", "w3", "w4"]); // w5 trashed; w6 has no content match in the fake vault
  const w1 = rows.find((n) => n.id === "w1");
  assert.deepEqual(w1._matches.title, [[0, 8]]);
  assert.match(w1._matches.snippet, /Shared context helps a workshop become decisions\./);
  const [s, e] = w1._matches.snippetMatches[0];
  assert.equal(w1._matches.snippet.slice(s, e).toLowerCase(), "workshop");
  assert.equal(w1._caps, undefined, "the owner path is never annotated");
});

test("non-owner: only viewable notes, never someone else's private note, _caps stamped", async () => {
  grantUser(MEMBER, "tag", "project", "view");
  const rows = (await (await get("/search?q=workshop", login(MEMBER))).json()) as Array<any>;
  assert.deepEqual(ids(rows), ["w1"], "w2 (other tag), w3 (secret), w4 (owner's private) and w5 (trash) stay hidden");
  assert.deepEqual(rows[0]._caps, ["view"]);
});

test("capability links see only the granted note; anon sees nothing", async () => {
  const cap = makeCapability("note", "w2", "view");
  const rows = (await (await get("/search?q=workshop", undefined, { authorization: `Capability ${cap}` })).json()) as Array<any>;
  assert.deepEqual(ids(rows), ["w2"]);
  assert.equal(rows[0]._caps, undefined, "links are not annotated");
  const anon = (await (await get("/search?q=workshop")).json()) as Array<any>;
  assert.deepEqual(anon, []);
});

test("filters only narrow: title, type, tag, author, date range", async () => {
  const cookie = login(OWNER);
  const q = async (qs: string) => ids((await (await get(`/search?q=workshop&${qs}`, cookie)).json()) as Array<any>);
  assert.deepEqual(await q("tag=note"), ["w2"]);
  assert.deepEqual(await q("type=project&tag=project"), ["w1", "w4"]);
  assert.deepEqual(await q("type=document"), ["w2", "w3"], "type is inferContentType, not a tag");
  assert.deepEqual(await q(`author=${encodeURIComponent(MEMBER.toUpperCase())}`), ["w2"]);
  assert.deepEqual(await q(`author=${encodeURIComponent(OWNER)}`), ["w1", "w2", "w4"], "creator OR last writer");
  assert.deepEqual(await q("author=me"), ["w1", "w2", "w4"], "me = the signed-in account");
  assert.deepEqual(await q("after=2026-09-21"), ["w3", "w4"]);
  assert.deepEqual(await q("before=2026-08-01"), ["w2"]);
  assert.deepEqual(await q("date=created&after=2026-08-01&before=2026-09-01"), ["w1"]);
  fv.put({ id: "w7", path: "Notes/Daily", tags: ["note"], content: "<p>a workshop mention</p>", metadata: {}, updatedAt: "2026-09-25T10:00:00.000Z" });
  assert.deepEqual(await q("title=1"), ["w1", "w3", "w4"], "a body-only match is dropped by title-only");
  // A filter never widens what a member can read.
  grantUser(MEMBER, "tag", "project", "view");
  assert.deepEqual(ids((await (await get("/search?q=workshop&tag=secret", login(MEMBER))).json()) as Array<any>), []);
});

test("bounds: empty query, long query, limit, lean rows, invalid filters ignored", async () => {
  const cookie = login(OWNER);
  assert.deepEqual(await (await get("/search?q=", cookie)).json(), []);
  assert.equal((await get(`/search?q=${"x".repeat(201)}`, cookie)).status, 400);
  const one = (await (await get("/search?q=workshop&limit=1", cookie)).json()) as Array<any>;
  assert.equal(one.length, 1);
  const lean = (await (await get("/search?q=workshop&lean=1", cookie)).json()) as Array<any>;
  assert.ok(lean.length > 0 && lean.every((n) => !("content" in n) && n._matches));
  const bad = (await (await get("/search?q=workshop&after=not-a-date&type=%3Cscript%3E", cookie)).json()) as Array<any>;
  assert.equal(bad.length, 4, "unparseable filters are dropped, not applied");
  const calls = fv.calls.filter((c) => c.path.endsWith("/notes") && c.search.includes("search="));
  assert.ok(calls.every((c) => Number(new URLSearchParams(c.search).get("limit")) <= 200));
});

test("rate limit per actor", async () => {
  process.env.SEARCH_RATE_PER_MINUTE = "2";
  try {
    const cookie = login("rate@test.local");
    assert.equal((await get("/search?q=a", cookie)).status, 200);
    assert.equal((await get("/search?q=b", cookie)).status, 200);
    const r = await get("/search?q=c", cookie);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
  } finally {
    delete process.env.SEARCH_RATE_PER_MINUTE;
  }
});

test("pure helpers: terms, merged offsets, plain text and snippets", () => {
  assert.deepEqual(queryTerms('  "Workshop" agenda, workshop '), ["workshop", "agenda"]);
  assert.deepEqual(findMatches("Workshop: the workshops", ["workshop", "work"]), [[0, 8], [14, 22]]);
  assert.equal(plainText("<h1>Title</h1><p>A &amp; B [[Some/Page|Page]]</p>"), "Title A & B Page");
  const long = "lorem ".repeat(80) + "needle here";
  const { snippet, matches } = buildSnippet(long, ["needle"], 60);
  assert.ok(snippet.startsWith("…"));
  assert.equal(snippet.slice(matches[0][0], matches[0][1]), "needle");
});

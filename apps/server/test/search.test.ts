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
import { writerIdFor } from "../src/writer-stamp";
import { buildSnippet, findMatches, plainText, queryTerms, searchMatches } from "@prism/core/search";

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
  assert.deepEqual(await q(`author=${encodeURIComponent(OWNER)}`), ["w1", "w4"], "author = the CREATOR only");
  assert.deepEqual(await q("author=me"), ["w1", "w4"], "me = the signed-in account");
  assert.deepEqual(await q("after=2026-09-21"), ["w3", "w4"]);
  assert.deepEqual(await q("before=2026-08-01"), ["w2"]);
  assert.deepEqual(await q("date=created&after=2026-08-01&before=2026-09-01"), ["w1"]);
  fv.put({ id: "w7", path: "Notes/Daily", tags: ["note"], content: "<p>a workshop mention</p>", metadata: {}, updatedAt: "2026-09-25T10:00:00.000Z" });
  assert.deepEqual(await q("title=1"), ["w1", "w3", "w4"], "a body-only match is dropped by title-only");
  // A filter never widens what a member can read.
  grantUser(MEMBER, "tag", "project", "view");
  assert.deepEqual(ids((await (await get("/search?q=workshop&tag=secret", login(MEMBER))).json()) as Array<any>), []);
});

test("sort=edited|created orders AFTER the permission filter and BEFORE the limit; an unknown sort is ignored", async () => {
  const cookie = login(OWNER);
  const order = async (qs: string, who = cookie) => ((await (await get(`/search?q=workshop&${qs}`, who)).json()) as Array<any>).map((r) => r.id);
  assert.deepEqual(await order("sort=edited"), ["w4", "w3", "w1", "w2"], "newest edit first");
  fv.put({ id: "w8", path: "Notes/Newest workshop", tags: ["project"], content: "<p>workshop</p>", metadata: {}, createdAt: "2026-09-30T09:00:00.000Z", updatedAt: "2026-06-01T10:00:00.000Z" });
  assert.deepEqual((await order("sort=created&tag=project")).slice(0, 2), ["w8", "w1"], "newest created first");
  assert.equal((await order("sort=edited")).at(-1), "w8", "oldest edit last");
  // The limit cuts the SORTED list: the newest edit is never lost to the vault's own order.
  assert.deepEqual(await order("sort=edited&limit=1"), ["w4"]);
  // A member's order is over what they can view only — the hidden, newer w3/w4 neither appear nor take a slot.
  grantUser(MEMBER, "tag", "project", "view");
  assert.deepEqual(await order("sort=edited&limit=1", login(MEMBER)), ["w1"]);
  assert.deepEqual(await order("sort=edited", login(MEMBER)), ["w1", "w8"]);
  // Unknown value = no sort (the vault's order), never an error.
  const r = await get("/search?q=workshop&sort=__proto__", cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(ids((await r.json()) as Array<any>), ["w1", "w2", "w3", "w4", "w8"]);
});

test("editor=me matches the opaque last-writer stamp; author= is the creator; non-admins and links cannot probe others", async () => {
  // The stamp the gateway writes: an opaque id, never an address (w2's legacy email stamp matches nobody).
  fv.put({ id: "w8", path: "Library/Edited by owner", tags: ["note"], content: "<p>workshop notes edited by the owner</p>", metadata: { prism_creator: MEMBER, prism_last_writer: writerIdFor(OWNER) }, updatedAt: "2026-09-26T10:00:00.000Z" });
  fv.put({ id: "w9", path: "Library/Edited by member", tags: ["note"], content: "<p>workshop notes edited by the member</p>", metadata: { prism_creator: OWNER, prism_last_writer: writerIdFor(MEMBER) }, updatedAt: "2026-09-27T10:00:00.000Z" });
  const owner = login(OWNER);
  const q = async (qs: string, cookie: string | null = owner, headers: Record<string, string> = {}) => ids((await (await get(`/search?q=workshop&${qs}`, cookie ?? undefined, headers)).json()) as Array<any>);
  assert.deepEqual(await q("editor=me"), ["w8"]);
  assert.deepEqual(await q("author=me"), ["w1", "w4", "w9"]);
  assert.deepEqual(await q("author=me&editor=me"), [], "both filters apply");
  assert.deepEqual(await q(`editor=${encodeURIComponent(MEMBER)}`), ["w9"], "an admin may name another account");
  // A member: `me` only, and only among what they can view.
  grantUser(MEMBER, "tag", "note", "view");
  const member = login(MEMBER);
  assert.deepEqual(await q("editor=me", member), ["w9"]);
  assert.deepEqual(await q("author=me", member), ["w2", "w8"]);
  assert.deepEqual(await q(`editor=${encodeURIComponent(OWNER)}`, member), [], "no oracle for who edited a page");
  assert.deepEqual(await q(`editor=${writerIdFor(OWNER)}`, member), [], "nor by a raw stamp id");
  // A link has no "me" and may not filter by anyone.
  const cap = makeCapability("note", "w8", "view");
  assert.deepEqual(await q("editor=me", null, { authorization: `Capability ${cap}` }), []);
  assert.deepEqual(await q(`editor=${encodeURIComponent(OWNER)}`, null, { authorization: `Capability ${cap}` }), []);
  // What the route can filter by, for clients talking to servers of different ages.
  assert.deepEqual(await (await get("/search/filters", owner)).json(), { filters: ["author", "editor"], identity: true });
  assert.deepEqual(await (await get("/search/filters", undefined, { authorization: `Capability ${cap}` })).json(), { filters: ["author", "editor"], identity: false });
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
  assert.ok(calls.every((c) => Number(new URLSearchParams(c.search).get("limit")) <= 100));
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
  assert.equal(snippet.slice(matches[0]![0], matches[0]![1]), "needle");
});

// ── review H1/M1/M2 ──────────────────────────────────────────────────────────
function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

test("H1: plainText/snippets stay linear on pathological note content", () => {
  const cases: Record<string, string> = {
    "unmatched [[": "[".repeat(200_000),
    "[[ far from ]]": "[[".repeat(50_000) + "x]]",
    "pipes in [[": "[[" + "a|".repeat(60_000),
    "angle brackets": "<".repeat(200_000),
    "open tags": "<a ".repeat(60_000),
    "ampersands": "&".repeat(200_000),
    "entity-ish": "&" + "a".repeat(199_000),
    "numeric entity-ish": "&#" + "9".repeat(199_000),
    "script openers": "<script".repeat(28_000),
    "markdown runs": "#*_`>".repeat(40_000),
    "whitespace": " \n\t".repeat(66_000) + "x",
  };
  for (const [name, input] of Object.entries(cases)) {
    const [, ms] = timed(() => searchMatches({ id: "n", path: "T", content: input + " needle" }, ["needle", "[", "a"]));
    assert.ok(ms < 400, `${name}: ${Math.round(ms)} ms`);
    const [, ms2] = timed(() => plainText(input));
    assert.ok(ms2 < 400, `plainText ${name}: ${Math.round(ms2)} ms`);
  }
  const [, ms] = timed(() => findMatches("a".repeat(200_000), ["a".repeat(199) + "b", "aa"], 64));
  assert.ok(ms < 400, `findMatches: ${Math.round(ms)} ms`);
  // Behaviour is unchanged for well-formed wikilinks.
  assert.equal(plainText("See [[Projects/Plan|the plan]] and [[Notes/Daily]] [[open"), "See the plan and Notes/Daily [[open");
});

test("M1: an out-of-range numeric entity never throws (and never 500s a search)", async () => {
  assert.equal(plainText("needle &#99999999; &#55357; &#0; &#65; &#x41; &bogus; &amp;"), "needle A A &bogus; &");
  fv.put({ id: "ent", path: "Notes/Entity", tags: ["note"], content: "<p>zebra &#99999999; &#1114112;</p>", metadata: {} });
  const r = await get("/search?q=zebra", login(OWNER));
  assert.equal(r.status, 200);
  assert.deepEqual(ids((await r.json()) as Array<any>), ["ent"]);
});

test("M2: bounded vault fetch, bounded snippet work, identical in-flight queries share one vault call", async () => {
  const big = "<p>" + "filler words ".repeat(25_000) + "</p><p>quokka sighting near the end</p>";
  for (let i = 0; i < 30; i++) fv.put({ id: `big${i}`, path: `Big/${i}`, tags: ["note"], content: big, metadata: {} });
  const before = fv.calls.length;
  const t0 = performance.now();
  const [a, b] = await Promise.all([get("/search?q=quokka&limit=100", login(OWNER)), get("/search?q=quokka&limit=100", login(OWNER))]);
  const ms = performance.now() - t0;
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const rows = (await a.json()) as Array<any>;
  assert.equal(rows.length, 30);
  assert.match(rows[0]._matches.snippet, /quokka sighting/, "the window follows the match, not the first bytes");
  const calls = fv.calls.slice(before).filter((c) => c.search.includes("search="));
  assert.equal(calls.length, 1, "coalesced");
  assert.ok(Number(new URLSearchParams(calls[0]!.search).get("limit")) <= 100);
  assert.ok(ms < 1500, `two 30×325 KB searches took ${Math.round(ms)} ms`);
  // A different actor's identical query is still filtered for THAT actor.
  grantUser(MEMBER, "tag", "project", "view");
  const [o, m] = await Promise.all([get("/search?q=workshop", login(OWNER)), get("/search?q=workshop", login(MEMBER))]);
  assert.equal(((await o.json()) as any[]).length, 4);
  assert.deepEqual(ids((await m.json()) as any[]), ["w1"]);
});

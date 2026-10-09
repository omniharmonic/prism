/**
 * Editing a structured property value (`members: [{name, role}]`).
 *
 *  - the pure editing model (`@prism/core/database` structuredEdit.ts) the dialog is
 *    built on: round-trip fidelity — an edit changes exactly what was edited;
 *  - `POST /api/properties/:id/structured` through the REAL gateway app against the fake
 *    vault: the write lands in the same shape, per-field compare-and-set, validation,
 *    and the member (non-owner) permission path;
 *  - the flattening routes still refuse (`structured_value`).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  blankItem,
  buildValue,
  cellOf,
  columnsOf,
  columnType,
  isBlankItem,
  isLinkColumn,
  itemsOf,
  parseCell,
  sameTopShape,
  setItemKey,
  validateStructuredValue,
  STRUCTURED_MAX_ITEMS,
} from "@prism/core/database";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests } from "../src/routes/databases";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

/** A value with everything the dialog must not lose: nested objects and lists, a key on only one row, a non-object item, odd key order. */
const RICH = [
  { name: "Benjamin Life", role: "delegate", since: 2021, active: true, contact: { email: "b@example.org", phones: ["1", "2"] }, tags: ["core", "ops"] },
  { role: "observer", name: "Patricia Parkinson", page: "[[People/Patricia Parkinson]]", note: null },
  "a plain line",
  { name: "Third", extra: { deep: { deeper: [1, { x: true }] } } },
];
const keyOrder = (v: unknown): string => JSON.stringify(v);

// ── the pure model ───────────────────────────────────────────────────────────

test("model: columns are the union of keys in first-seen order; cells know text / number / yes-no / nothing / nested / absent", () => {
  const items = itemsOf(RICH);
  assert.deepEqual(columnsOf(items), ["name", "role", "since", "active", "contact", "tags", "page", "note", "extra"]);
  assert.deepEqual(cellOf(items[0], "name"), { kind: "text", value: "Benjamin Life" });
  assert.deepEqual(cellOf(items[0], "since"), { kind: "number", value: 2021 });
  assert.deepEqual(cellOf(items[0], "active"), { kind: "boolean", value: true });
  assert.equal(cellOf(items[0], "contact").kind, "nested");
  assert.equal(cellOf(items[0], "tags").kind, "nested");
  assert.deepEqual(cellOf(items[1], "note"), { kind: "null" });
  assert.deepEqual(cellOf(items[1], "since"), { kind: "absent" });
  assert.deepEqual(cellOf(items[2], "name"), { kind: "absent" }, "a non-object item has no cells");
  assert.equal(columnType(items, "since"), "number");
  assert.equal(columnType(items, "active"), "boolean");
  assert.equal(columnType(items, "note"), "text", "a column with no plain value yet takes text");
  assert.equal(isLinkColumn(items, "page"), true);
  assert.equal(isLinkColumn(items, "role"), false);
  assert.equal(isLinkColumn([{ person: "Ada" }], "person"), true, "a people-named column offers the page picker");
  assert.equal(isLinkColumn(items, "note"), false, "a remark is not a page link");
  assert.equal(isLinkColumn([{ owner: { name: "Ada" } }, {}], "owner"), false, "a nested value is never a link field");
  assert.equal(isLinkColumn([{ member: 3 }], "member"), false);
  // One object is one item; anything else has none.
  assert.deepEqual(itemsOf({ amount: 5 }), [{ amount: 5 }]);
  assert.deepEqual(itemsOf("x"), []);
});

test("round trip: an unedited value is rebuilt byte-for-byte, nested parts by reference", () => {
  const items = itemsOf(RICH);
  const out = buildValue(RICH, items) as unknown[];
  assert.equal(keyOrder(out), keyOrder(RICH));
  assert.equal(out[0], RICH[0], "an untouched row is the same object");
  const single = { amount: 500, currency: "USD", meta: { a: [1] } };
  assert.equal(keyOrder(buildValue(single, itemsOf(single))), keyOrder(single));
  assert.equal(Array.isArray(buildValue(single, itemsOf(single))), false, "an object stays an object");
});

test("round trip: editing one cell changes that cell only — key order, nested values, other rows and absent keys are kept", () => {
  const items = itemsOf(RICH);
  // Row 2 stores `role` BEFORE `name`: the edit keeps that order.
  const edited = setItemKey(items[1], "name", "Patricia P.");
  assert.deepEqual(Object.keys(edited), ["role", "name", "page", "note"]);
  const next = buildValue(RICH, [items[0], edited, items[2], items[3]]) as any[];
  assert.equal(keyOrder(next), keyOrder([RICH[0], { role: "observer", name: "Patricia P.", page: "[[People/Patricia Parkinson]]", note: null }, "a plain line", RICH[3]]));
  // Nested objects and lists of the edited row are the same references (not copied, not dropped).
  const row0 = setItemKey(items[0], "role", "chair");
  assert.equal(row0.contact, (RICH[0] as any).contact);
  assert.equal(row0.tags, (RICH[0] as any).tags);
  assert.deepEqual(Object.keys(row0), ["name", "role", "since", "active", "contact", "tags"]);
  // A key the row did not have is added LAST, and only on that row.
  const withSince = setItemKey(items[1], "since", 2024);
  assert.deepEqual(Object.keys(withSince), ["role", "name", "page", "note", "since"]);
  assert.equal("since" in (items[3] as object), false);
  // The original is never mutated.
  assert.equal((RICH[1] as any).name, "Patricia Parkinson");
  assert.equal((RICH[0] as any).role, "delegate");
});

test("round trip: remove and reorder rows keep every remaining item whole", () => {
  const items = itemsOf(RICH);
  const reordered = buildValue(RICH, [items[3], items[0], items[2], items[1]]) as unknown[];
  assert.equal(keyOrder(reordered), keyOrder([RICH[3], RICH[0], RICH[2], RICH[1]]));
  const removed = buildValue(RICH, [items[0], items[3]]) as unknown[];
  assert.equal(keyOrder(removed), keyOrder([RICH[0], RICH[3]]));
  assert.deepEqual(buildValue(RICH, []), [], "a list emptied stays a list");
});

test("model: a new row is shaped like the last row's plain fields; a row left empty is recognised", () => {
  const blank = blankItem([{ name: "A", role: "x", since: 3, active: true, nested: { a: 1 }, note: null }]);
  assert.deepEqual(blank, { name: "", role: "", since: null, active: false, note: null });
  assert.deepEqual(Object.keys(blank), ["name", "role", "since", "active", "note"]);
  assert.equal(isBlankItem(blank), true);
  assert.equal(isBlankItem(setItemKey(blank, "name", "Ada")), false);
  assert.equal(isBlankItem("x"), false);
  assert.deepEqual(blankItem(["just text"]), {});
});

test("model: cell input — text as typed, a number or nothing, never NaN", () => {
  assert.deepEqual(parseCell("text", "  spaced  "), { value: "  spaced  " });
  assert.deepEqual(parseCell("text", ""), { value: "" });
  assert.deepEqual(parseCell("number", "1,250.5"), { value: 1250.5 });
  assert.deepEqual(parseCell("number", " "), { value: null });
  assert.ok("error" in parseCell("number", "twelve"));
  assert.ok("error" in parseCell("number", "0x10"));
  assert.ok("error" in parseCell("number", "Infinity"));
  assert.deepEqual(parseCell("boolean", true), { value: true });
});

test("model: a prototype-named key can never be set, and never becomes a column", () => {
  const hostile = JSON.parse('[{"name": "x", "__proto__": {"polluted": true}, "constructor": "c"}]') as unknown[];
  assert.deepEqual(columnsOf(hostile), ["name"]);
  const out = setItemKey({ name: "x" }, "__proto__", "evil");
  assert.deepEqual(Object.keys(out), ["name"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // Editing the item carries its own odd keys over as DATA (own properties), touching no prototype.
  const edited = setItemKey(hostile[0], "name", "y");
  assert.equal(Object.getPrototypeOf(edited), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(edited, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("validation: JSON lists and objects within the bounds; everything else is named", () => {
  assert.equal(validateStructuredValue(RICH), null);
  assert.equal(validateStructuredValue({ amount: 5 }), null);
  assert.equal(validateStructuredValue([]), null);
  assert.match(validateStructuredValue("text")!, /list or an object/);
  assert.match(validateStructuredValue(null)!, /list or an object/);
  assert.match(validateStructuredValue([{ n: Number.NaN }])!, /finite/);
  assert.match(validateStructuredValue(JSON.parse('[{"__proto__": 1}]'))!, /field name/);
  assert.match(validateStructuredValue([{ constructor: 1 }])!, /field name/);
  assert.match(validateStructuredValue([{ "": 1 }])!, /field name/);
  assert.match(validateStructuredValue([{ t: "x".repeat(10_001) }])!, /characters/);
  assert.match(validateStructuredValue(Array.from({ length: STRUCTURED_MAX_ITEMS + 1 }, () => ({ a: 1 })))!, /at most/);
  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < 10; i++) deep = { d: deep };
  assert.match(validateStructuredValue(deep)!, /deeply/);
  assert.match(validateStructuredValue([{ big: Array.from({ length: 6000 }, (_, i) => i) }])!, /too large/);
  assert.match(validateStructuredValue([{ when: new Date(0) }])!, /plain objects/);
  assert.equal(sameTopShape([], [{}]), true);
  assert.equal(sameTopShape({}, [{}]), false);
  assert.equal(sameTopShape([], {}), false);
});

// ── POST /api/properties/:id/structured ──────────────────────────────────────

let fv: FakeVault;
let innerFetch: typeof fetch;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") {
      return Response.json([{ name: "circle", description: "Circles", fields: { members: { type: "array" }, status: { type: "string" } } }]);
    }
    return innerFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = innerFetch;
  fv.restore();
});

const OWNER = "owner@test.local";
const MEMBER = "kai@test.local";
const J = { "content-type": "application/json" };
const login = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, opts: { cookie?: string; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(opts.headers ?? J);
  if (opts.cookie !== "") headers.set("cookie", opts.cookie ?? login(OWNER));
  return api.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const edit = (id: string, body: unknown, cookie?: string) => post(`/properties/${id}/structured`, body, { cookie });
const MEMBERS = [{ name: "Benjamin Life", role: "delegate" }, { name: "Patricia Parkinson", role: "delegate" }];
function seed(extra: Record<string, unknown> = {}) {
  fv.put({ id: "c1", path: "Circles/Delegate Council", tags: ["circle"], content: "BODY", metadata: { title: "Delegate Council", members: RICH, status: "active", budget: { amount: 500, currency: "USD", history: [{ y: 2025, v: 400 }] }, ...extra }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "c2", path: "Circles/Stewards", tags: ["circle"], content: "", metadata: { title: "Stewards", members: ["[[vault/people/Ada]]"], status: "active" }, updatedAt: "2026-10-01T11:00:00.000Z" });
}
const stored = (id: string) => fv.notes.get(id)!.metadata as Record<string, unknown>;

test("structured route: an edited list lands in exactly the shape sent — key order, nested objects, a key on one row", async () => {
  seed();
  const items = itemsOf(RICH);
  const next = buildValue(RICH, [setItemKey(items[0], "role", "chair"), items[1], items[2], items[3], { name: "New Person", role: "delegate" }]);
  const r = await edit("c1", { key: "members", value: next, expect: RICH });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { id: string; updatedAt: string; metadata: Record<string, unknown> };
  assert.equal(body.id, "c1");
  assert.equal(keyOrder(stored("c1").members), keyOrder(next), "stored byte-for-byte as sent");
  assert.equal(keyOrder(body.metadata.members), keyOrder(next), "and answered whole");
  const saved = stored("c1").members as any[];
  assert.deepEqual(saved[0].contact, { email: "b@example.org", phones: ["1", "2"] });
  assert.deepEqual(saved[3].extra, { deep: { deeper: [1, { x: true }] } });
  assert.equal(saved[2], "a plain line");
  assert.deepEqual(Object.keys(saved[1]), ["role", "name", "page", "note"]);
  // Only that key was written: the body and every other property are untouched.
  assert.equal(fv.notes.get("c1")!.content, "BODY");
  assert.equal(stored("c1").status, "active");
  assert.deepEqual(stored("c1").budget, { amount: 500, currency: "USD", history: [{ y: 2025, v: 400 }] });
  const patch = fv.calls.filter((c) => c.method === "PATCH").at(-1)!;
  const sent = (typeof patch.body === "string" ? JSON.parse(patch.body) : patch.body) as { metadata: Record<string, unknown>; content?: string };
  assert.equal(sent.content, undefined, "metadata-only");
  assert.deepEqual(Object.keys(sent.metadata).filter((k) => !k.startsWith("prism_")), ["members"]);
});

test("structured route: a single object is edited as an object; a list may be emptied and stays a list", async () => {
  seed();
  const budget = stored("c1").budget;
  const next = setItemKey(budget, "amount", 750);
  const r = await edit("c1", { key: "budget", value: next, expect: budget });
  assert.equal(r.status, 200);
  assert.equal(keyOrder(stored("c1").budget), keyOrder({ amount: 750, currency: "USD", history: [{ y: 2025, v: 400 }] }));
  const empty = await edit("c1", { key: "members", value: [], expect: RICH });
  assert.equal(empty.status, 200);
  assert.deepEqual(stored("c1").members, []);
});

test("structured route: compare-and-set — a value changed elsewhere is a 409 carrying what is stored, and nothing is written", async () => {
  seed();
  // Someone (an ingester) changed the list after the editor loaded it.
  const theirs = [...RICH, { name: "Added Elsewhere", role: "guest" }];
  fv.put({ ...fv.notes.get("c1")!, metadata: { ...stored("c1"), members: theirs }, updatedAt: "2026-10-01T10:05:00.000Z" });
  const mine = [{ name: "Only Me", role: "chair" }];
  const r = await edit("c1", { key: "members", value: mine, expect: RICH });
  assert.equal(r.status, 409);
  const b = (await r.json()) as { error: string; fields: string[]; current: Record<string, unknown> };
  assert.equal(b.error, "conflict");
  assert.deepEqual(b.fields, ["members"]);
  assert.equal(keyOrder(b.current.members), keyOrder(theirs));
  assert.equal(keyOrder(stored("c1").members), keyOrder(theirs), "their change is still there");
  // Key ORDER is part of the stored shape: the same fields in another order is not what was loaded.
  const reordered = [{ role: "delegate", name: "Benjamin Life" }];
  fv.put({ id: "c3", path: "Circles/Three", tags: ["circle"], content: "", metadata: { title: "Three", members: [{ name: "Benjamin Life", role: "delegate" }] }, updatedAt: "2026-10-01T10:00:00.000Z" });
  assert.equal((await edit("c3", { key: "members", value: mine, expect: reordered })).status, 409);
  // Retrying with what IS stored now (the dialog's "Save mine anyway") lands.
  const again = await edit("c1", { key: "members", value: mine, expect: theirs });
  assert.equal(again.status, 200);
  assert.deepEqual(stored("c1").members, mine);
  // An edit to ANOTHER property in between is not a conflict (per-field, not per-note).
  seed();
  assert.equal((await post("/properties/c1", { set: { status: "paused" }, expect: { status: "active" } })).status, 200);
  assert.equal((await edit("c1", { key: "members", value: mine, expect: RICH })).status, 200);
  assert.equal(stored("c1").status, "paused");
});

test("structured route: a concurrent body write between read and write is retried once, not lost", async () => {
  seed();
  fv.conflictOnNextWrite = true;
  const r = await edit("c1", { key: "members", value: MEMBERS, expect: RICH });
  assert.equal(r.status, 200);
  assert.deepEqual(stored("c1").members, MEMBERS);
});

test("structured route: `expect` is required and must be the structured value — a plain value is never turned into objects here", async () => {
  seed();
  for (const body of [
    { key: "members", value: MEMBERS },
    { key: "members", value: MEMBERS, expect: null },
    { key: "members", value: MEMBERS, expect: ["[[vault/people/Ada]]"] },
    { key: "members", value: MEMBERS, expect: "text" },
  ]) {
    const r = await edit("c2", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(((await r.json()) as { error: string }).error, "bad_request");
  }
  // Claiming the plain list WAS objects does not help: what is stored decides (409, nothing written).
  assert.equal((await edit("c2", { key: "members", value: MEMBERS, expect: [{ name: "x" }] })).status, 409);
  assert.deepEqual(stored("c2").members, ["[[vault/people/Ada]]"]);
  // A property that is not there at all cannot be created as objects either.
  assert.equal((await edit("c2", { key: "sponsors", value: MEMBERS, expect: [{ name: "x" }] })).status, 409);
  assert.equal("sponsors" in stored("c2"), false);
});

test("structured route: what may be stored — refused values, a shape change, bad keys and bad ids", async () => {
  seed();
  const bad = async (body: unknown, error: string, id = "c1") => {
    const r = await edit(id, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(((await r.json()) as { error: string }).error, error);
  };
  await bad({ key: "members", value: "Benjamin, Patricia", expect: RICH }, "unsupported_value");
  await bad({ key: "members", value: null, expect: RICH }, "unsupported_value");
  await bad({ key: "members", value: { name: "one object" }, expect: RICH }, "shape_mismatch");
  await bad({ key: "budget", value: [{ amount: 1 }], expect: stored("c1").budget }, "shape_mismatch");
  await bad('{"key":"members","value":[{"__proto__":{"x":1}}],"expect":' + JSON.stringify(RICH) + "}", "unsupported_value");
  await bad({ key: "members", value: [{ t: "x".repeat(10_001) }], expect: RICH }, "unsupported_value");
  await bad({ key: "prism_visibility", value: MEMBERS, expect: RICH }, "bad_request");
  await bad({ key: "__proto__", value: MEMBERS, expect: RICH }, "bad_request");
  await bad({ key: "title", value: MEMBERS, expect: RICH }, "bad_request");
  await bad([], "bad_request");
  assert.equal(keyOrder(stored("c1").members), keyOrder(RICH));
  // A strict note id: a path alias the vault would resolve is not a name here; a missing note is 404.
  assert.equal((await edit("Circles%2FDelegate%20Council", { key: "members", value: MEMBERS, expect: RICH })).status, 404);
  assert.equal((await edit("nope", { key: "members", value: MEMBERS, expect: RICH })).status, 404);
  // Oversized bodies are refused before they are parsed.
  assert.equal((await edit("c1", { key: "members", value: [{ t: "y".repeat(9_000) }], expect: RICH, pad: "z".repeat(300_000) })).status, 413);
});

test("structured route: signed-in, JSON, same-origin only", async () => {
  seed();
  const body = { key: "members", value: MEMBERS, expect: RICH };
  assert.equal((await post("/properties/c1/structured", body, { cookie: "" })).status, 401);
  assert.equal((await post("/properties/c1/structured", body, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await post("/properties/c1/structured", body, { headers: { ...J, origin: "https://evil.example" } })).status, 403);
  assert.equal(keyOrder(stored("c1").members), keyOrder(RICH));
});

test("structured route, member (non-owner): edit access writes; view-only is 403; no access is 404; a locked page is 423; access keys stay hidden", async () => {
  seed({ prism_creator: "someone@test.local" });
  fv.put({ id: "p1", path: "Private/Circle", tags: ["circle"], content: "", metadata: { title: "Private", members: MEMBERS, prism_visibility: "private", prism_creator: "someone@test.local" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  const kai = login(MEMBER);
  const body = { key: "members", value: MEMBERS, expect: RICH };
  // No grant at all: the page does not exist for them (same answer as a missing note).
  assert.equal((await edit("c1", body, kai)).status, 404);
  // View only: they can read it, not edit it.
  grantUser(MEMBER, "tag", "circle", "view");
  const refused = await edit("c1", body, kai);
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, "forbidden");
  assert.equal(keyOrder(stored("c1").members), keyOrder(RICH));
  // Someone else's PRIVATE page stays invisible even with a tag grant.
  assert.equal((await edit("p1", { key: "members", value: [], expect: MEMBERS }, kai)).status, 404);
  // Edit access: the write lands, stamped as theirs, and the answer never carries the access keys.
  grantUser(MEMBER, "tag", "circle", "edit");
  const ok = await edit("c1", body, kai);
  assert.equal(ok.status, 200);
  const answer = (await ok.json()) as { metadata: Record<string, unknown> };
  assert.deepEqual(stored("c1").members, MEMBERS);
  assert.equal("prism_creator" in answer.metadata, false);
  assert.equal("prism_visibility" in answer.metadata, false);
  // A locked page is read-only for a member (the owner may still edit it).
  fv.put({ ...fv.notes.get("c1")!, metadata: { ...stored("c1"), prism_locked: true } });
  const locked = await edit("c1", { key: "members", value: [], expect: MEMBERS }, kai);
  assert.equal(locked.status, 423);
  assert.deepEqual(stored("c1").members, MEMBERS);
  assert.equal((await edit("c1", { key: "members", value: [], expect: MEMBERS })).status, 200);
  // A member's conflict answer is the same CAS as the owner's.
  fv.put({ ...fv.notes.get("c1")!, metadata: { ...stored("c1"), prism_locked: false, members: MEMBERS } });
  const stale = await edit("c1", { key: "members", value: [], expect: RICH }, kai);
  assert.equal(stale.status, 409);
  assert.deepEqual(((await stale.json()) as { current: Record<string, unknown> }).current.members, MEMBERS);
});

test("structured route: a capability link with edit access may edit; a view link may not; a trashed page is not there", async () => {
  seed();
  const editLink = makeCapability("note", "c1", "edit");
  const viewLink = makeCapability("note", "c1", "view");
  const viaLink = (token: string, body: unknown) => post("/properties/c1/structured", body, { cookie: "", headers: { ...J, authorization: `Capability ${token}` } });
  const body = { key: "members", value: MEMBERS, expect: RICH };
  const v = await viaLink(viewLink, body);
  assert.equal(v.status, 403);
  assert.equal(keyOrder(stored("c1").members), keyOrder(RICH));
  // An edit link writes like an editor — to the page it was made for only.
  const e = await viaLink(editLink, body);
  assert.equal(e.status, 200);
  assert.deepEqual(stored("c1").members, MEMBERS);
  assert.equal((await post("/properties/c2/structured", { key: "members", value: [], expect: [{ a: 1 }] }, { cookie: "", headers: { ...J, authorization: `Capability ${editLink}` } })).status, 404);
  fv.put({ ...fv.notes.get("c1")!, tags: ["circle", "prism-trashed"], metadata: { ...stored("c1"), members: RICH } });
  assert.equal((await edit("c1", body)).status, 404);
});

test("the flattening routes still refuse: text, a list of text or a clear over objects is 400 structured_value", async () => {
  seed();
  for (const next of [["Benjamin Life — delegate"], "x", null, []]) {
    const r = await post("/properties/c1", { set: { members: next }, expect: { members: RICH } });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "structured_value");
  }
  const batch = await post("/properties/batch", { items: [{ id: "c1", set: { members: ["x"] }, expect: { members: RICH } }] });
  assert.equal(batch.status, 207);
  assert.equal(((await batch.json()) as { results: Array<{ error: string }> }).results[0]!.error, "structured_value");
  // And objects are still not a value of the plain route.
  assert.equal((await post("/properties/c2", { set: { members: MEMBERS } })).status, 400);
  assert.equal(keyOrder(stored("c1").members), keyOrder(RICH));
});

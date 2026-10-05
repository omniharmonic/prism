/**
 * POST /api/notes/:id/duplicate — "Duplicate" with sub-pages (NP-PG-18).
 *
 * Driven through the real gateway app over the fake vault: who may duplicate what,
 * what a copy carries, what is skipped (and only counted), limits before any write,
 * idempotent retry, re-pointed links, a failure midway, files.
 */
import { test, beforeEach, afterEach } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { configureDuplicate, resetDuplicateForTests } from "../src/routes/duplicate";
import { configureAttachments } from "../src/routes/attachments";
import { resetAttachmentsForTests, getAttachment } from "../src/attachments";
import { addGrant, setAccount, setMembership } from "../src/db";
import { listActionAudit } from "../src/actions/store";
import { cleanCopyBody, repointWikilinks } from "../../../packages/core/src/lib/pages/copyBody";
import { TRASH_TAG, LOCK_KEY, ORDER_KEY } from "@prism/core/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault, type FakeNote } from "./helpers";
import type { Grant } from "../src/db";

const OWNER = "owner@test.local";
const BOB = "bob@test.local";
const CAROL = "carol@test.local";
const J = { "content-type": "application/json" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
let fv: FakeVault;
let seq = 0;
const rid = () => `req-dup-${String(++seq).padStart(4, "0")}`;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  resetAttachmentsForTests();
  resetDuplicateForTests();
  configureDuplicate({ perMinute: 1_000_000, pauseMs: 0 });
  configureAttachments({ uploadsPerMinute: 100_000 });
  fv = installFakeVault();
  for (const e of [BOB, CAROL]) setAccount(e, e, "hash");
  // Docs/Plan with two levels of sub-pages, links between them and one link outside.
  fv.put({ id: "out", path: "Docs/Outside", content: "<p>elsewhere</p>" });
  fv.put({
    id: "p",
    path: "Docs/Plan",
    tags: ["doc"],
    metadata: { icon: "🗺️", cover: "gradient:dawn", [LOCK_KEY]: true, [ORDER_KEY]: 5, prism_creator: CAROL, prism_last_writer: "u_abc", source_id: "ext-1", status: "open" },
    content:
      '<p>Intro <span data-type="mention" data-kind="page" data-id="c2" data-mention-uid="uidA" data-reminder="2030-01-01">x</span> and <span data-type="mention" data-kind="page" data-id="out" data-mention-uid="uidB">y</span></p>' +
      '<div data-type="child-page" data-page-id="c1"></div><div data-type="child-page" data-page-id="c2"></div><div data-type="child-page" data-page-id="out"></div>' +
      "<p>See [[Docs/Plan/Alpha/Deep|deep]] and [[Docs/Outside]] and [[Alpha]]</p>",
  });
  fv.put({ id: "c1", path: "Docs/Plan/Alpha", metadata: { [ORDER_KEY]: 2 }, content: '<p>alpha</p><div data-type="child-page" data-page-id="g1"></div>' });
  fv.put({ id: "c2", path: "Docs/Plan/Beta", metadata: { [ORDER_KEY]: 1 }, content: '<p>beta links up <span data-type="mention" data-kind="page" data-id="p" data-mention-uid="uidC">p</span></p>' });
  fv.put({ id: "g1", path: "Docs/Plan/Alpha/Deep", metadata: { [ORDER_KEY]: 7 }, content: "Markdown body with [[Docs/Plan]] inside" });
  fv.put({ id: "sib", path: "Docs/Planning", content: "<p>not a sub-page</p>" });
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
  configureAttachments(null);
});

const as = (email: string) => sessionCookie(makeSession(email));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();
function dup(id: string, who: string | null, body: Record<string, unknown> = {}, headers: Record<string, string> = J) {
  return api.request(`/notes/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
    headers: { ...headers, ...(who ? { cookie: as(who) } : {}) },
    body: JSON.stringify({ requestId: rid(), ...body }),
  });
}
const byPath = (path: string): FakeNote | undefined => [...fv.notes.values()].find((n) => n.path === path);
const pageGrant = (email: string, id: string, level: Grant["level"]) =>
  addGrant({ subject_type: "user", subject: email, resource_type: "page", resource: id, level, created_by: OWNER });
const paths = () => [...fv.notes.values()].map((n) => n.path).sort();

/** Fail the n-th note CREATE the server sends to the vault. `landed` = the vault stored it, only the answer was lost. */
function failCreate(n: number, landed = false): () => void {
  const inner = globalThis.fetch;
  let seen = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/api/notes") && ++seen === n) {
      if (landed) await inner(input, init);
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: J });
    }
    return inner(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = inner; };
}

// ── the copy ────────────────────────────────────────────────────────────────

test("a page with two levels of sub-pages is copied beside it: same relative paths, same order, nothing else", async () => {
  const before = paths();
  const r = await dup("p", OWNER);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await json(r);
  assert.equal(body.path, "Docs/Plan (copy)");
  assert.equal(body.created, 4);
  assert.deepEqual([body.skipped, body.rows, body.droppedTags, body.unlinked], [0, 0, 0, 0]);
  assert.deepEqual(paths().filter((p) => !before.includes(p)), ["Docs/Plan (copy)", "Docs/Plan (copy)/Alpha", "Docs/Plan (copy)/Alpha/Deep", "Docs/Plan (copy)/Beta"]);
  const root = byPath("Docs/Plan (copy)")!;
  assert.equal(root.id, body.id);
  // Sub-pages keep their order key; the root copy does not take the source's place.
  assert.equal(byPath("Docs/Plan (copy)/Alpha")!.metadata![ORDER_KEY], 2);
  assert.equal(byPath("Docs/Plan (copy)/Beta")!.metadata![ORDER_KEY], 1);
  assert.equal(byPath("Docs/Plan (copy)/Alpha/Deep")!.metadata![ORDER_KEY], 7);
  assert.equal(root.metadata![ORDER_KEY], undefined);
  // The source is untouched.
  assert.ok(fv.notes.get("p")!.content.includes('data-page-id="c1"'));
  assert.equal(fv.notes.get("p")!.metadata![LOCK_KEY], true);
});

test("metadata is an allowlist: properties, icon and cover travel; identity, lock, writer stamps and ingest keys do not", async () => {
  const body = await json(await dup("p", OWNER));
  const m = fv.notes.get(body.id)!.metadata!;
  assert.equal(m.icon, "🗺️");
  assert.equal(m.cover, "gradient:dawn");
  assert.equal(m.status, "open");
  assert.equal(m.title, "Plan (copy)");
  assert.equal(m[LOCK_KEY], undefined);
  assert.equal(m.source_id, undefined);
  assert.equal(m.prism_creator, OWNER, "the creator is the person duplicating");
  assert.notEqual(m.prism_last_writer, "u_abc");
  assert.match(String(m.prism_client_op), /^req-dup-\d+:[0-9a-f]{16}$/);
  assert.ok(!String(m.prism_client_op).includes("p:"), "the op id names no source id");
  assert.deepEqual(fv.notes.get(body.id)!.tags, ["doc"]);
});

test("links INSIDE the copied subtree point at the copies; links outside stay; mention uids are new", async () => {
  const body = await json(await dup("p", OWNER));
  const root = fv.notes.get(body.id)!;
  const alpha = byPath("Docs/Plan (copy)/Alpha")!;
  const beta = byPath("Docs/Plan (copy)/Beta")!;
  const deep = byPath("Docs/Plan (copy)/Alpha/Deep")!;
  // Sub-page rows: the two copied sub-pages are re-pointed; the row naming a page outside is dropped.
  assert.ok(root.content.includes(`data-page-id="${alpha.id}"`));
  assert.ok(root.content.includes(`data-page-id="${beta.id}"`));
  assert.ok(!root.content.includes('data-page-id="c1"') && !root.content.includes('data-page-id="c2"') && !root.content.includes('data-page-id="out"'));
  assert.ok(alpha.content.includes(`data-page-id="${deep.id}"`));
  // Page mentions: inside → the copy, outside → unchanged.
  assert.ok(root.content.includes(`data-id="${beta.id}"`));
  assert.ok(root.content.includes('data-id="out"'));
  assert.ok(beta.content.includes(`data-id="${root.id}"`), "a link UP to the root is re-pointed too");
  // Fresh uids, no reminder.
  for (const uid of ["uidA", "uidB", "uidC"]) assert.ok(!(root.content + beta.content).includes(uid));
  assert.ok(!root.content.includes("data-reminder"));
  // Wikilinks by full path; alias kept; a bare name and an outside path stay.
  assert.ok(root.content.includes("[[Docs/Plan (copy)/Alpha/Deep|deep]]"));
  assert.ok(root.content.includes("[[Docs/Outside]]") && root.content.includes("[[Alpha]]"));
  assert.equal(deep.content, "Markdown body with [[Docs/Plan (copy)]] inside");
});

test("withSubpages: false copies the one page; a second duplicate takes the next free name", async () => {
  const one = await json(await dup("p", OWNER, { withSubpages: false }));
  assert.deepEqual([one.created, one.path], [1, "Docs/Plan (copy)"]);
  assert.equal(byPath("Docs/Plan (copy)/Alpha"), undefined);
  assert.ok(!fv.notes.get(one.id)!.content.includes("child-page"), "rows of sub-pages the copy does not have are left out");
  const two = await json(await dup("p", OWNER));
  assert.equal(two.path, "Docs/Plan (copy) 2");
});

test("trashed sub-pages are not copied and not counted", async () => {
  fv.put({ ...fv.notes.get("c2")!, tags: [TRASH_TAG] });
  const body = await json(await dup("p", OWNER));
  assert.deepEqual([body.created, body.skipped], [3, 0]);
  assert.equal(byPath("Docs/Plan (copy)/Beta"), undefined);
});

// ── who ─────────────────────────────────────────────────────────────────────

test("only a signed-in person: anon and links 401, no JSON content type 415, bad ids and bodies refused", async () => {
  assert.equal((await dup("p", null)).status, 401);
  const link = makeCapability("note", "p", "edit");
  const viaLink = await api.request(`/notes/p/duplicate?t=${link}`, { method: "POST", headers: J, body: JSON.stringify({ requestId: rid() }) });
  assert.equal(viaLink.status, 401);
  assert.equal((await dup("p", OWNER, {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await dup("p", OWNER, {}, { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await dup("p", OWNER, { requestId: "short" })).status, 400);
  assert.equal((await dup("p", OWNER, { extra: 1 })).status, 400);
  assert.equal((await dup("p", OWNER, { withSubpages: "yes" })).status, 400);
  // A path alias the vault would resolve is not an id.
  assert.equal((await dup("Docs/Plan", OWNER)).status, 404);
  assert.equal((await dup("nope", OWNER)).status, 404);
  assert.equal(paths().some((p) => p!.includes("(copy)")), false);
});

test("the source must be viewable: unviewable = missing = trashed → 404 with nothing written", async () => {
  assert.equal((await dup("p", BOB)).status, 404);
  fv.put({ ...fv.notes.get("out")!, tags: [TRASH_TAG] });
  assert.equal((await dup("out", OWNER)).status, 404);
  assert.equal(paths().some((p) => p!.includes("(copy)")), false);
});

test("a viewer who cannot create there gets 403; with edit on the parent page the whole subtree is copied as theirs", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "view");
  const refused = await dup("p", BOB);
  assert.equal(refused.status, 403);
  assert.equal(paths().some((p) => p!.includes("(copy)")), false);
  resetDb();
  for (const e of [BOB, CAROL]) setAccount(e, e, "hash");
  pageGrant(BOB, "docs", "edit");
  const r = await dup("p", BOB);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await json(r);
  assert.equal(body.created, 4);
  for (const p of ["Docs/Plan (copy)", "Docs/Plan (copy)/Alpha", "Docs/Plan (copy)/Alpha/Deep", "Docs/Plan (copy)/Beta"]) assert.equal(byPath(p)!.metadata!.prism_creator, BOB);
});

test("sub-pages the caller cannot view are left out and NOT counted; viewable ones that cannot be copied are counted — no name, no id", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "edit");
  // Carol's private sub-page (and a system note) inside the subtree.
  fv.put({ id: "secret", path: "Docs/Plan/Salaries", metadata: { prism_visibility: "private", prism_creator: CAROL }, content: "<p>secret</p>" });
  fv.put({ id: "skill", path: "Docs/Plan/Runner", tags: ["agent-skill"], content: "do things" });
  const r = await dup("p", BOB);
  assert.equal(r.status, 200, await r.clone().text());
  const text = await r.clone().text();
  const body = await json(r);
  // Only the page Bob CAN see (the system note) is counted; the hidden one is not even a number.
  assert.deepEqual([body.created, body.skipped], [4, 1]);
  assert.ok(!text.includes("Salaries") && !text.includes("secret") && !text.includes("Runner"));
  assert.equal(byPath("Docs/Plan (copy)/Salaries"), undefined);
  assert.equal(byPath("Docs/Plan (copy)/Runner"), undefined);
});

test("a private page's copy stays private — to the person duplicating; under a shared page that needs confirmShared first", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "edit");
  fv.put({ id: "mine", path: "Docs/Plan/Diary", metadata: { prism_visibility: "private", prism_creator: BOB }, content: "<p>dear diary</p>" });
  const ask = await dup("p", BOB);
  assert.equal(ask.status, 409);
  const asked = await json(ask);
  assert.equal(asked.error, "confirm_shared");
  assert.deepEqual(asked.audience, { sharedPage: true, private: 1 });
  assert.equal(paths().some((p) => p!.includes("(copy)")), false, "nothing is written before the confirmation");
  const r = await dup("p", BOB, { confirmShared: true });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await json(r)).privateKept, 1);
  const diary = byPath("Docs/Plan (copy)/Diary")!;
  assert.equal(diary.metadata!.prism_visibility, "private");
  assert.equal(diary.metadata!.prism_creator, BOB);
});

// ── security review B1 / B2 ─────────────────────────────────────────────────

test("B1: someone else's PRIVATE page is never copied — not by an admin, not as the root, not as a sub-page, and it is not counted", async () => {
  fv.put({ id: "secret", path: "Docs/Plan/Carol notes", metadata: { prism_visibility: "private", prism_creator: CAROL }, content: "<p>carol only</p>" });
  const r = await dup("p", OWNER);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await json(r);
  assert.deepEqual([body.created, body.skipped], [4, 0]);
  assert.equal(byPath("Docs/Plan (copy)/Carol notes"), undefined);
  assert.ok(![...fv.notes.values()].some((n) => n.id !== "secret" && n.content.includes("carol only")), "her text exists once");
  // As the root: the same answer as a page that does not exist.
  const root = await dup("secret", OWNER, { confirmShared: true });
  assert.equal(root.status, 404);
  assert.deepEqual(await json(root), { error: "not_found" });
  // The admin's OWN private page is still theirs to copy.
  fv.put({ id: "own", path: "Docs/Mine", metadata: { prism_visibility: "private", prism_creator: OWNER }, content: "<p>mine</p>" });
  assert.equal((await dup("own", OWNER)).status, 200);
});

test("B2: under a shared destination, a sub-page with its OWN page sharing (a restriction) is copied PRIVATE with its sub-pages — never silently widened", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "edit"); // Bob reads everything under Docs…
  addGrant({ subject_type: "user", subject: BOB, resource_type: "page", resource: "c1", level: "view", caps: ["comment"], created_by: OWNER }); // …except Alpha, where the nearer grant gives him no view
  const ask = await dup("p", OWNER);
  assert.equal(ask.status, 409);
  const asked = await json(ask);
  assert.equal(asked.error, "confirm_shared");
  assert.deepEqual(asked.audience, { sharedPage: true, private: 2 });
  assert.equal(paths().some((x) => x!.includes("(copy)")), false);
  const body = await json(await dup("p", OWNER, { confirmShared: true }));
  assert.deepEqual([body.created, body.sharingKept, body.privateKept], [4, 2, 0]);
  for (const path of ["Docs/Plan (copy)/Alpha", "Docs/Plan (copy)/Alpha/Deep"]) {
    assert.equal(byPath(path)!.metadata!.prism_visibility, "private", path);
    assert.equal(byPath(path)!.metadata!.prism_creator, OWNER);
  }
  assert.equal(byPath("Docs/Plan (copy)")!.metadata!.prism_visibility, undefined);
  assert.equal(byPath("Docs/Plan (copy)/Beta")!.metadata!.prism_visibility, undefined);
  // What Bob actually gets: the restricted page's copy is not his to read.
  const alpha = byPath("Docs/Plan (copy)/Alpha")!;
  assert.equal((await api.request(`/notes/${alpha.id}`, { headers: { cookie: as(BOB) } })).status, 404);
  assert.equal((await api.request(`/notes/${byPath("Docs/Plan (copy)/Beta")!.id}`, { headers: { cookie: as(BOB) } })).status, 200);
  // The duplicated ROOT being a grant anchor: the whole copy is private.
  addGrant({ subject_type: "user", subject: CAROL, resource_type: "page", resource: "p", level: "view", created_by: OWNER });
  const whole = await json(await dup("p", OWNER, { confirmShared: true }));
  assert.equal(whole.sharingKept, 4);
  assert.equal(fv.notes.get(whole.id)!.metadata!.prism_visibility, "private");
});

test("review 5: integration-owned sub-pages are left out for an admin too, and matching keys never travel", async () => {
  fv.put({ id: "ada", path: "Docs/Plan/Ada", tags: ["person"], content: "<p>Ada</p>" });
  fv.put({ ...fv.notes.get("c2")!, metadata: { uid: 7, mailbox: "INBOX", emails: ["a@b.c"], channels: { email: "a@b.c" }, archiveOf: "x", transcriptNoteId: "t1", colour: "red" } });
  const body = await json(await dup("p", OWNER));
  assert.deepEqual([body.created, body.skipped], [4, 1]);
  assert.equal(byPath("Docs/Plan (copy)/Ada"), undefined);
  const m = byPath("Docs/Plan (copy)/Beta")!.metadata!;
  assert.equal(m.colour, "red");
  for (const k of ["uid", "mailbox", "emails", "channels", "archiveOf", "transcriptNoteId"]) assert.equal(m[k], undefined, k);
});

/** Slow every vault call a little, so two requests really overlap. */
function slowVault(ms: number): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { await new Promise((r) => setTimeout(r, ms)); return inner(input, init); }) as typeof fetch;
  return () => { globalThis.fetch = inner; };
}

test("review 1: one duplicate per account and a server-wide cap — the second answers 409 busy with Retry-After and writes nothing", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "edit");
  const restore = slowVault(15);
  try {
    const [a, b] = await Promise.all([dup("p", OWNER), dup("out", OWNER)]);
    assert.deepEqual([a.status, b.status], [200, 409]);
    assert.equal((await json(b)).error, "busy");
    assert.equal(b.headers.get("retry-after"), "5");
    assert.equal(byPath("Docs/Outside (copy)"), undefined);
    configureDuplicate({ perMinute: 1_000_000, pauseMs: 0, maxRunning: 1 });
    const [c1, c2] = await Promise.all([dup("p", OWNER), dup("out", BOB)]);
    assert.deepEqual([c1.status, c2.status], [200, 409]);
  } finally { restore(); }
  assert.equal((await dup("out", OWNER)).status, 200, "the slot is free again");
});

test("review 1: past the create budget the request answers 207 and the same requestId continues", async () => {
  configureDuplicate({ perMinute: 1_000_000, pauseMs: 0, passBudgetMs: -1 });
  const requestId = rid();
  const first = await dup("p", OWNER, { requestId });
  assert.equal(first.status, 207);
  const f = await json(first);
  assert.deepEqual([f.created, f.remaining, f.failed.reason], [1, 3, "time_budget"]);
  let last = first;
  for (let i = 0; i < 3; i++) last = await dup("p", OWNER, { requestId });
  assert.equal(last.status, 200, await last.clone().text());
  assert.equal((await json(last)).created, 4);
  assert.equal(paths().filter((x) => x!.startsWith("Docs/Plan (copy)")).length, 4);
});

const opOf = (requestId: string, sourceId: string) => `${requestId}:${createHash("sha256").update(`${requestId}\u0000${sourceId}`).digest("hex").slice(0, 16)}`;

test("review 4: a note carrying the op id is adopted only when it is the caller's own live note; Finish after Undo answers 409 undone", async () => {
  const requestId = rid();
  const restore = failCreate(2);
  try { assert.equal((await dup("p", OWNER, { requestId })).status, 207); } finally { restore(); }
  // Somebody else plants a note at the next copy's path, with this request's op id.
  fv.put({ id: "planted", path: "Docs/Plan (copy)/Alpha", metadata: { prism_client_op: opOf(requestId, "c1"), prism_creator: CAROL }, content: "<p>planted</p>" });
  const again = await dup("p", OWNER, { requestId });
  assert.equal(again.status, 207, await again.clone().text());
  assert.equal((await json(again)).failed.reason, "path_conflict");
  assert.equal(fv.notes.get("planted")!.content, "<p>planted</p>", "never taken over, never rewritten");
  // Undo, then Finish: the trashed copy is not adopted and not continued.
  fv.notes.delete("planted");
  const root = byPath("Docs/Plan (copy)")!;
  fv.put({ ...root, tags: [...(root.tags ?? []), TRASH_TAG] });
  const before = fv.notes.size;
  const undone = await dup("p", OWNER, { requestId });
  assert.equal(undone.status, 409);
  assert.equal((await json(undone)).error, "undone");
  assert.equal(fv.notes.size, before);
});

test("a tag the caller may not add is DROPPED from the copy and counted — never a failed duplicate, never a side-effect share", async () => {
  fv.put({ id: "docs", path: "Docs", content: "<p>folder page</p>" });
  pageGrant(BOB, "docs", "edit");
  grantUser(CAROL, "tag", "board", "view"); // "board" is somebody's shared folder
  fv.put({ ...fv.notes.get("p")!, tags: ["doc", "board"] });
  fv.put({ ...fv.notes.get("c1")!, tags: ["board", "loose"] });
  const r = await dup("p", BOB);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await json(r);
  assert.equal(body.droppedTags, 2);
  assert.deepEqual(fv.notes.get(body.id)!.tags, ["doc"]);
  assert.deepEqual(byPath("Docs/Plan (copy)/Alpha")!.tags, ["loose"]);
  // The owner keeps every tag.
  const mine = await json(await dup("p", OWNER));
  assert.deepEqual([...fv.notes.get(mine.id)!.tags!].sort(), ["board", "doc"]);
});

test("system notes and ingest-owned notes are never duplicated, by anyone", async () => {
  fv.put({ id: "sk", path: "vault/agent/skills/triage", tags: ["agent-skill"], content: "prompt" });
  fv.put({ id: "gov", path: "Gov/Role", tags: ["governance-role"], content: "role" });
  for (const id of ["sk", "gov"]) {
    const r = await dup(id, OWNER);
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, "protected");
  }
  fv.put({ id: "who", path: "People/Ada", tags: ["person"], content: "<p>Ada</p>" });
  grantUser(BOB, "note", "who", "edit");
  assert.equal((await dup("who", BOB)).status, 403);
  assert.equal((await dup("who", OWNER)).status, 403, "for every role: a second person/mail/meeting note pollutes identity matching");
  assert.equal(paths().some((x) => x!.includes("(copy)")), false);
});

test("a database page is copied with its config but without its rows; a row duplicates as a row", async () => {
  fv.put({ id: "db", path: "Docs/Tracker", metadata: { prism_type: "database", prism_database: { version: 1, source: { tags: ["trk"] }, views: [{ id: "v1", name: "All", type: "table" }] } }, content: " " });
  fv.put({ id: "r1", path: "Docs/Tracker/Row one", tags: ["trk"], metadata: { status: "open" }, content: "<p>row</p>" });
  fv.put({ id: "tpl", path: "Docs/Tracker/Templates/Bug", metadata: { prism_template_props: { status: "open", prism_creator: "x@y.z" } }, content: "<p>template</p>" });
  const body = await json(await dup("db", OWNER));
  assert.deepEqual([body.created, body.rows, body.skipped], [2, 1, 0]);
  const copy = fv.notes.get(body.id)!;
  assert.deepEqual((copy.metadata!.prism_database as { source: { tags: string[] } }).source.tags, ["trk"]);
  assert.equal(byPath("Docs/Tracker (copy)/Row one"), undefined);
  assert.deepEqual(byPath("Docs/Tracker (copy)/Templates/Bug")!.metadata!.prism_template_props, { status: "open" });
  const row = await json(await dup("r1", OWNER));
  assert.equal(row.path, "Docs/Tracker/Row one (copy)");
  assert.deepEqual(fv.notes.get(row.id)!.tags, ["trk"]);
  assert.equal(fv.notes.get(row.id)!.metadata!.status, "open");
});

test("a member duplicates their own page template: still private to them, still only tagged template", async () => {
  fv.put({ id: "tpl", path: "Templates/Brief", tags: ["template"], metadata: { prism_visibility: "private", prism_creator: BOB, prism_template_tags: ["loose", "board"] }, content: "<h2>Problem</h2>" });
  grantUser(CAROL, "tag", "board", "view");
  // A guest (no workspace role) has no standing in Templates/.
  assert.equal((await dup("tpl", BOB)).status, 403);
  setMembership("primary", BOB, "member", OWNER);
  const r = await dup("tpl", BOB);
  assert.equal(r.status, 200, await r.clone().text());
  const copy = fv.notes.get((await json(r)).id)!;
  assert.equal(copy.path, "Templates/Brief (copy)");
  assert.deepEqual(copy.tags, ["template"]);
  assert.equal(copy.metadata!.prism_visibility, "private");
  assert.equal(copy.metadata!.prism_creator, BOB);
  assert.deepEqual(copy.metadata!.prism_template_tags, ["loose"], "a remembered tag the member could not add is not carried");
});

// ── limits ──────────────────────────────────────────────────────────────────

test("too many pages or too many bytes → 413 with the counts, before anything is written", async () => {
  const before = paths();
  configureDuplicate({ perMinute: 1_000_000, maxNotes: 3 });
  const many = await dup("p", OWNER);
  assert.equal(many.status, 413);
  const m = await json(many);
  assert.deepEqual([m.error, m.notes, m.limit], ["too_large", 4, 3]);
  configureDuplicate({ perMinute: 1_000_000, maxBytes: 40 });
  const big = await dup("p", OWNER);
  assert.equal(big.status, 413);
  const b = await json(big);
  assert.equal(b.error, "too_large");
  assert.ok(b.bytes > 40 && b.limit === 40);
  assert.deepEqual(paths(), before);
  assert.equal(fv.calls.filter((c) => c.method === "POST").length, 0);
});

test("rate limited per account", async () => {
  configureDuplicate({ perMinute: 1 });
  const who = "ratelimited@test.local";
  setAccount(who, who, "hash");
  assert.equal((await dup("p", who)).status, 404);
  const second = await dup("p", who);
  assert.equal(second.status, 429);
  assert.ok(second.headers.get("retry-after"));
});

// ── retry ───────────────────────────────────────────────────────────────────

test("the same requestId again adopts what exists: no second copy; another source on that id is refused", async () => {
  const requestId = rid();
  const first = await json(await dup("p", OWNER, { requestId }));
  const count = fv.notes.size;
  const again = await dup("p", OWNER, { requestId });
  assert.equal(again.status, 200);
  const second = await json(again);
  assert.deepEqual([second.id, second.path, second.created], [first.id, first.path, 4]);
  assert.equal(fv.notes.size, count);
  assert.equal((await dup("c1", OWNER, { requestId })).status, 422);
  assert.equal((await dup("p", OWNER, { requestId, withSubpages: false })).status, 422);
});

test("a failure midway answers 207 with what was created; retrying the requestId finishes without a duplicate; links end up right", async () => {
  const requestId = rid();
  const restore = failCreate(3);
  let partial: Response;
  try { partial = await dup("p", OWNER, { requestId }); } finally { restore(); }
  assert.equal(partial.status, 207);
  const p = await json(partial);
  assert.equal(p.error, "partial_duplicate");
  assert.deepEqual([p.created, p.remaining, p.path], [2, 2, "Docs/Plan (copy)"]);
  assert.equal(byPath("Docs/Plan (copy)")!.id, p.id);
  const done = await dup("p", OWNER, { requestId });
  assert.equal(done.status, 200, await done.clone().text());
  const d = await json(done);
  assert.deepEqual([d.id, d.created], [p.id, 4]);
  assert.equal(paths().filter((x) => x!.startsWith("Docs/Plan (copy)")).length, 4);
  const root = fv.notes.get(d.id)!;
  assert.ok(root.content.includes(`data-page-id="${byPath("Docs/Plan (copy)/Alpha")!.id}"`));
  assert.ok(root.content.includes(`data-page-id="${byPath("Docs/Plan (copy)/Beta")!.id}"`));
});

test("a create whose answer was lost is adopted by its op id, not created twice", async () => {
  const restore = failCreate(2, true);
  let r: Response;
  try { r = await dup("p", OWNER); } finally { restore(); }
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await json(r)).created, 4);
  assert.equal(paths().filter((x) => x!.startsWith("Docs/Plan (copy)")).length, 4);
});

test("the root failing leaves nothing behind and no journal: the next try works", async () => {
  const requestId = rid();
  const restore = failCreate(1);
  let r: Response;
  try { r = await dup("p", OWNER, { requestId }); } finally { restore(); }
  assert.equal(r.status, 502);
  assert.equal(paths().some((p) => p!.includes("(copy)")), false);
  assert.equal((await dup("p", OWNER, { requestId })).status, 200);
});

// ── files, audit ────────────────────────────────────────────────────────────

test("every copy gets its OWN files (the shared attachment-copy logic); nothing is left pending", async () => {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(PNG)]), "pic.png");
  const up = await api.request("/notes/c1/attachments", { method: "POST", headers: { cookie: as(OWNER), "x-prism-upload": "1" }, body: f });
  assert.equal(up.status, 201, await up.clone().text());
  const att = (await json(up)).id as string;
  fv.put({ ...fv.notes.get("c1")!, content: `<p>alpha</p><img src="/api/attachments/${att}">` });
  const body = await json(await dup("p", OWNER));
  assert.deepEqual(body.files, { copied: 1, failed: 0 });
  assert.deepEqual(body.filesPending, []);
  const alpha = byPath("Docs/Plan (copy)/Alpha")!;
  const [fresh] = [...alpha.content.matchAll(/\/api\/attachments\/(a_[A-Za-z0-9_-]{22})/g)].map((m) => m[1]!);
  assert.ok(fresh && fresh !== att);
  assert.equal(getAttachment(fresh!)!.note_id, alpha.id);
  assert.ok(fv.notes.get("c1")!.content.includes(att), "the original keeps its own file");
  // No budget → the page is reported for the client to finish with the copy route.
  configureDuplicate({ perMinute: 1_000_000, filesBudgetMs: -1 });
  const later = await json(await dup("p", OWNER));
  assert.deepEqual(later.filesPending, [byPath("Docs/Plan (copy) 2/Alpha")!.id]);
});

test("one audit row per duplicate, counts only", async () => {
  await dup("p", OWNER);
  const rows = listActionAudit({ action: ["pages.duplicate"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "ok");
  const text = JSON.stringify(rows[0]);
  assert.ok(text.includes('"pages":4'));
  assert.ok(!text.includes("Docs/") && !text.includes("alpha"), "no path, no content");
});

// ── the pure half ───────────────────────────────────────────────────────────

test("cleanCopyBody: sub-page rows and page mentions are re-pointed only where a copy exists; without a map rows are dropped as before", () => {
  const html = '<p>a</p><div data-type="child-page" data-page-id="x1"></div><div data-type="child-page" data-page-id="x2"></div><p><span data-type="mention" data-kind="page" data-id="x1" data-mention-uid="u1">t</span><span data-type="mention" data-kind="person" data-id="x1" data-mention-uid="u2">n</span></p>';
  const out = cleanCopyBody(html, () => "new", { pageId: (id) => (id === "x1" ? "y1" : null) });
  assert.equal(out, '<p>a</p><div data-type="child-page" data-page-id="y1"></div><p><span data-type="mention" data-kind="page" data-id="y1" data-mention-uid="new">t</span><span data-type="mention" data-kind="person" data-id="x1" data-mention-uid="new">n</span></p>');
  assert.equal(cleanCopyBody(html, () => "new"), '<p>a</p><p><span data-type="mention" data-kind="page" data-id="x1" data-mention-uid="new">t</span><span data-type="mention" data-kind="person" data-id="x1" data-mention-uid="new">n</span></p>');
  // A copy id that is not attribute-safe is never written.
  assert.ok(!cleanCopyBody(html, () => "new", { pageId: () => 'x" onload="y' }).includes("onload"));
});

test("repointWikilinks: full paths only, alias and anchor kept, linear on unmatched brackets", () => {
  const map = (t: string) => (t.toLowerCase() === "a/b" ? "a/b (copy)" : null);
  assert.equal(repointWikilinks("x [[a/b]] [[A/B.md|al]] [[a/b#h]] [[b]] [[a/bc]] [[a/b", map), "x [[a/b (copy)]] [[a/b (copy)|al]] [[a/b (copy)#h]] [[b]] [[a/bc]] [[a/b");
  assert.equal(repointWikilinks("no links", map), "no links");
  const hostile = "[[".repeat(200_000);
  const t0 = Date.now();
  assert.equal(repointWikilinks(hostile, map), hostile);
  const tags = "<span ".repeat(100_000);
  cleanCopyBody(`<p>${tags}`, () => "u", { pageId: () => "z" });
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

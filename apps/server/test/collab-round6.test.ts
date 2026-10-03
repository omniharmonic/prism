/**
 * Fifth independent review of the conversion change (round 6) — the collab half.
 * (The conversion service's half: conversion-round6.test.ts.) Each test was run
 * against the code WITHOUT its fix first and failed there.
 *
 *  B3  `mergeIsSane` accepted a merge against a base that was too NEW: with an
 *      unconfirmed write recorded and the note's history unable to say whether it
 *      landed, typed text was deleted silently whenever each of its WORDS stood
 *      somewhere in the vault's copy.
 *  S2  A write the vault definitely refused (a 409) stayed recorded as an
 *      "attempt": ordinary concurrent editing then met the uncertain-merge rule.
 *  S3  A page's content was set aside AFTER the vault's copy replaced it, and a
 *      failed insert was swallowed.
 *  S4  Set-aside rows were pruned only on insert, outlived their note, and a read
 *      of one left no audit row.
 *  S6  Three slow notes left whoever OPENED them `busy`.
 */
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { createApp } from "../src/app";
import * as dbm from "../src/db";
import { addGrant, db, ensureUser, getDocState } from "../src/db";
import * as collab from "../src/collab";
import { hocuspocus, loadDocumentState, mergeIsSane, reconcileLoadedDocs, resetConversionState, resetReconcileState, storeDocumentState, sweepUnsavedDocuments, yDocToHtml } from "../src/collab";
import * as service from "../src/convert/service";
import { ConversionError, configureConversion, forgetConversionFailures, stopConversionWorkers } from "../src/convert/service";
import { vaultClient } from "../src/parachute";
import { installFakeVault, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const OWNER = "owner@test.local";
const EDITOR = "editor@test.local";
const T0 = "2026-02-01T00:00:00.000Z";
/** Later than anything the fake vault stamps on a write (June 2026). */
const LATER = (n: number) => `2026-12-0${n}T00:00:00.000Z`;
const J = { "content-type": "application/json" };

let fv: FakeVault;
let app: ReturnType<typeof createApp>;
let restore: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  resetDb();
  resetReconcileState();
  resetConversionState();
  forgetConversionFailures();
  fv = installFakeVault();
  app = createApp();
  for (const e of [OWNER, EDITOR]) ensureUser(e);
  addGrant({ subject_type: "user", subject: EDITOR, resource_type: "tag", resource: "garden", level: "view", caps: ["view", "comment", "suggest", "edit", "create"] as never, created_by: "test", vault_id: "primary" });
});
afterEach(async () => {
  for (const r of restore.splice(0).reverse()) await r();
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  resetConversionState();
  fv.restore();
});
after(async () => {
  await stopConversionWorkers();
});

// ── plumbing ────────────────────────────────────────────────────────────────

function type(doc: Y.Doc, words: string): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(words)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}
const vaultContent = (id: string) => fv.notes.get(id)!.content;
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/** Somebody else writes the note directly (no request through `fetch`: usable inside an intercepted write). */
function vaultWrite(id: string, at: string, content: string): void {
  fv.put({ ...fv.notes.get(id)!, content, updatedAt: at });
}
/** Someone else writes the body through the vault (so the vault records what it replaced, like the real one). */
async function externalEdit(id: string, change: (content: string) => string): Promise<void> {
  const n = fv.notes.get(id)!;
  await vaultClient("primary").updateNote(id, { content: change(n.content), ifUpdatedAt: n.updatedAt! });
}
/** Run `during` while vault requests matching `match` are intercepted by `on` (which may pass them through). */
async function intercept<T>(match: (method: string, path: string, body: string) => boolean, on: (pass: () => Promise<Response>) => Promise<Response>, during: () => Promise<T>): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (match(method, url.pathname, typeof init?.body === "string" ? init.body : "")) return on(() => inner(input, init));
    return inner(input, init);
  }) as typeof fetch;
  try {
    return await during();
  } finally {
    globalThis.fetch = inner;
  }
}
const isPatch = (id: string) => (method: string, path: string) => method === "PATCH" && path.endsWith(`/notes/${id}`);
const fail = (status: number) => async () => new Response(JSON.stringify({ error: "boom" }), { status, headers: J });
const ownerHeaders = () => ({ cookie: sessionCookie(makeSession(OWNER)), ...J, "x-prism-editor-schema": String(COLLAB_SCHEMA_VERSION), "sec-fetch-site": "same-origin" });
type SetAsideRow = { id: number; noteId: string; reason: string; kind: string; bytes: number };
async function setAsideList(): Promise<SetAsideRow[]> {
  const body = (await (await app.request("/api/admin/collab/unsaved", { headers: ownerHeaders() })).json()) as { setAside?: SetAsideRow[] };
  return body.setAside ?? [];
}
type Unsaved = { reason: string | null; permanent: number; attempts: number } | null;
const unsavedRow = (id: string): Unsaved => (dbm as unknown as { getCollabUnsaved?: (n: string, v: string) => Unsaved }).getCollabUnsaved?.(id, "primary") ?? null;
const counts = (words: Record<string, number>) => new Map(Object.entries(words));

// ── B3 ──────────────────────────────────────────────────────────────────────

test("B3: the merge check — a base that is too NEW (typed text deleted) fails even when every typed word stands elsewhere in the vault's copy; two sides adding the same common word pass", () => {
  // Page: "alpha beta the end". Typed here, never landed: a paragraph "the end". Written elsewhere: "the gamma".
  const floor = counts({ alpha: 1, beta: 1, the: 1, end: 1 });
  const local = counts({ alpha: 1, beta: 1, the: 2, end: 2 });
  const vault = counts({ alpha: 1, beta: 1, the: 2, end: 1, gamma: 1 });
  // Merged against the unconfirmed write's state (= local): the typed paragraph is gone, the result IS the vault's copy.
  assert.equal(mergeIsSane(local, floor, local, vault, vault), false, "typing that never reached the vault was deleted");
  // Merged against the floor: both paragraphs are there — three "the", which is base + one from each side.
  const both = counts({ alpha: 1, beta: 1, the: 3, end: 2, gamma: 1 });
  assert.equal(mergeIsSane(floor, floor, local, vault, both), true, "both sides added a common word: not a doubled run");
  // Still refused: more of a word than the base and both sides' additions account for…
  assert.equal(mergeIsSane(floor, floor, local, vault, counts({ alpha: 1, beta: 1, the: 4, end: 3, gamma: 1 })), false);
  // …what was written elsewhere dropped…
  assert.equal(mergeIsSane(floor, floor, local, vault, local), false, "the vault's addition is gone");
  // …and a word only the document has, beyond the floor, dropped.
  assert.equal(mergeIsSane(floor, floor, counts({ alpha: 1, beta: 1, the: 1, end: 1, typed: 1 }), vault, vault), false);
  // A deliberate deletion on the vault's side of something the floor had is fine.
  assert.equal(mergeIsSane(floor, floor, local, counts({ alpha: 1, the: 1, end: 1 }), counts({ alpha: 1, the: 2, end: 2 })), true);
});

for (const where of ["reconciler", "load", "store"] as const) {
  test(`B3: an unconfirmed write that did NOT land, an external edit, no history — the ${where} keeps the typed paragraph though all its words stand elsewhere on the page (nothing deleted, nothing set aside)`, { timeout: 60_000 }, async () => {
    fv.historySupported = false;
    const id = `b3${where[0]}`;
    fv.put({ id, tags: ["garden"], content: "<p>alpha beta the end</p>", updatedAt: T0 });
    const doc = await loadDocumentState(id, new Y.Doc());
    type(doc, "the end");
    await intercept(isPatch(id), fail(500), () => storeDocumentState(id, doc)); // sent, outcome unknown — and it did not land
    assert.equal(vaultContent(id), "<p>alpha beta the end</p>");
    assert.equal(getDocState(id)!.attempts.length, 1, "the write is recorded as unconfirmed");
    await externalEdit(id, (c) => c + "<p>the gamma</p>");
    let merged = doc;
    if (where === "reconciler") await reconcileLoadedDocs({ documents: new Map([[id, doc]]) });
    else if (where === "load") {
      resetReconcileState(); // a restart: nothing in memory
      merged = await loadDocumentState(id, new Y.Doc());
    } else await storeDocumentState(id, doc); // the store's own guard meets the external edit
    const html = yDocToHtml(merged);
    assert.deepEqual([count(html, "<p>alpha beta the end</p>"), count(html, "<p>the end</p>"), count(html, "<p>the gamma</p>")], [1, 1, 1], html);
    await storeDocumentState(id, merged);
    assert.equal(count(vaultContent(id), "<p>the end</p>"), 1, vaultContent(id));
    assert.equal(count(vaultContent(id), "<p>the gamma</p>"), 1, vaultContent(id));
    assert.deepEqual(await setAsideList(), [], "merged: nothing had to be set aside");
  });
}

test("B3: an unconfirmed write whose additions are NOT in the vault's copy is never the merge base — typed text the vault never saw survives an external rewrite", { timeout: 60_000 }, async () => {
  fv.historySupported = false;
  fv.put({ id: "b3x", tags: ["garden"], content: "<p>one two three</p>", updatedAt: T0 });
  const doc = await loadDocumentState("b3x", new Y.Doc());
  type(doc, "two three one"); // every word of it is already on the page
  await intercept(isPatch("b3x"), fail(503), () => storeDocumentState("b3x", doc));
  await externalEdit("b3x", () => "<p>one two three</p><p>three two one</p>"); // …and in what was written elsewhere
  await reconcileLoadedDocs({ documents: new Map([["b3x", doc]]) });
  const html = yDocToHtml(doc);
  assert.equal(count(html, "<p>two three one</p>"), 1, `the typed paragraph is still on the page: ${html}`);
  assert.equal(count(html, "<p>three two one</p>"), 1, html);
});

// ── S2 ──────────────────────────────────────────────────────────────────────

test("S2: a write the vault REFUSED (409) is no longer an 'attempt' — concurrent editing merges with a certain base, both sides' common words included", { timeout: 60_000 }, async () => {
  fv.historySupported = false; // nobody could say "it did not land" — the refusal itself says so
  fv.put({ id: "s2", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("s2", new Y.Doc());
  type(doc, "the cat");
  let raced = false;
  await intercept(isPatch("s2"), async (pass) => {
    // Someone else's write lands between this store's read and its write: the vault answers 409.
    if (!raced) {
      raced = true;
      vaultWrite("s2", LATER(1), "<p>start</p><p>the dog</p>");
    }
    return pass();
  }, () => storeDocumentState("s2", doc));
  const html = yDocToHtml(doc);
  assert.deepEqual([count(html, "<p>the cat</p>"), count(html, "<p>the dog</p>"), count(html, "<p>start</p>")], [1, 1, 1], html);
  assert.equal(count(vaultContent("s2"), "<p>the cat</p>"), 1, vaultContent("s2"));
  assert.equal(count(vaultContent("s2"), "<p>the dog</p>"), 1, vaultContent("s2"));
  assert.deepEqual(getDocState("s2")!.attempts, [], "nothing is left recorded as possibly-ours");
  assert.equal(getDocState("s2")!.ahead, false);
  assert.equal(unsavedRow("s2"), null);
  assert.deepEqual(await setAsideList(), []);
});

test("S2: the refused attempt is dropped from the row at once — a later external edit is not an uncertain merge", { timeout: 60_000 }, async () => {
  fv.put({ id: "s2b", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("s2b", new Y.Doc());
  type(doc, "typed");
  for (const status of [409, 403, 422]) {
    await intercept(isPatch("s2b"), fail(status), () => storeDocumentState("s2b", doc));
    assert.deepEqual(getDocState("s2b")!.attempts, [], `a ${status} is a definite refusal: no attempt is kept`);
    assert.equal(getDocState("s2b")!.ahead, true, "the typing is still in the server's document store");
  }
  for (const status of [500, 503, 504, 408]) {
    await intercept(isPatch("s2b"), fail(status), () => storeDocumentState("s2b", doc));
    assert.equal(getDocState("s2b")!.attempts.length, 1, `a ${status} leaves the outcome unknown: the attempt is kept`);
  }
});

test("S2: a 409 does NOT drop a hash an earlier, unanswered send of the same content may have landed under — its late landing is recognised as ours, nothing is doubled", { timeout: 60_000 }, async () => {
  fv.put({ id: "s2c", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("s2c", new Y.Doc());
  type(doc, "typed once");
  let sent = "";
  const capture = (method: string, path: string, body: string) => {
    if (!isPatch("s2c")(method, path)) return false;
    sent = (JSON.parse(body) as { content: string }).content;
    return true;
  };
  // First send: no answer (and, so far, not applied).
  await intercept(capture, fail(504), () => storeDocumentState("s2c", doc));
  assert.equal(getDocState("s2c")!.attempts.length, 1);
  // Second send of the same content: the FIRST one lands just before it — the vault answers 409.
  let landed = false;
  await intercept(capture, async (pass) => {
    if (!landed) {
      landed = true;
      vaultWrite("s2c", LATER(1), sent);
    }
    return pass();
  }, () => storeDocumentState("s2c", doc));
  assert.equal(yDocToHtml(doc), "<p>start</p><p>typed once</p>", "our own write was not folded back in as somebody else's");
  assert.equal(vaultContent("s2c"), "<p>start</p><p>typed once</p>");
  assert.equal(getDocState("s2c")!.ahead, false);
  assert.equal(unsavedRow("s2c"), null);
});

// ── S3 ──────────────────────────────────────────────────────────────────────

test("S3: what a page holds is set aside BEFORE the vault's copy replaces it — if it cannot be kept, nothing is replaced (reconciler, store and load), and it is once it can", { timeout: 60_000 }, async () => {
  fv.historySupported = false;
  fv.put({ id: "s3", tags: ["garden"], content: "<p>alpha</p>", updatedAt: T0 });
  const doc = await loadDocumentState("s3", new Y.Doc());
  doc.transact(() => {
    type(doc, "shared block");
    type(doc, "only local");
  });
  await intercept(isPatch("s3"), fail(500), () => storeDocumentState("s3", doc));
  vaultWrite("s3", LATER(1), "<p>alpha</p><p>shared block</p>"); // no base merges sanely: the vault's copy must replace the page's
  // The set-aside table cannot be written (a full disk, a locked database).
  db.exec("CREATE TRIGGER r6_no_aside BEFORE INSERT ON collab_set_aside BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  restore.push(() => void db.exec("DROP TRIGGER IF EXISTS r6_no_aside"));
  const mine = "<p>alpha</p><p>shared block</p><p>only local</p>";
  await reconcileLoadedDocs({ documents: new Map([["s3", doc]]) });
  assert.equal(yDocToHtml(doc), mine, "the reconciler replaced a page whose content it could not keep");
  await storeDocumentState("s3", doc);
  assert.equal(yDocToHtml(doc), mine, "the store's guard replaced it");
  assert.equal(vaultContent("s3"), "<p>alpha</p><p>shared block</p>", "…and the page was not written over the note's newer content either");
  assert.equal(unsavedRow("s3")?.permanent, 0, "recorded as not saved yet (retried)");
  resetReconcileState(); // a restart
  const reopened = await loadDocumentState("s3", new Y.Doc());
  assert.equal(yDocToHtml(reopened), mine, "a load replaced it");
  assert.equal(getDocState("s3")!.ahead, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM collab_set_aside").get() as { n: number }).n, 0);
  // The table works again: now the vault's copy replaces the page's — and the page's text is kept first.
  db.exec("DROP TRIGGER r6_no_aside");
  await reconcileLoadedDocs({ documents: new Map([["s3", reopened]]) });
  assert.equal(yDocToHtml(reopened), "<p>alpha</p><p>shared block</p>");
  const aside = await setAsideList();
  assert.deepEqual(aside.map((r) => [r.noteId, r.reason]), [["s3", "uncertain_base"]]);
  const kept = (await (await app.request(`/api/admin/collab/set-aside/${aside[0]!.id}`, { headers: ownerHeaders() })).json()) as { body: string };
  assert.match(kept.body, /only local/);
});

// ── S4 ──────────────────────────────────────────────────────────────────────

const asideRows = (note: string) => (db.prepare("SELECT COUNT(*) AS n FROM collab_set_aside WHERE name = ?").get(note) as { n: number }).n;
const DAY = 24 * 3600_000;

test("S4: set-aside rows past 90 days are pruned by the periodic sweep, not only by the next insert", async () => {
  dbm.addCollabSetAside("fresh", "primary", "uncertain_base", "document", "fresh text", null);
  const insert = db.prepare("INSERT INTO collab_set_aside (vault_id, name, at, reason, kind, body, state) VALUES ('primary', ?, ?, 'uncertain_base', 'document', 'old text', NULL)");
  insert.run("old", Date.now() - 91 * DAY);
  insert.run("recent", Date.now() - 89 * DAY);
  assert.deepEqual([asideRows("old"), asideRows("recent"), asideRows("fresh")], [1, 1, 1]);
  await sweepUnsavedDocuments();
  assert.deepEqual([asideRows("old"), asideRows("recent"), asideRows("fresh")], [0, 1, 1]);
});

test("S4: a note deleted for good takes its set-aside page text with it — owner delete, member delete, purge from the Trash", { timeout: 60_000 }, async () => {
  const aside = (note: string) => dbm.addCollabSetAside(note, "primary", "uncertain_base", "document", `text of ${note}`, null);
  // (a) the owner deletes a note (the gateway's passthrough)
  fv.put({ id: "s4a", tags: ["garden"], content: "<p>a</p>", updatedAt: T0 });
  fv.put({ id: "keep", tags: ["garden"], content: "<p>k</p>", updatedAt: T0 });
  aside("s4a");
  aside("keep");
  assert.equal((await app.request("/api/notes/s4a", { method: "DELETE", headers: ownerHeaders() })).status < 300, true);
  assert.deepEqual([asideRows("s4a"), asideRows("keep")], [0, 1], "…and nobody else's rows");
  // (b) a member deletes their own note
  fv.put({ id: "s4b", tags: ["garden"], content: "<p>b</p>", metadata: { prism_creator: EDITOR }, updatedAt: T0 });
  aside("s4b");
  const member = { cookie: sessionCookie(makeSession(EDITOR)), ...J, "sec-fetch-site": "same-origin" };
  assert.equal((await app.request("/api/notes/s4b", { method: "DELETE", headers: member })).status, 200);
  assert.equal(asideRows("s4b"), 0);
  // (c) Trash, then delete permanently
  fv.put({ id: "s4c", path: "vault/s4c", tags: ["garden"], content: "<p>c</p>", updatedAt: T0 });
  aside("s4c");
  const trashed = await app.request("/api/notes/s4c/trash", { method: "POST", headers: ownerHeaders(), body: "{}" });
  assert.equal(trashed.status, 200, await trashed.clone().text());
  assert.equal(asideRows("s4c"), 1, "in the Trash the page can still come back: its row stays");
  const purged = await app.request("/api/trash/s4c", { method: "DELETE", headers: ownerHeaders() });
  assert.equal(purged.status, 200, await purged.clone().text());
  assert.equal(asideRows("s4c"), 0);
});

test("S4: reading (and deleting) a set-aside body writes an audit row — ids only, never the text; refused requests too", async () => {
  const id = dbm.addCollabSetAside("s4r", "primary", "uncertain_base", "document", "SECRET PAGE TEXT", null);
  const audits = () => db.prepare("SELECT action, status, target, actor_email, origin FROM action_audit WHERE action LIKE 'admin.collab-set-aside-%' ORDER BY id").all() as Array<{ action: string; status: string; target: string; actor_email: string; origin: string }>;
  const read = await app.request(`/api/admin/collab/set-aside/${id}`, { headers: ownerHeaders() });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { body: string }).body, "SECRET PAGE TEXT");
  assert.equal((await app.request(`/api/admin/collab/set-aside/999999`, { headers: ownerHeaders() })).status, 404);
  assert.equal((await app.request(`/api/admin/collab/set-aside/${id}`, { method: "DELETE", headers: ownerHeaders() })).status, 200);
  const rows = audits();
  assert.deepEqual(rows.map((r) => [r.action, r.status]), [["admin.collab-set-aside-read", "ok"], ["admin.collab-set-aside-read", "refused"], ["admin.collab-set-aside-delete", "ok"]]);
  assert.deepEqual(JSON.parse(rows[0]!.target), { id, noteId: "s4r", reason: "uncertain_base", kind: "document", bytes: 16 });
  assert.equal(rows[0]!.actor_email, OWNER);
  assert.equal(rows[0]!.origin, "human");
  assert.ok(!JSON.stringify(rows).includes("SECRET"), "no page text in the audit trail");
  // Not the owner: refused before anything is read (and nothing to audit — the router's own gate).
  assert.equal((await app.request(`/api/admin/collab/set-aside/${id}`, { headers: { cookie: sessionCookie(makeSession(EDITOR)) } })).status, 403);
});

// ── S6 ──────────────────────────────────────────────────────────────────────

test("S6: opening slow notes someone else wrote does not leave the OPENER busy — the notes are refused, the person's own conversions go on", { timeout: 120_000 }, async () => {
  await stopConversionWorkers();
  restore.push(configureConversion({ timeoutMs: 250, timeoutPerMbMs: 0, timeoutMaxMs: 250, actorBreakerFailures: 3, actorCooldownMs: 60_000, actorCooldownMaxMs: 60_000 }));
  restore.push(() => stopConversionWorkers());
  const tuning = collab.collabTuning as { busyWaitMs: number };
  const waitWas = tuning.busyWaitMs;
  tuning.busyWaitMs = 20;
  restore.push(() => void (tuning.busyWaitMs = waitWas));
  // marked is quadratic on these: seconds in the worker, cut off at 250 ms. Distinct content each.
  for (let i = 0; i < 4; i++) fv.put({ id: `s6n${i}`, tags: ["garden"], content: "*a ".repeat(6000) + i, updatedAt: T0 });
  const victim = "victim@test.local";
  for (let i = 0; i < 4; i++) {
    await assert.rejects(hocuspocus.openDirectConnection(`s6n${i}`, { email: victim } as never), (e) => e instanceof collab.DocumentTooComplexError, `note ${i} cannot be opened live`);
  }
  // The same account converts its own content as if nothing had happened…
  restore.push(configureConversion({ timeoutMs: 20_000, timeoutMaxMs: 20_000 }));
  const own = await service.markdownToHtml("own " + "word ".repeat(6000), { actor: `user:${victim}` }).then(() => "ok", (e) => (e instanceof ConversionError ? e.reason : String(e)));
  assert.equal(own, "ok", "the person who merely opened the notes is not cooling down");
  // …and opens a good note.
  fv.put({ id: "s6ok", tags: ["garden"], content: "good " + "word ".repeat(6000), updatedAt: T0 });
  const conn = await hocuspocus.openDirectConnection("s6ok", { email: victim } as never);
  await conn.disconnect();
});

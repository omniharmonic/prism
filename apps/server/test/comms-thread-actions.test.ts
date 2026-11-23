// Sprint Task 9: row actions (mute, archive with un-archive on arrival, status = vault tag write
// with undo, statusChange mirror) and owner folders (CRUD, order, membership, owner-only, flags,
// the threads listing, the stream). Synthetic data only; the vault is the fake.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { appendEvent, ensureSingleThread, eventsAfter, eventBounds, getThread, removeConversation, threadsOfPerson, unreadSummary, upsertConversation, type ConversationRow } from "../src/comms/store";
import { db } from "../src/db";
import { _setWaitingForTests, _waitingForTests } from "../src/comms/notify";
import { statusChange as serverStatusChange, SETTABLE_STATUSES } from "../src/comms/triage";
import { statusChange as coreStatusChange, TRIAGE_TAGS } from "../../../packages/core/src/lib/messages/triage";
import { decideOnArrival } from "../src/comms/notify";
import { getNotifySettings } from "../src/comms/notify-settings";
import { MAX_FOLDERS } from "../src/comms/folders";
import type { Message } from "../src/comms/types";
import { installFakeVault, makeSession, resetDb, sessionCookie, type FakeVault } from "./helpers";

const FLAGS = ["COMMS_ENABLED", "COMMS_THREAD_ACTIONS_ENABLED", "COMMS_FOLDERS_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
const logs = { warn: console.warn, log: console.log };
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  for (const k of FLAGS) process.env[k] = "true";
  console.warn = console.log = () => {};
});
afterEach(() => {
  Object.assign(console, logs);
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const owner = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)), "content-type": "application/json" });
const stranger = () => ({ cookie: sessionCookie(makeSession("someone-else@example.test")), "content-type": "application/json" });
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
const app = () => createApp();
const post = (path: string, body: unknown, headers = owner()) => app().request(`/api/comms${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const call = (method: string, path: string, body?: unknown, headers = owner()) =>
  app().request(`/api/comms${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function conv(id: string, n = 1, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "telegram", sourceRef: `!${id}:hs`, kind: "dm", title: `Title ${id}`, titleSource: "room",
    avatar: null, lastEventAt: at(n), lastPreview: null, unreadCount: 0, unreadTrusted: true,
    folder: "inbox", pinned: false, muted: false, archived: false, triage: null, accountLabel: null,
    capabilities: null, vaultNoteId: null, ...over,
  });
  return ensureSingleThread(id);
}

function incoming(threadId: string, sentAt: string, over: Partial<Message> = {}): Message {
  return {
    id: `m-${sentAt}`, threadId, channel: { network: "telegram", accountLabel: null }, source: { network: "telegram", eventId: `$${sentAt}`, ref: `$${sentAt}` },
    sender: { id: "@x:hs", name: "X", isSelf: false, isOmni: false }, sentAt, body: { spans: [{ t: "text", v: "hi" }] }, attachments: [], linkPreviews: [],
    reactions: [], redacted: false, ...over,
  } as unknown as Message;
}

const listIds = async (q: string) => ((await (await app().request(`/api/comms/threads?${q}`, { headers: owner() })).json()) as { threads: { id: string }[] }).threads.map((t) => t.id);

// ── statusChange mirror ──────────────────────────────────────────────────────

test("statusChange: the server mirror agrees with core on every settable status", () => {
  assert.deepEqual([...SETTABLE_STATUSES], [...TRIAGE_TAGS]);
  const cases: string[][] = [[], ["message-thread"], ["urgent", "triaged"], ["triage-failed"], ["needs-triage", "low"], ["handled", "social", "triaged", "x"]];
  for (const tags of cases) for (const next of TRIAGE_TAGS) assert.deepEqual(serverStatusChange(tags, next), coreStatusChange(tags, next), `${tags} → ${next}`);
});

// ── flags + owner-only ───────────────────────────────────────────────────────

test("row actions and folders are off by default; capabilities list them only when on", async () => {
  const t = conv("a");
  delete process.env.COMMS_THREAD_ACTIONS_ENABLED;
  delete process.env.COMMS_FOLDERS_ENABLED;
  for (const [path, body] of [[`/threads/${t}/mute`, { muted: true }], [`/threads/${t}/archive`, { archived: true }], [`/threads/${t}/status`, { status: "urgent" }]] as const) {
    const r = await post(path, body);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "thread_actions_disabled" });
  }
  assert.equal((await call("GET", "/folders")).status, 404);
  assert.deepEqual(await (await post("/folders", { name: "Work" })).json(), { error: "folders_disabled" });
  assert.equal((await app().request("/api/comms/threads?inFolder=cf_x", { headers: owner() })).status, 404);
  let caps = (await (await app().request("/api/comms/capabilities", { headers: owner() })).json()) as { operations: string[] };
  for (const op of ["threads:mute", "threads:archive", "threads:status", "threads:folders"]) assert.ok(!caps.operations.includes(op), op);
  // Threads carry no folderIds with the flag off, even when membership rows exist.
  process.env.COMMS_FOLDERS_ENABLED = "true";
  const f = ((await (await post("/folders", { name: "Work" })).json()) as { folder: { id: string } }).folder;
  await post(`/folders/${f.id}/threads`, { threadIds: [t] });
  assert.deepEqual(getThread(t)!.folderIds, [f.id]);
  delete process.env.COMMS_FOLDERS_ENABLED;
  assert.equal(getThread(t)!.folderIds, undefined);
  process.env.COMMS_THREAD_ACTIONS_ENABLED = "true";
  process.env.COMMS_FOLDERS_ENABLED = "true";
  caps = (await (await app().request("/api/comms/capabilities", { headers: owner() })).json()) as { operations: string[] };
  for (const op of ["threads:mute", "threads:archive", "threads:status", "threads:folders"]) assert.ok(caps.operations.includes(op), op);
});

test("owner only: another signed-in account gets nothing", async () => {
  const t = conv("a");
  for (const [m, path, body] of [
    ["POST", `/threads/${t}/mute`, { muted: true }], ["POST", `/threads/${t}/archive`, { archived: true }],
    ["POST", `/threads/${t}/status`, { status: "urgent" }], ["GET", "/folders", undefined], ["POST", "/folders", { name: "X" }],
  ] as const) {
    const r = await call(m, path, body, stranger());
    assert.ok(r.status === 403 || r.status === 404, `${m} ${path} → ${r.status}`);
  }
  assert.equal(getThread(t)!.muted, false);
  assert.deepEqual(((await (await call("GET", "/folders")).json()) as { folders: unknown[] }).folders, []);
});

// ── mute ─────────────────────────────────────────────────────────────────────

test("mute: owner override, announced once, and the notifier never pushes a muted thread", async () => {
  const t = conv("a", 1, { status: "urgent" });
  const before = eventBounds().seq;
  const r = await post(`/threads/${t}/mute`, { muted: true });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { thread: { muted: boolean } }).thread.muted, true);
  await post(`/threads/${t}/mute`, { muted: true }); // idempotent: no second event
  assert.equal(eventsAfter(before, 10).filter((e) => e.kind === "thread.updated").length, 1);
  assert.equal(decideOnArrival(getNotifySettings(), getThread(t)!, { sentAt: new Date().toISOString() }), "never");
  await post(`/threads/${t}/mute`, { muted: false });
  assert.equal(getThread(t)!.muted, false);
  assert.equal(decideOnArrival(getNotifySettings(), getThread(t)!, { sentAt: new Date().toISOString() }), "now");
  // Bad bodies.
  assert.equal((await post(`/threads/${t}/mute`, { muted: "yes" })).status, 400);
  assert.equal((await post(`/threads/${t}/mute`, { muted: true, extra: 1 })).status, 400);
  assert.equal((await app().request(`/api/comms/threads/${t}/mute`, { method: "POST", headers: { ...owner(), "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post(`/threads/th_nope/mute`, { muted: true })).status, 404);
});

// ── archive ──────────────────────────────────────────────────────────────────

test("archive: moves to Archived; a newer incoming message brings it back (Messages); older/own ones do not", async () => {
  const t = conv("a");
  const r = await post(`/threads/${t}/archive`, { archived: true });
  assert.equal(((await r.json()) as { thread: { folder: string } }).thread.folder, "archived");
  assert.deepEqual(await listIds("folder=archived"), [t]);
  assert.deepEqual(await listIds(""), []);
  // A backfilled older message, the owner's own message, a system line: still archived.
  appendEvent("message.created", t, { threadId: t, message: incoming(t, at(0)) });
  appendEvent("message.created", t, { threadId: t, message: incoming(t, new Date(Date.now() + 60_000).toISOString(), { sender: { id: "@me:hs", name: "Me", avatar: null, isSelf: true, isOmni: false } }) });
  appendEvent("message.created", t, { threadId: t, message: incoming(t, new Date(Date.now() + 60_000).toISOString(), { system: { kind: "join", text: "joined" } }) });
  assert.equal(getThread(t)!.folder, "archived");
  const before = eventBounds().seq;
  appendEvent("message.created", t, { threadId: t, message: incoming(t, new Date(Date.now() + 60_000).toISOString()) });
  assert.equal(getThread(t)!.folder, "inbox");
  assert.ok(eventsAfter(before, 10).some((e) => e.kind === "thread.updated" && (e.payload as { reason?: string }).reason === "unarchived"));
  // Unarchive explicitly beats a source-side archive.
  const s = conv("b", 2, { archived: true });
  assert.equal(getThread(s)!.folder, "archived");
  await post(`/threads/${s}/archive`, { archived: false });
  assert.equal(getThread(s)!.folder, "inbox");
  // A source-archived thread (not the owner's Comms archive) is left to its source on arrival.
  const u = conv("c", 3, { archived: true });
  appendEvent("message.created", u, { threadId: u, message: incoming(u, new Date(Date.now() + 60_000).toISOString()) });
  assert.equal(getThread(u)!.folder, "archived");
});

// ── status ───────────────────────────────────────────────────────────────────

test("status: one statusChange tag write on the thread's note, projected at once, with an undo", async () => {
  fv.put({ id: "n1", path: "vault/messages/a", tags: ["message-thread", "informational", "triaged"], content: "" });
  const t = conv("a", 1, { vaultNoteId: "n1", status: "informational" });
  const r = await post(`/threads/${t}/status`, { status: "urgent" });
  assert.equal(r.status, 200);
  const out = (await r.json()) as { thread: { status: string }; undo: { id: string; status: string } };
  assert.equal(out.thread.status, "urgent");
  assert.equal(out.undo.status, "informational");
  assert.deepEqual([...(fv.notes.get("n1")!.tags ?? [])].sort(), ["message-thread", "triaged", "urgent"], "core keeps the classifier's triaged");
  const patches = fv.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1, "one write");
  assert.deepEqual((patches[0]!.body as { tags: unknown }).tags, { add: ["urgent"], remove: ["informational"] });
  // The same status again writes nothing and has no undo.
  const again = (await (await post(`/threads/${t}/status`, { status: "urgent" })).json()) as { undo: unknown };
  assert.equal(again.undo, null);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 1);
  // Undo restores the classification tags exactly.
  const u = await post(`/threads/${t}/status/undo`, { undoId: out.undo.id });
  assert.equal(u.status, 200);
  assert.equal(((await u.json()) as { thread: { status: string } }).thread.status, "informational");
  assert.deepEqual([...(fv.notes.get("n1")!.tags ?? [])].sort(), ["informational", "message-thread", "triaged"]);
  assert.deepEqual(await (await post(`/threads/${t}/status/undo`, { undoId: out.undo.id })).json(), { error: "already_undone" });
  assert.equal((await post(`/threads/${t}/status/undo`, { undoId: "su_unknown" })).status, 404);
});

test("status: undo refuses once the note moved on; no note → 409; bad status → 400; vault down → 503", async () => {
  fv.put({ id: "n1", path: "vault/messages/a", tags: ["message-thread"], content: "" });
  const t = conv("a", 1, { vaultNoteId: "n1" });
  const out = (await (await post(`/threads/${t}/status`, { status: "handled" })).json()) as { undo: { id: string } };
  // The classifier (or another device) changed it since.
  fv.notes.get("n1")!.tags = ["message-thread", "low", "triaged"];
  const r = await post(`/threads/${t}/status/undo`, { undoId: out.undo.id });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "status_changed" });
  assert.deepEqual([...(fv.notes.get("n1")!.tags ?? [])].sort(), ["low", "message-thread", "triaged"], "nothing undone over it");
  const bb = conv("b", 2); // no vault note (iMessage/SMS)
  assert.deepEqual(await (await post(`/threads/${bb}/status`, { status: "urgent" })).json(), { error: "no_note" });
  assert.equal((await post(`/threads/${t}/status`, { status: "unclassified" })).status, 400);
  assert.equal((await post(`/threads/${t}/status`, { status: "triage-failed" })).status, 400);
  fv.failNextWrite = true;
  const down = await post(`/threads/${t}/status`, { status: "urgent" });
  assert.equal(down.status, 503);
  assert.equal(getThread(t)!.status, "handled", "projection unchanged when the write failed");
});

// ── folders ──────────────────────────────────────────────────────────────────

type F = { id: string; name: string; position: number; count: number };
const folders = async () => ((await (await call("GET", "/folders")).json()) as { folders: F[] }).folders;
const create = async (name: string) => ((await (await post("/folders", { name })).json()) as { folder: F }).folder;

test("folders: create / rename / reorder / delete, names validated, limit, list-wide announcements", async () => {
  const before = eventBounds().seq;
  const work = await create("  Work   stuff ");
  assert.equal(work.name, "Work stuff");
  const fam = await create("Family");
  assert.deepEqual((await folders()).map((f) => [f.name, f.position]), [["Work stuff", 0], ["Family", 1]]);
  assert.equal((await post("/folders", { name: "family" })).status, 409, "names are unique, case-insensitive");
  assert.equal((await post("/folders", { name: "Comms" })).status, 409, "the home page's name");
  for (const bad of ["", "   ", "x".repeat(41), "a\u0000b", "a‮b", 5]) assert.equal((await post("/folders", { name: bad })).status, 400, String(bad));
  const ren = await call("PATCH", `/folders/${work.id}`, { name: "Work" });
  assert.equal(((await ren.json()) as { folder: F }).folder.name, "Work");
  assert.equal((await call("PATCH", `/folders/${work.id}`, { name: "Family" })).status, 409);
  assert.equal((await call("PATCH", `/folders/cf_nope`, { name: "X" })).status, 404);
  // Reorder must name exactly the folders.
  const bad = await call("PUT", "/folders/order", { folderIds: [fam.id] });
  assert.equal(bad.status, 409);
  assert.deepEqual(await bad.json(), { error: "folders_changed", folderIds: [work.id, fam.id] });
  const ok = await call("PUT", "/folders/order", { folderIds: [fam.id, work.id] });
  assert.deepEqual(((await ok.json()) as { folders: F[] }).folders.map((f) => f.name), ["Family", "Work"]);
  assert.equal((await call("DELETE", `/folders/${fam.id}`)).status, 200);
  assert.deepEqual((await folders()).map((f) => [f.name, f.position]), [["Work", 0]], "positions stay dense");
  const listWide = eventsAfter(before, 50).filter((e) => e.kind === "thread.updated" && (e.payload as { reason?: string }).reason === "folders");
  assert.equal(listWide.length, 5, "create ×2, rename, reorder, delete");
  for (let i = 1; i < MAX_FOLDERS; i++) await create(`F${i}`);
  assert.deepEqual(await (await post("/folders", { name: "One more" })).json(), { error: "folder_limit" });
});

test("folders: membership (multi-select add/remove), folderIds on threads, the folder's listing, stream", async () => {
  const a = conv("a", 3);
  const b = conv("b", 2);
  const c = conv("c", 1);
  const work = await create("Work");
  const before = eventBounds().seq;
  const add = await post(`/folders/${work.id}/threads`, { threadIds: [a, b, a] });
  assert.equal(((await add.json()) as { folder: F }).folder.count, 2);
  await post(`/folders/${work.id}/threads`, { threadIds: [a] }); // idempotent
  const perThread = eventsAfter(before, 20).filter((e) => e.kind === "thread.updated").map((e) => (e.payload as { threadId: string }).threadId);
  assert.deepEqual(perThread.sort(), [a, b].sort(), "one event per thread that changed");
  assert.deepEqual(getThread(a)!.folderIds, [work.id]);
  assert.equal(getThread(c)!.folderIds, undefined);
  assert.deepEqual(await listIds(`inFolder=${work.id}`), [a, b]);
  assert.deepEqual(await listIds(""), [a, b, c], "the home page (All) still lists everything");
  // An archived member leaves the folder page (unless folder=archived is asked for).
  await post(`/threads/${b}/archive`, { archived: true });
  assert.deepEqual(await listIds(`inFolder=${work.id}`), [a]);
  assert.deepEqual(await listIds(`inFolder=${work.id}&folder=archived`), [b]);
  // Unknown thread refuses the whole add; unknown folder 404.
  assert.deepEqual(await (await post(`/folders/${work.id}/threads`, { threadIds: [c, "th_nope"] })).json(), { error: "thread_unavailable" });
  assert.equal(getThread(c)!.folderIds, undefined);
  assert.equal((await post(`/folders/cf_nope/threads`, { threadIds: [c] })).status, 404);
  assert.equal((await app().request(`/api/comms/threads?inFolder=cf_nope`, { headers: owner() })).status, 404);
  assert.equal((await post(`/folders/${work.id}/threads`, { threadIds: [] })).status, 400);
  // Remove, then deleting the folder announces each member that lost it.
  await post(`/folders/${work.id}/threads/remove`, { threadIds: [a] });
  assert.equal(getThread(a)!.folderIds, undefined);
  const mid = eventBounds().seq;
  await call("DELETE", `/folders/${work.id}`);
  assert.ok(eventsAfter(mid, 20).some((e) => (e.payload as { threadId: string | null }).threadId === b));
  assert.equal(getThread(b)!.folderIds, undefined);
});

// ── final review fixes ───────────────────────────────────────────────────────

test("I2: row actions, folder writes and pin writes are a person's — agent, MCP-style and loopback origins refused", async () => {
  process.env.COMMS_PINS_ENABLED = "true";
  const t = conv("a");
  const f = await create("Work");
  const agent = () => ({ ...owner(), "x-prism-action-origin": "agent" });
  for (const [m, path, body] of [
    ["POST", `/threads/${t}/mute`, { muted: true }], ["POST", `/threads/${t}/archive`, { archived: true }],
    ["POST", `/threads/${t}/status`, { status: "urgent" }], ["POST", `/threads/${t}/status/undo`, { undoId: "su_x" }],
    ["POST", "/folders", { name: "X" }], ["PATCH", `/folders/${f.id}`, { name: "Y" }], ["PUT", "/folders/order", { folderIds: [f.id] }],
    ["POST", `/folders/${f.id}/threads`, { threadIds: [t] }], ["POST", `/folders/${f.id}/threads/remove`, { threadIds: [t] }],
    ["DELETE", `/folders/${f.id}`, undefined], ["POST", `/threads/${t}/pin`, undefined], ["DELETE", `/threads/${t}/pin`, undefined], ["PUT", "/pins", { threadIds: [] }],
  ] as const) {
    const r = await call(m, path, body, agent());
    assert.equal(r.status, 403, `${m} ${path}`);
    assert.deepEqual(await r.json(), { error: "agent_origin_refused" }, `${m} ${path}`);
  }
  assert.equal(getThread(t)!.muted, false, "nothing changed");
  assert.equal(getThread(t)!.folder, "inbox");
  assert.deepEqual((await folders()).map((x) => x.name), ["Work"]);
  // Reads stay open to the owner's agents (they change nothing).
  assert.equal((await call("GET", "/folders", undefined, agent())).status, 200);
  assert.equal((await call("GET", "/pins", undefined, agent())).status, 200);
  delete process.env.COMMS_PINS_ENABLED;
});

test("I3: with COMMS_EMAIL_ENABLED off, email conversations leave lists, pins, counts, people and folders and 404; on again restores them", async () => {
  const saved = process.env.COMMS_EMAIL_ENABLED;
  process.env.COMMS_EMAIL_ENABLED = "true";
  const tg = conv("tg", 2);
  const em = conv("em", 3, { network: "email", sourceRef: "email:owner@test.local:t1", unreadCount: 1 });
  // A Matrix-bridged "email" room is not Task 3's projection: the flag does not govern it.
  const bridged = conv("br", 1, { network: "email" });
  db.prepare(`UPDATE comms_threads SET person_id = 'p1' WHERE id IN (?, ?)`).run(tg, em);
  const work = await create("Work");
  await post(`/folders/${work.id}/threads`, { threadIds: [tg, em] });
  assert.deepEqual(await listIds(""), [em, tg, bridged]);
  delete process.env.COMMS_EMAIL_ENABLED;
  assert.deepEqual(await listIds(""), [tg, bridged], "the list (the bridged room stays)");
  assert.deepEqual(await listIds(`inFolder=${work.id}`), [tg], "a folder page");
  assert.equal((await folders())[0]!.count, 1, "and its count");
  assert.deepEqual(await listIds("q=Title"), [tg, bridged], "list search");
  assert.equal(getThread(em), null);
  assert.equal(threadsOfPerson("p1").length, 1, "a person's conversations");
  assert.equal((await app().request(`/api/comms/threads/${em}`, { headers: owner() })).status, 404, "the thread");
  assert.equal((await app().request(`/api/comms/threads/${em}/messages`, { headers: owner() })).status, 404, "its messages");
  assert.equal((await app().request(`/api/comms/threads/${em}/messages/m1/original`, { headers: owner() })).status, 404, "a full email");
  assert.equal(unreadSummary().threads, 0, "the badge");
  process.env.COMMS_EMAIL_ENABLED = "true";
  assert.deepEqual(await listIds(""), [em, tg, bridged], "turned back on: restored");
  assert.ok(getThread(em));
  if (saved === undefined) delete process.env.COMMS_EMAIL_ENABLED; else process.env.COMMS_EMAIL_ENABLED = saved;
});

test("M1: a folder's count is what its page shows (archived members and gone conversations left out)", async () => {
  const a = conv("a", 3);
  const b = conv("b", 2);
  const c = conv("c", 1);
  const f = await create("Work");
  await post(`/folders/${f.id}/threads`, { threadIds: [a, b, c] });
  assert.equal((await folders())[0]!.count, 3);
  await post(`/threads/${b}/archive`, { archived: true });
  removeConversation("c");
  assert.equal((await folders())[0]!.count, 1);
  assert.deepEqual(await listIds(`inFolder=${f.id}`), [a]);
});

test("M2 + M5: unarchive returns to the source's state (no sticky override); archive unpins a Comms pin", async () => {
  process.env.COMMS_PINS_ENABLED = "true";
  const t = conv("a");
  await post(`/threads/${t}/pin`, undefined);
  assert.equal(getThread(t)!.pinned, true);
  await post(`/threads/${t}/archive`, { archived: true });
  assert.equal(getThread(t)!.pinned, false, "archived pins leave the grid");
  await post(`/threads/${t}/archive`, { archived: false });
  assert.equal((db.prepare(`SELECT o_archived AS o FROM comms_threads WHERE id = ?`).get(t) as { o: number | null }).o, null, "no override left behind");
  // A later source-side archive therefore still applies.
  conv("a", 1, { archived: true });
  assert.equal(getThread(t)!.folder, "archived");
  // Unarchiving a SOURCE-archived thread needs the override to beat the source.
  await post(`/threads/${t}/archive`, { archived: false });
  assert.equal(getThread(t)!.folder, "inbox");
  delete process.env.COMMS_PINS_ENABLED;
});

test("M4: an Omni post does not un-archive; instants compare as times, not strings", async () => {
  const t = conv("a");
  await post(`/threads/${t}/archive`, { archived: true });
  const later = new Date(Date.now() + 60_000).toISOString();
  appendEvent("message.created", t, { threadId: t, message: incoming(t, later, { sender: { id: "@omni:hs", name: "Omni", avatar: null, isSelf: false, isOmni: true } }) });
  assert.equal(getThread(t)!.folder, "archived");
  // Same second, no milliseconds, but earlier than the archive instant: still archived.
  const archivedAt = (db.prepare(`SELECT o_archived_at AS a FROM comms_threads WHERE id = ?`).get(t) as { a: string }).a;
  const sameSecond = archivedAt.replace(/\.\d+Z$/, "Z");
  appendEvent("message.created", t, { threadId: t, message: incoming(t, sameSecond) });
  assert.equal(getThread(t)!.folder, "archived");
  appendEvent("message.created", t, { threadId: t, message: incoming(t, later) });
  assert.equal(getThread(t)!.folder, "inbox");
});

test("M3: a status the owner sets drops messages waiting for a verdict (no push for what he just saw)", async () => {
  fv.put({ id: "n1", path: "vault/messages/a", tags: ["message-thread"], content: "" });
  const t = conv("a", 1, { vaultNoteId: "n1" });
  _setWaitingForTests(t);
  assert.deepEqual(_waitingForTests(), [t]);
  await post(`/threads/${t}/status`, { status: "urgent" });
  assert.deepEqual(_waitingForTests(), []);
});

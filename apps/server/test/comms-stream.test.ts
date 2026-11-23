// Task 11: live updates — ingest bus (publish after the vault write), COMMS_SYNC_LONGPOLL
// (vault output unchanged, passes never overlap), the live listener (events + a warm window
// cache) and GET /api/comms/stream (frames, resume, reset, owner-only, heartbeat, clean close).
// Synthetic data only; fakes for the homeserver and the vault.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, getVaultRegistry, resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import { ingestMatrix, parseSync, type IngestVault, type MatrixEvent, type SyncResult } from "../src/worker/matrix";
import * as sched from "../src/worker/scheduler";
import { commsBus } from "../src/comms/bus";
import { handleLiveBatch, liveSettled, setLiveDepsForTests, startCommsLive, stopCommsLive, type LiveDeps } from "../src/comms/live";
import { projectRoom, type ProjectDeps } from "../src/comms/project";
import { peopleAdapter } from "../src/comms/project-deps";
import { PeopleIndex } from "../src/worker/people";
import { appendEvent, commsEventListenerCount, pruneEvents, EVENT_RETENTION_MS } from "../src/comms/store";
import { setCommsReaderForTests, setTimelineClockForTests, WINDOW_MAX_AGE_MS, type CommsReader } from "../src/comms/timeline";
import { startCommsProjection, startRebuild } from "../src/comms/project-deps";
import { commsStreamCount, setCommsStreamTuningForTests } from "../src/comms/stream";
import type { Note } from "../src/parachute";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const ROOM = "!live:example.test";
const ME = "@me:example.test";
const ALEX = "@whatsapp_222:example.test";
const PIC = "mxc://example.test/alexpic";
const ts = (n: number) => 1_790_000_000_000 + n * 1000;
const ev = (id: string, n: number, sender: string, type: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ event_id: id, origin_server_ts: ts(n), sender, type, content, ...extra }) as MatrixEvent;

const env = { comms: process.env.COMMS_ENABLED, lp: process.env.COMMS_SYNC_LONGPOLL };
const logs = { warn: console.warn, log: console.log, error: console.error };
beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  delete process.env.COMMS_SYNC_LONGPOLL;
  console.warn = console.log = () => {};
});
afterEach(async () => {
  Object.assign(console, logs);
  for (const [k, v] of [["COMMS_ENABLED", env.comms], ["COMMS_SYNC_LONGPOLL", env.lp]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stopCommsLive();
  setLiveDepsForTests(null);
  setCommsReaderForTests(null);
  setCommsStreamTuningForTests(null);
  sched.setMatrixLongpollTuningForTests(null);
  await sched.stopMatrixChains();
});

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

// ── ingest: the bus and the long-poll flag ───────────────────────────────────

/** A raw /sync response: two rooms with messages, one with only a reaction. */
const RAW_SYNC = {
  next_batch: "s_next",
  rooms: {
    join: {
      "!a:hs": {
        state: { events: [{ type: "m.room.name", content: { name: "Alpha" } }, { type: "m.room.member", state_key: "@whatsapp_1:hs", content: { membership: "join", displayname: "One" } }] },
        timeline: { events: [
          { type: "m.room.message", sender: "@whatsapp_1:hs", event_id: "$a1", origin_server_ts: 1000, content: { msgtype: "m.text", body: "hi alpha" } },
          { type: "m.reaction", sender: "@whatsapp_1:hs", event_id: "$a2", origin_server_ts: 1001, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$a1", key: "👍" } } },
        ] },
      },
      "!b:hs": {
        state: { events: [{ type: "m.room.name", content: { name: "Beta" } }, { type: "m.room.member", state_key: "@telegram_2:hs", content: { membership: "join", displayname: "Two" } }] },
        timeline: { events: [{ type: "m.room.message", sender: "@telegram_2:hs", event_id: "$b1", origin_server_ts: 2000, content: { msgtype: "m.text", body: "hi beta" } }] },
      },
      "!c:hs": {
        timeline: { events: [{ type: "m.reaction", sender: "@telegram_2:hs", event_id: "$c1", origin_server_ts: 3000, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$old", key: "❤️" } } }] },
      },
    },
  },
};
const fixtureSync = (): SyncResult => parseSync(structuredClone(RAW_SYNC) as Parameters<typeof parseSync>[0]);

function recordingVault(order: string[], seed: Note[] = [], failRoom?: string) {
  const notes = new Map(seed.map((n) => [n.id, structuredClone(n)]));
  const creates: unknown[] = [];
  const updates: unknown[] = [];
  let seq = 0;
  const vault: IngestVault = {
    async listNotes() { return [...notes.values()].map((n) => structuredClone(n)); },
    async getNote(id) { return structuredClone(notes.get(id)!); },
    async createNote(p) {
      const room = (p.metadata as { matrixRoomId?: string } | undefined)?.matrixRoomId;
      if (room === failRoom) throw Object.assign(new Error("vault down"), { status: 500 });
      creates.push(structuredClone(p));
      order.push(`write:${room}`);
      const n: Note = { id: `n${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: `u${seq}` };
      notes.set(n.id, n);
      return structuredClone(n);
    },
    async updateNote(id, p) {
      updates.push(structuredClone({ id, ...p }));
      order.push(`write:${(notes.get(id)?.metadata as { matrixRoomId?: string })?.matrixRoomId}`);
      const cur = notes.get(id)!;
      notes.set(id, { ...cur, content: p.content ?? cur.content, metadata: { ...(cur.metadata ?? {}), ...(p.metadata ?? {}) }, updatedAt: `u${++seq}` });
      return structuredClone(notes.get(id)!);
    },
    async removeTags() {},
  };
  return { vault, creates, updates, notes };
}

test("ingest publishes after vault write, not before", async () => {
  const order: string[] = [];
  const v = recordingVault(order, [], "!b:hs");
  const published: Array<{ roomId: string; types: string[]; noteId?: string; stale?: true }> = [];
  await ingestMatrix({ sync: async () => fixtureSync() }, v.vault, {
    publish: (b) => {
      order.push(`publish:${b.roomId}`);
      published.push({ roomId: b.roomId, types: b.events.map((e) => e.type!), noteId: b.noteId, ...(b.stale ? { stale: b.stale } : {}) });
    },
  });
  // !a: written, THEN published (with its raw events, the reaction included, and its note id);
  // !c: nothing to write (a reaction) → published; !b: the write failed → announced at the end
  // of the pass, flagged stale (the vault lags) but WITH its raw events, so the live stream keeps
  // flowing for that thread (e2e B1).
  assert.deepEqual(order, ["write:!a:hs", "publish:!a:hs", "publish:!c:hs", "publish:!b:hs"]);
  assert.deepEqual(published[2], { roomId: "!b:hs", types: ["m.room.message"], noteId: undefined, stale: true });
  assert.deepEqual(published[0], { roomId: "!a:hs", types: ["m.room.message", "m.reaction"], noteId: "n1" });
  assert.deepEqual(published[1]!.types, ["m.reaction"]);
  // The vault writer kept its own filtering: only the text message reached the note.
  assert.match((v.creates[0] as { content: string }).content, /hi alpha/);
  assert.doesNotMatch((v.creates[0] as { content: string }).content, /👍/);
});

test("a throwing bus subscriber never breaks ingest", async () => {
  const v = recordingVault([]);
  const res = await ingestMatrix({ sync: async () => fixtureSync() }, v.vault, { publish: () => { throw new Error("boom"); } });
  assert.equal(res.created, 2);
  assert.deepEqual(res.failedRooms, []);
});

test("ingest vault output identical with longpoll on and off", async () => {
  const runWith = async (longpoll: boolean) => {
    resetDb();
    if (longpoll) process.env.COMMS_SYNC_LONGPOLL = "true";
    else delete process.env.COMMS_SYNC_LONGPOLL;
    const seed: Note = {
      id: "seed", content: "# Beta — telegram\n\n[1970-01-01 00:00] Two: older", path: "vault/messages/telegram/Beta", tags: ["message-thread"],
      metadata: { type: "message-thread", platform: "telegram", matrixRoomId: "!b:hs", lastMessageAt: 500, messageCount: 1, participants: ["Two"] },
      createdAt: "t", updatedAt: "u0",
    };
    const v = recordingVault([], [seed]);
    const calls: unknown[][] = [];
    const client = { sync: async (...args: unknown[]) => { calls.push(args); return fixtureSync(); } };
    await sched.runMatrixOnce(getVaultRegistry()[0]!, { client, vault: v.vault });
    return { creates: v.creates, updates: v.updates, notes: [...v.notes.values()], calls };
  };
  const off = await runWith(false);
  const on = await runWith(true);
  assert.deepEqual(on.creates, off.creates, "notes created are identical");
  assert.deepEqual(on.updates, off.updates, "note updates are identical");
  assert.deepEqual(on.notes, off.notes, "the vault ends identical");
  assert.equal(off.creates.length, 1);
  assert.equal(off.updates.length, 1);
  // Only the /sync request differs: off = exactly sync(since); on = the 30 s long-poll.
  assert.deepEqual(off.calls, [[undefined]]);
  assert.deepEqual(on.calls, [[undefined, 30_000]]);
});

test("longpoll chain: passes run back to back with the 30 s poll and never overlap; off = no chain", async () => {
  process.env.COMMS_SYNC_LONGPOLL = "true";
  sched.setMatrixLongpollTuningForTests({ minGapMs: 1 });
  let active = 0, maxActive = 0, calls = 0;
  const timeouts: unknown[] = [];
  const client = {
    sync: async (_since?: string, timeoutMs?: number) => {
      active++; maxActive = Math.max(maxActive, active); calls++; timeouts.push(timeoutMs);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      // a batch on odd passes, nothing on even ones
      return calls % 2 ? fixtureSync() : { nextBatch: `s${calls}`, invites: [], rooms: [] };
    },
  };
  const v = recordingVault([]);
  const entry = getVaultRegistry()[0]!;
  sched.startMatrixChain(entry, { client, vault: v.vault });
  sched.startMatrixChain(entry, { client, vault: v.vault }); // a second start joins the first
  // A manual pass while the chain runs joins (never a second concurrent pass).
  void sched.runMatrixOnce(entry, { client, vault: v.vault });
  await until(() => calls >= 6, "six chained passes");
  await sched.stopMatrixChains();
  assert.equal(maxActive, 1, "passes never overlap");
  assert.ok(timeouts.every((t) => t === 30_000));
  assert.equal(sched.matrixChainRunning(entry.id), false);
  // Flag off: the chain does not start at all.
  delete process.env.COMMS_SYNC_LONGPOLL;
  const before = calls;
  sched.startMatrixChain(entry, { client, vault: v.vault });
  await sched.stopMatrixChains();
  assert.equal(calls, before);
});

// ── the live listener + the stream ───────────────────────────────────────────

const NOTE: Note = {
  id: "thread-note", content: "", path: "vault/messages/whatsapp/Alex", createdAt: "t", updatedAt: "u1", tags: ["message-thread"],
  metadata: { type: "message-thread", platform: "whatsapp", matrixRoomId: ROOM, lastMessageAt: ts(13), lastMessageText: "hello", lastMessageSender: ALEX, lastMessageIsSelf: false },
};
const PROFILES = { [ME]: { name: "Me", avatar: null }, [ALEX]: { name: "Alex", avatar: PIC } };
const NEWEST: MatrixEvent[] = [
  ev("$hello", 13, ALEX, "m.room.message", { msgtype: "m.text", body: "hello" }),
  ev("$intro", 12, ME, "m.room.message", { msgtype: "m.text", body: "hi Alex" }),
];

let readerCalls = 0;
function setup(): { deps: LiveDeps; threadId: Promise<string> } {
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_fixture_secret" }));
  readerCalls = 0;
  const reader: CommsReader = {
    whoami: async () => ME,
    memberProfiles: async () => PROFILES,
    timelinePage: async (_room, from) => { readerCalls++; return from ? { chunk: [], start: from, end: null } : { chunk: NEWEST, start: "s0", end: "tok1" }; },
  };
  setCommsReaderForTests(() => reader);
  const project: ProjectDeps = {
    vault: { listByTag: async () => [NOTE] },
    reader: { whoami: async () => ME, roomState: async () => [] as never, memberProfiles: async () => PROFILES },
    people: peopleAdapter(new PeopleIndex([])),
  };
  const deps: LiveDeps = { project, getNote: async (id) => (id === NOTE.id ? structuredClone(NOTE) : null) };
  setLiveDepsForTests(async () => deps);
  return { deps, threadId: projectRoom(project, ROOM, NOTE) };
}

const ownerHeaders = (extra: Record<string, string> = {}) => ({ cookie: sessionCookie(makeSession(config.ownerEmail)), ...extra });

async function openStream(headers: Record<string, string> = ownerHeaders()) {
  const res = await createApp().request("/api/comms/stream", { headers });
  let buf = "";
  const reader = res.status === 200 && res.body ? res.body.getReader() : null;
  if (reader) {
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value);
        }
      } catch { /* cancelled */ }
    })();
  }
  const frames = () => buf.split("\n\n").filter((f) => f.includes("event:")).map((f) => {
    const get = (k: string) => f.split("\n").find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
    return { id: get("id"), event: get("event"), data: JSON.parse(get("data") ?? "null") };
  });
  return { res, raw: () => buf, frames, close: async () => { await reader?.cancel().catch(() => {}); } };
}

test("stream emits message.created for a bus batch", async () => {
  const { threadId } = setup();
  const tid = await threadId;
  startCommsLive();
  const s = await openStream();
  assert.equal(s.res.status, 200);
  assert.match(s.res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(s.res.headers.get("cache-control"), "private, no-store");
  commsBus.publish({
    roomId: ROOM, noteId: NOTE.id,
    events: [ev("$pic", 20, ALEX, "m.room.message", { msgtype: "m.image", body: "p.jpg", url: "mxc://example.test/photo", info: { mimetype: "image/jpeg", w: 10, h: 10 } })],
  });
  await liveSettled();
  await until(() => s.frames().some((f) => f.event === "message.created"), "message.created frame");
  const f = s.frames().find((x) => x.event === "message.created")!;
  assert.match(f.id!, /^\d+$/);
  assert.equal(f.data.threadId, tid);
  assert.equal(f.data.message.id, "$pic");
  assert.ok(f.data.message.attachments[0].mediaToken, "media rewritten to a token for this subscriber");
  assert.ok(f.data.message.sender.avatar.token);
  assert.ok(!s.raw().includes("mxc://"), "no mxc ever on the wire");
  await s.close();
});

test("a live batch keeps the window warm: the next GET /messages serves from cache and includes the new message", async () => {
  const { threadId, deps: live } = setup();
  const tid = await threadId;
  const page = async () => (await (await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() })).json()) as { messages: Array<{ id: string; body: { plain: string } | null; reactions: Array<{ key: string }>; redacted: boolean }> };
  const first = await page();
  assert.deepEqual(first.messages.map((m) => m.id), ["$intro", "$hello"]);
  assert.equal(readerCalls, 1);
  await handleLiveBatch(live, {
    roomId: ROOM, noteId: NOTE.id,
    events: [
      ev("$new", 21, ALEX, "m.room.message", { msgtype: "m.text", body: "a live one" }),
      ev("$rx", 22, ME, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$hello", key: "🎉" } }),
      ev("$ed", 23, ME, "m.room.message", { msgtype: "m.text", body: "* hi Alex!", "m.new_content": { msgtype: "m.text", body: "hi Alex!" }, "m.relates_to": { rel_type: "m.replace", event_id: "$intro" } }),
    ],
  });
  const kinds = db.prepare(`SELECT kind, json_extract(payload_json, '$.message.id') AS mid FROM comms_events WHERE thread_id = ? AND kind != 'thread.updated' ORDER BY id`).all(tid);
  assert.deepEqual(kinds, [
    { kind: "message.created", mid: "$new" },
    { kind: "reaction.changed", mid: "$hello" },
    { kind: "message.updated", mid: "$intro" },
  ]);
  readerCalls = 0;
  const second = await page();
  assert.equal(readerCalls, 0, "served from the window cache — no source read");
  assert.deepEqual(second.messages.map((m) => m.id), ["$intro", "$hello", "$new"]);
  assert.equal(second.messages[1]!.reactions[0]!.key, "🎉");
  assert.equal(second.messages[0]!.body!.plain, "hi Alex!");
  // A redaction of a cached message → message.deleted, and the window stays warm.
  await handleLiveBatch(live, { roomId: ROOM, noteId: NOTE.id, events: [ev("$red", 24, ALEX, "m.room.redaction", { redacts: "$new" }, { redacts: "$new" })] });
  const last = db.prepare(`SELECT kind, json_extract(payload_json, '$.message.id') AS mid, json_extract(payload_json, '$.message.redacted') AS r FROM comms_events WHERE thread_id = ? AND kind != 'thread.updated' ORDER BY id DESC LIMIT 1`).get(tid);
  assert.deepEqual(last, { kind: "message.deleted", mid: "$new", r: 1 });
  const third = await page();
  assert.equal(readerCalls, 0, "still served from the cache");
  assert.equal(third.messages[2]!.redacted, true);
  // A truncated (limited) timeline cannot be merged: the window goes stale and is refetched.
  await handleLiveBatch(live, { roomId: ROOM, noteId: NOTE.id, limited: true, events: [ev("$tail", 30, ALEX, "m.room.message", { msgtype: "m.text", body: "after a gap" })] });
  await page();
  assert.equal(readerCalls, 1, "a gap invalidates the window");
});

test("a failed live batch marks the window stale (never a silently current cache)", async () => {
  const { threadId, deps } = setup();
  const tid = await threadId;
  await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() });
  const broken: LiveDeps = { ...deps, project: { ...deps.project, reader: { whoami: async () => { throw new Error("down"); }, roomState: async () => [] as never, memberProfiles: async () => PROFILES } } };
  await handleLiveBatch(broken, { roomId: ROOM, events: [ev("$x", 40, ALEX, "m.room.message", { msgtype: "m.text", body: "x" })] });
  readerCalls = 0;
  await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() });
  assert.equal(readerCalls, 1);
});

test("stream resumes from Last-Event-ID", async () => {
  const a = appendEvent("thread.updated", "th_1", { threadId: "th_1" });
  const b = appendEvent("thread.updated", "th_2", { threadId: "th_2" });
  const c = appendEvent("message.created", "th_2", { threadId: "th_2", message: null });
  const s = await openStream(ownerHeaders({ "Last-Event-ID": String(a) }));
  await until(() => s.frames().length >= 2, "replayed frames");
  assert.deepEqual(s.frames().map((f) => [Number(f.id), f.event, f.data.threadId]), [[b, "thread.updated", "th_2"], [c, "message.created", "th_2"]]);
  // …then live
  const d = appendEvent("thread.updated", null, {});
  await until(() => s.frames().length >= 3, "live frame");
  assert.deepEqual(s.frames()[2], { id: String(d), event: "thread.updated", data: { threadId: null } });
  assert.match(s.raw(), /^: connected\n\n/);
  // exact frame format
  assert.ok(s.raw().includes(`id: ${b}\nevent: thread.updated\ndata: {"threadId":"th_2"}\n\n`));
  await s.close();
});

test("stale Last-Event-ID → reset", async () => {
  const old = appendEvent("thread.updated", "th_1", { threadId: "th_1" });
  appendEvent("thread.updated", "th_1", { threadId: "th_1" });
  db.prepare(`UPDATE comms_events SET at = ? WHERE id = ?`).run(Date.now() - EVENT_RETENTION_MS - 1000, old);
  const keep = appendEvent("thread.updated", "th_3", { threadId: "th_3" });
  db.prepare(`UPDATE comms_events SET at = ? WHERE id = ?`).run(Date.now() - EVENT_RETENTION_MS - 1000, old + 1);
  assert.equal(pruneEvents(), 2);
  for (const raw of [String(old), "not-a-number", String(keep + 1000)]) {
    const s = await openStream(ownerHeaders({ "Last-Event-ID": raw }));
    await until(() => s.frames().length >= 1, "reset frame");
    assert.deepEqual(s.frames()[0], { id: String(keep), event: "reset", data: { threadId: null } }, raw);
    assert.equal(s.frames().length, 1, "after a reset only live events follow");
    await s.close();
  }
  // Just below the oldest retained event is NOT stale: it resumes.
  const s = await openStream(ownerHeaders({ "Last-Event-ID": String(keep - 1) }));
  await until(() => s.frames().length >= 1, "resumed frame");
  assert.equal(s.frames()[0]!.event, "thread.updated");
  await s.close();
});

test("stream refuses non-owner", async () => {
  const stranger = await createApp().request("/api/comms/stream", { headers: { cookie: sessionCookie(makeSession("stranger@test.local")) } });
  assert.equal(stranger.status, 403);
  const anon = await createApp().request("/api/comms/stream");
  assert.equal(anon.status, 403);
  process.env.COMMS_ENABLED = "false";
  assert.equal((await createApp().request("/api/comms/stream", { headers: ownerHeaders() })).status, 404);
  assert.equal(commsStreamCount(), 0);
});

test("heartbeat every pingMs, and a disconnect leaves no subscriber or timer behind", async () => {
  setCommsStreamTuningForTests({ pingMs: 5 });
  const listenersBefore = commsEventListenerCount();
  const s = await openStream();
  await until(() => s.raw().includes(": ping\n\n"), "heartbeat comment");
  assert.equal(commsStreamCount(), 1);
  assert.equal(commsEventListenerCount(), listenersBefore + 1);
  await s.close();
  await until(() => commsStreamCount() === 0, "stream closed");
  assert.equal(commsEventListenerCount(), listenersBefore);
  // max age closes it too (the client resumes with Last-Event-ID)
  setCommsStreamTuningForTests({ maxAgeMs: 5 });
  const t = await openStream();
  await until(() => commsStreamCount() === 0, "max-age close");
  assert.equal(commsEventListenerCount(), listenersBefore);
  await t.close();
});

test("stream connections are capped per server", async () => {
  setCommsStreamTuningForTests({ maxStreams: 1 });
  const a = await openStream();
  const b = await createApp().request("/api/comms/stream", { headers: ownerHeaders() });
  assert.equal(b.status, 429);
  await a.close();
  await until(() => commsStreamCount() === 0, "closed");
});

// ── fix round 1 ──────────────────────────────────────────────────────────────

test("long-poll on + an empty / ephemeral-only sync → zero vault listings, cursor still saved", async () => {
  process.env.COMMS_SYNC_LONGPOLL = "true";
  const v = recordingVault([]);
  let listings = 0;
  const vault: IngestVault = { ...v.vault, listNotes: async (o) => { listings++; return v.vault.listNotes(o); } };
  const published: unknown[] = [];
  const unsub = commsBus.subscribe((b) => published.push(b));
  const responses = [
    { next_batch: "s_e1", rooms: { join: { "!q:hs": { ephemeral: { events: [{ type: "m.typing", content: { user_ids: [ALEX] } }] } } } } },
    { next_batch: "s_e2" },
    // relations only: announced to the live bus, still no listing
    { next_batch: "s_e3", rooms: { join: { "!q:hs": { timeline: { events: [{ type: "m.reaction", sender: ALEX, event_id: "$rq", origin_server_ts: 5, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } } }] } } } } },
  ];
  let i = 0;
  const client = { sync: async () => parseSync(responses[i++] as Parameters<typeof parseSync>[0]) };
  const entry = getVaultRegistry()[0]!;
  for (let n = 0; n < responses.length; n++) await sched.runMatrixOnce(entry, { client, vault });
  unsub();
  assert.equal(listings, 0, "a quiet long-poll pass touches no vault listing");
  assert.equal((await import("../src/db")).getWorkerCursor(entry.id, "matrix"), "s_e3");
  assert.deepEqual((published as Array<{ roomId: string; noteId?: string }>).map((b) => [b.roomId, b.noteId]), [["!q:hs", undefined]]);
  // flag off: the same empty sync takes the ordinary path (unchanged behaviour)
  delete process.env.COMMS_SYNC_LONGPOLL;
  i = 1;
  await sched.runMatrixOnce(entry, { client, vault });
  assert.ok(listings > 0);
});

test("the long-poll /sync filter drops ephemeral, presence and account data; the plain one is unchanged", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => { urls.push(decodeURIComponent(String(u))); return new Response(JSON.stringify({ next_batch: "x" })); }) as unknown as typeof fetch;
  const { MatrixClient } = await import("../src/worker/matrix");
  const c = new MatrixClient({ homeserver: "https://hs.example.test", accessToken: "t" }, fetchImpl, 1000);
  await c.sync("s1");
  await c.sync("s1", 30_000);
  assert.ok(urls[0]!.includes('filter={"room":{"timeline":{"limit":30}}}&timeout=0'));
  const f = JSON.parse(urls[1]!.match(/filter=(\{.*\})&timeout=30000/)![1]!);
  assert.deepEqual(f, { room: { timeline: { limit: 30 }, ephemeral: { types: [] }, account_data: { types: [] } }, presence: { types: [] }, account_data: { types: [] } });
});

test("B1: after a room's vault write fails, message.created / reaction.changed / message.updated still reach the stream", async () => {
  const { threadId } = setup();
  const tid = await threadId;
  startCommsLive();
  const page = async () => (await (await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() })).json()) as { messages: Array<{ id: string; body: { plain: string } | null; reactions: Array<{ key: string }> }> };
  await page(); // the client has the conversation open: the window is warm
  assert.equal(readerCalls, 1);
  const s = await openStream();
  let failNext = true;
  const notes = new Map([[NOTE.id, { ...structuredClone(NOTE), content: "# Alex — whatsapp\n\n[2026-09-21 00:00] Alex: hello" }]]);
  const vault: IngestVault = {
    async listNotes() { return [...notes.values()].map((n) => structuredClone(n)); },
    async getNote(id) { return structuredClone(notes.get(id)!); },
    async createNote() { throw new Error("unexpected create"); },
    async updateNote(id, p) {
      if (failNext) { failNext = false; throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
      const cur = notes.get(id)!;
      notes.set(id, { ...cur, content: p.content ?? cur.content, metadata: { ...(cur.metadata ?? {}), ...(p.metadata ?? {}) }, updatedAt: `${cur.updatedAt}x` });
      return structuredClone(notes.get(id)!);
    },
    async removeTags() {},
  };
  const syncWith = (n: number, events: unknown[]) => async () => parseSync({ next_batch: `s${n}`, rooms: { join: { [ROOM]: { timeline: { events } } } } } as Parameters<typeof parseSync>[0]);
  const pub = (b: Parameters<typeof commsBus.publish>[0]) => commsBus.publish(b);
  // 1. a new message whose vault write is refused (the e2e vault flake)
  const r1 = await ingestMatrix({ sync: syncWith(50, [{ type: "m.room.message", sender: ALEX, event_id: "$lost", origin_server_ts: ts(50), content: { msgtype: "m.text", body: "the write of this one failed" } }]) }, vault, { publish: pub });
  assert.deepEqual(r1.failedRooms, [ROOM]);
  await liveSettled();
  // 2. a reaction to it, then 3. an edit of it (relations only: no vault write needed)
  await ingestMatrix({ sync: syncWith(51, [{ type: "m.reaction", sender: ALEX, event_id: "$rx", origin_server_ts: ts(51), content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$lost", key: "🔥" } } }]) }, vault, { publish: pub });
  await liveSettled();
  await ingestMatrix({ sync: syncWith(52, [{ type: "m.room.message", sender: ALEX, event_id: "$ed", origin_server_ts: ts(52), content: { msgtype: "m.text", body: "* fixed", "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$lost" } } }]) }, vault, { publish: pub });
  await liveSettled();
  await until(() => s.frames().filter((f) => f.event !== "thread.updated").length >= 3, "three message frames");
  const frames = s.frames().filter((f) => f.event !== "thread.updated").map((f) => [f.event, f.data.message?.id]);
  assert.deepEqual(frames, [["message.created", "$lost"], ["reaction.changed", "$lost"], ["message.updated", "$lost"]]);
  // The window stayed warm and correct (a later GET needs no source read).
  readerCalls = 0;
  const after = await page();
  assert.equal(readerCalls, 0, "served from the warm window");
  const lost = after.messages.find((m) => m.id === "$lost")!;
  assert.equal(lost.body!.plain, "fixed");
  assert.deepEqual(lost.reactions.map((r) => r.key), ["🔥"]);
  await s.close();
});

test("a truncated batch the pass could not gap-fill still invalidates the window (no merge into a hole)", async () => {
  const { threadId, deps } = setup();
  const tid = await threadId;
  await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() });
  await handleLiveBatch(deps, { roomId: ROOM, events: [ev("$t", 60, ALEX, "m.room.message", { msgtype: "m.text", body: "tail" })], limited: true, stale: true });
  const created = db.prepare(`SELECT COUNT(*) n FROM comms_events WHERE thread_id = ? AND kind = 'message.created'`).get(tid) as { n: number };
  assert.equal(created.n, 1, "the tail is still announced");
  readerCalls = 0;
  await createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() });
  assert.equal(readerCalls, 1, "the window was refetched");
});

test("two batches queued for one room are handled as one: one projection, one profile read", async () => {
  const { threadId, deps } = setup();
  await threadId;
  let roomState = 0, profiles = 0, getNote = 0;
  const counted: LiveDeps = {
    getNote: async (id) => { getNote++; return deps.getNote(id); },
    project: { ...deps.project, reader: {
      whoami: async () => ME,
      roomState: async () => { roomState++; return [] as never; },
      memberProfiles: async () => { profiles++; return PROFILES; },
    } },
  };
  setLiveDepsForTests(async () => counted);
  startCommsLive();
  commsBus.publish({ roomId: ROOM, noteId: NOTE.id, events: [ev("$q1", 60, ALEX, "m.room.message", { msgtype: "m.text", body: "one" })] });
  commsBus.publish({ roomId: ROOM, noteId: NOTE.id, events: [ev("$q2", 61, ALEX, "m.room.message", { msgtype: "m.text", body: "two" })] });
  await liveSettled();
  assert.deepEqual({ roomState, profiles, getNote }, { roomState: 1, profiles: 1, getNote: 1 });
  const created = db.prepare(`SELECT json_extract(payload_json, '$.message.id') AS mid FROM comms_events WHERE kind = 'message.created' ORDER BY id`).all();
  assert.deepEqual(created, [{ mid: "$q1" }, { mid: "$q2" }], "both batches' events, in order");
  // Within the cache TTL the next turn re-reads neither (profiles are shared with projectRoom).
  commsBus.publish({ roomId: ROOM, noteId: NOTE.id, events: [ev("$q3", 62, ALEX, "m.room.message", { msgtype: "m.text", body: "three" })] });
  await liveSettled();
  assert.deepEqual({ roomState, profiles }, { roomState: 1, profiles: 1 });
});

// ── final wave I3 ────────────────────────────────────────────────────────────

test("I3: long-poll + MATRIX_AUTO_JOIN + quiet syncs → the invite probe (and its vault pass) runs only on the timer", async () => {
  process.env.COMMS_SYNC_LONGPOLL = "true";
  const cfg = config as unknown as { matrixAutoJoin: boolean };
  const prevAuto = cfg.matrixAutoJoin;
  cfg.matrixAutoJoin = true;
  let now = 1_000_000;
  sched.setInviteProbeClockForTests(() => now);
  try {
    const v = recordingVault([]);
    let listings = 0;
    const vault: IngestVault = { ...v.vault, listNotes: async (o) => { listings++; return v.vault.listNotes(o); } };
    let probes = 0, n = 0;
    const client = {
      sync: async () => parseSync({ next_batch: `s_q${++n}` } as Parameters<typeof parseSync>[0]),
      pendingInvites: async () => { probes++; return []; },
      joinedRooms: async () => [],
    };
    const entry = getVaultRegistry()[0]!;
    const perPass: number[] = [];
    const pass = async () => { const l = listings; await sched.runMatrixOnce(entry, { client, vault }); perPass.push(listings - l); };
    await pass(); // first pass: the probe is due
    for (let i = 0; i < 4; i++) { now += 5_000; await pass(); } // 20 s of quiet long-poll returns
    now += 60_000;
    await pass(); // the timed probe
    await pass();
    assert.equal(probes, 2, "probed on the first pass and once more after 60 s");
    assert.ok(perPass[0]! > 0 && perPass[5]! > 0, "the probe passes take the full path");
    assert.deepEqual([perPass[1], perPass[2], perPass[3], perPass[4], perPass[6]], [0, 0, 0, 0, 0], "every other quiet pass lists nothing");
  } finally {
    cfg.matrixAutoJoin = prevAuto;
    sched.setInviteProbeClockForTests(null);
    delete process.env.COMMS_SYNC_LONGPOLL;
  }
});

test("B2: after a live edit of the latest message the thread preview shows the edited text, not the '* …' fallback", async () => {
  const { threadId, deps } = setup();
  const tid = await threadId;
  // The vault ingest stores the m.replace fallback body as the latest line (unchanged vault behaviour).
  const edited: Note = { ...structuredClone(NOTE), metadata: { ...NOTE.metadata, lastMessageAt: ts(70), lastMessageText: "* hello (edited live)", lastMessageEventId: "$edit1", lastMessageSender: ALEX } };
  const live: LiveDeps = { ...deps, getNote: async () => structuredClone(edited) };
  await handleLiveBatch(live, {
    roomId: ROOM, noteId: NOTE.id,
    events: [ev("$edit1", 70, ALEX, "m.room.message", { msgtype: "m.text", body: "* hello (edited live)", "m.new_content": { msgtype: "m.text", body: "hello (edited live)" }, "m.relates_to": { rel_type: "m.replace", event_id: "$hello" } })],
  });
  const list = (await (await createApp().request("/api/comms/threads?folder=unknown", { headers: ownerHeaders() })).json()) as { threads: Array<{ id: string; lastMessage: { text: string } }> };
  assert.equal(list.threads.find((t) => t.id === tid)!.lastMessage.text, "hello (edited live)");
  // A rebuild/projection later (the vault still says "* …") keeps the edited text …
  await projectRoom(deps.project, ROOM, edited);
  const again = (await (await createApp().request("/api/comms/threads?folder=unknown", { headers: ownerHeaders() })).json()) as { threads: Array<{ id: string; lastMessage: { text: string } }> };
  assert.equal(again.threads.find((t) => t.id === tid)!.lastMessage.text, "hello (edited live)");
  // … until a newer message is the latest.
  await projectRoom(deps.project, ROOM, { ...edited, metadata: { ...edited.metadata, lastMessageAt: ts(71), lastMessageText: "* a real bullet", lastMessageEventId: "$m2" } });
  const newer = (await (await createApp().request("/api/comms/threads?folder=unknown", { headers: ownerHeaders() })).json()) as { threads: Array<{ id: string; lastMessage: { text: string } }> };
  assert.equal(newer.threads.find((t) => t.id === tid)!.lastMessage.text, "* a real bullet");
});

test("M1: cached windows expire without events and are all stale after a restart", async () => {
  const { threadId, deps } = setup();
  const tid = await threadId;
  let now = 5_000_000;
  setTimelineClockForTests(() => now);
  try {
    const get = () => createApp().request(`/api/comms/threads/${tid}/messages`, { headers: ownerHeaders() });
    await get();
    assert.equal(readerCalls, 1);
    now += WINDOW_MAX_AGE_MS; // the last millisecond of its life: still served warm
    await get();
    assert.equal(readerCalls, 1, "young window served from cache");
    now += 1;
    await get();
    assert.equal(readerCalls, 2, "an expired window is refetched");
    // A live merge confirms the window: its age restarts.
    now += WINDOW_MAX_AGE_MS - 10;
    await handleLiveBatch(deps, { roomId: ROOM, noteId: NOTE.id, events: [ev("$m1", 80, ALEX, "m.room.message", { msgtype: "m.text", body: "keeps it warm" })] });
    now += 20;
    await get();
    assert.equal(readerCalls, 2, "kept warm by the live merge");
    // Startup marks every window stale (the background rebuild is held so it touches nothing).
    let release!: () => void;
    startRebuild(() => new Promise((r) => { release = () => r(null); }));
    startCommsProjection();
    stopCommsLive();
    release();
    await get();
    assert.equal(readerCalls, 3, "refetched after the restart");
  } finally {
    setTimelineClockForTests(null);
  }
});

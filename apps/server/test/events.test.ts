/**
 * WP7.2 invalidation channel: GET /api/events (SSE), fed by the tree projection's
 * single vault subscribe socket + gateway write-through.
 * Invariants: ids only; per-actor view filtering (an unviewable note's id never
 * appears, incl. private notes); remove only if previously viewable; write-through
 * emits; resync on snapshot replace and on buffer overflow; per-user/global caps;
 * anon refused; capability links view-scoped.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests, setTreeSocketFactory, type TreeSocket } from "../src/tree";
import { eventConnections } from "../src/events";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class FakeSocket implements TreeSocket {
  onopen: TreeSocket["onopen"] = null;
  onmessage: TreeSocket["onmessage"] = null;
  onclose: TreeSocket["onclose"] = null;
  onerror: TreeSocket["onerror"] = null;
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.onclose?.();
  }
  frame(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}
let socks: FakeSocket[] = [];

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  fv = installFakeVault();
  socks = [];
  setTreeSocketFactory((url) => {
    const s = new FakeSocket(url);
    socks.push(s);
    return s;
  });
  process.env.TREE_SUBSCRIBE = "1";
  process.env.EVENTS_PING_MS = "50";
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
  process.env.TREE_SUBSCRIBE = "0";
  for (const k of ["EVENTS_BUFFER", "EVENTS_MAX_PER_USER", "EVENTS_MAX_TOTAL", "EVENTS_PING_MS"]) delete process.env[k];
});

const snap = (...notes: Array<Record<string, unknown>>) => ({ type: "snapshot", notes, done: true });
const note = (id: string, tags: string[], metadata: Record<string, unknown> = {}, updatedAt = "2026-06-01T00:00:00Z") => ({
  id,
  path: `${tags[0] ?? "x"}/${id}.md`,
  tags,
  updatedAt,
  metadata,
});
let ts = 0;
const upsert = (id: string, tags: string[], metadata: Record<string, unknown> = {}) => ({
  type: "upsert",
  note: note(id, tags, metadata, new Date(Date.UTC(2026, 6, 1) + ++ts * 1000).toISOString()),
});

interface Stream {
  res: Response;
  raw: () => string;
  events: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}
/** Open /api/events and accumulate what arrives. The snapshot socket is fed first. */
async function open(cookieOrPath: { cookie?: string; path?: string }, seed = true): Promise<Stream> {
  const headers = new Headers();
  if (cookieOrPath.cookie) headers.set("cookie", cookieOrPath.cookie);
  const p = api.request(cookieOrPath.path ?? "/events", { headers });
  if (seed) {
    for (let i = 0; i < 100 && socks.length === 0; i++) await tick(5);
    if (socks[0] && !(socks[0] as unknown as { seeded?: boolean }).seeded) {
      (socks[0] as unknown as { seeded?: boolean }).seeded = true;
      socks[0].onopen?.();
      socks[0].frame(
        snap(
          note("pub", ["proj"]),
          note("hidden", ["secret", "exec"]),
          note("mine", ["secret"]),
          note("priv", ["proj"], { prism_visibility: "private", prism_creator: "someone@else" }),
        ),
      );
    }
  }
  const res = await p;
  if (res.status !== 200 || !res.body) return { res, raw: () => "", events: () => [], close: async () => {} };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
      }
    } catch {
      /* cancelled */
    }
  })();
  return {
    res,
    raw: () => buf,
    events: () =>
      buf
        .split("\n\n")
        .map((f) => f.split("\n").find((l) => l.startsWith("data:")))
        .filter((l): l is string => !!l)
        .map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>)
        .filter((e) => e.type),
    close: async () => {
      await reader.cancel().catch(() => {});
      await tick();
    },
  };
}
const ownerCookie = () => sessionCookie(makeSession(OWNER));

test("anon is refused (401); a signed-in user with no grants gets a stream but no ids", async () => {
  const anon = await open({}, false);
  assert.equal(anon.res.status, 401);
  const s = await open({ cookie: sessionCookie(makeSession("nobody@x.test")) });
  assert.equal(s.res.status, 200);
  socks[0]!.frame(upsert("pub", ["proj"]));
  socks[0]!.frame(upsert("hidden", ["secret"]));
  await tick();
  assert.deepEqual(s.events(), []);
  await s.close();
});

test("non-owner: only viewable ids, ids only; private + ungranted notes never appear", async () => {
  grantUser("v@x.test", "tag", "proj", "view");
  grantUser("v@x.test", "note", "mine", "view");
  const s = await open({ cookie: sessionCookie(makeSession("v@x.test")) });
  const k = socks[0]!;
  k.frame(upsert("hidden", ["secret", "exec"]));
  k.frame(upsert("priv", ["proj"], { prism_visibility: "private", prism_creator: "someone@else" }));
  k.frame(upsert("pub", ["proj"]));
  k.frame({ type: "remove", id: "hidden" }); // never viewable → nothing
  k.frame({ type: "remove", id: "priv" }); // private to someone else → nothing
  k.frame(upsert("brandnew", ["secret"])); // ungranted create → nothing
  await tick();
  assert.deepEqual(s.events(), [{ type: "note", id: "pub", op: "upsert" }]);
  for (const id of ["hidden", "priv", "brandnew", "secret", "exec", "someone@else"]) assert.ok(!s.raw().includes(id), `leaked ${id}`);
  assert.ok(!s.raw().includes("path") && !s.raw().includes("tags") && !s.raw().includes("content"));

  // Becoming hidden / becoming visible are both visible transitions (old OR new state).
  k.frame(upsert("pub", ["secret"])); // was viewable → client may hold it → emit
  k.frame(upsert("hidden", ["proj"])); // now viewable → emit
  // Removal is emitted only because it was viewable just before the delete.
  k.frame({ type: "remove", id: "hidden" });
  await tick();
  assert.deepEqual(s.events().slice(1), [
    { type: "note", id: "pub", op: "upsert" },
    { type: "note", id: "hidden", op: "upsert" },
    { type: "note", id: "hidden", op: "remove" },
  ]);
  await s.close();
});

test("owner sees every note event; resync on snapshot replace; heartbeat ping", async () => {
  const s = await open({ cookie: ownerCookie() });
  const k = socks[0]!;
  k.frame(upsert("hidden", ["secret"]));
  k.frame({ type: "remove", id: "priv" });
  await tick(120);
  assert.deepEqual(s.events(), [
    { type: "note", id: "hidden", op: "upsert" },
    { type: "note", id: "priv", op: "remove" },
  ]);
  assert.ok(s.raw().includes(": ping"));
  k.frame(snap(note("x", [])));
  await tick();
  assert.deepEqual(s.events().at(-1), { type: "resync" });
  await s.close();
});

test("gateway write-through emits (owner passthrough + non-owner create/patch/delete)", async () => {
  process.env.TREE_SUBSCRIBE = "0"; // lean-list build; events come from write-through only
  fv.put({ id: "p1", path: "proj/one.md", content: "1", tags: ["proj"] });
  fv.put({ id: "projpage", path: "proj", content: "page", tags: ["proj"] }); // the parent page a member create needs
  grantUser("m@x.test", "tag", "proj", "own");
  const owner = await open({ cookie: ownerCookie() }, false);
  const member = await open({ cookie: sessionCookie(makeSession("m@x.test")) }, false);
  const mc = sessionCookie(makeSession("m@x.test"));
  const created = (await (
    await api.request("/notes", { method: "POST", headers: { cookie: mc }, body: JSON.stringify({ content: "c", path: "proj/two.md", tags: ["proj"] }) })
  ).json()) as { id: string };
  await api.request("/notes/p1", { method: "PATCH", headers: { cookie: mc }, body: JSON.stringify({ content: "edited" }) });
  await api.request("/notes/p1", { method: "DELETE", headers: { cookie: mc } });
  await tick();
  const want = [
    { type: "note", id: created.id, op: "upsert" },
    { type: "note", id: "p1", op: "upsert" },
    { type: "note", id: "p1", op: "remove" },
  ];
  assert.deepEqual(member.events(), want);
  assert.deepEqual(owner.events(), want);
  await owner.close();
  await member.close();
});

test("slow client: buffer overflow degrades to a single resync", async () => {
  process.env.EVENTS_BUFFER = "3";
  const s = await open({ cookie: ownerCookie() });
  const k = socks[0]!;
  for (let i = 0; i < 40; i++) k.frame(upsert(`n${i}`, ["proj"])); // one synchronous burst
  await tick(60);
  const ev = s.events();
  assert.ok(ev.some((e) => e.type === "resync"), "overflow → resync");
  assert.ok(ev.length <= 4, `bounded (${ev.length})`);
  await s.close();
});

test("connection caps: per principal and global; released on disconnect", async () => {
  process.env.EVENTS_MAX_PER_USER = "2";
  process.env.EVENTS_MAX_TOTAL = "3";
  const c1 = ownerCookie();
  const a = await open({ cookie: c1 });
  const b = await open({ cookie: c1 });
  const over = await open({ cookie: c1 }, false);
  assert.equal(over.res.status, 429);
  assert.equal(eventConnections().total, 2);
  await a.close();
  assert.equal(eventConnections().total, 1);
  const again = await open({ cookie: c1 }, false);
  assert.equal(again.res.status, 200);
  grantUser("v@x.test", "tag", "proj", "view");
  const v = await open({ cookie: sessionCookie(makeSession("v@x.test")) }, false);
  assert.equal(v.res.status, 200);
  const w = await open({ cookie: sessionCookie(makeSession("w@x.test")) }, false);
  assert.equal(w.res.status, 429, "global cap (3) reached");
  await v.close();
  await b.close();
  await again.close();
  assert.equal(eventConnections().total, 0);
});

test("capability link: view-scoped to its note", async () => {
  const t = makeCapability("note", "mine", "view");
  const s = await open({ path: `/events?t=${encodeURIComponent(t)}` });
  const k = socks[0]!;
  k.frame(upsert("pub", ["proj"]));
  k.frame(upsert("mine", ["secret"]));
  await tick();
  assert.deepEqual(s.events(), [{ type: "note", id: "mine", op: "upsert" }]);
  await s.close();
});

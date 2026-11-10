/**
 * The vault door (src/vault-door.ts): Parachute 0.9.1's `/api/records` beside 0.8's
 * `/api/notes`. Two promises are under test:
 *   1. On a vault without the record door, every request is the one Prism sent
 *      before (one probe aside), byte for byte, and every answer is passed on as is.
 *   2. On a vault with it, Prism's note-shaped requests leave in record words
 *      (SPEC v2 §2.1: body, fields, records, types apart from tags) and the answers
 *      come back in note shape, `types` kept beside `tags`.
 * The record door here is a fake written from the SPEC's table, not from
 * vault-door.ts: it REFUSES note words and a type's name in `tags`, as the spec
 * says the record door does, so a leak fails the test instead of passing quietly.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { vaultClient } from "../src/parachute";
import { config } from "../src/config";
import { doorPath, doorSearch, fromRecordsBody, resetVaultDoors, toRecordItem, vaultDoor } from "../src/vault-door";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault, type VaultCall } from "./helpers";

const OWNER = "owner@test.local";
const setDoor = (m: string) => Object.assign(config as Record<string, unknown>, { vaultDoor: m });
const ownerReq = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("cookie", sessionCookie(makeSession(OWNER)));
  return api.request(path, { ...init, headers });
};

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetVaultDoors();
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  setDoor("notes");
  resetVaultDoors();
});

// ---------------------------------------------------------------- the words

test("door words: only note routes move, and only their two renamed parameters", () => {
  assert.equal(doorPath("records", "/notes"), "/records");
  assert.equal(doorPath("records", "/notes/a%2Fb/versions/3"), "/records/a%2Fb/versions/3");
  assert.equal(doorPath("records", "/notesy"), "/notesy");
  assert.equal(doorPath("records", "/tags/meeting"), "/tags/meeting");
  assert.equal(doorPath("notes", "/notes/x"), "/notes/x");
  assert.equal(doorSearch("records", "?include_content=false&include_metadata=a,b&tag=task&tag=x"), "?include_body=false&include_fields=a%2Cb&tag=task&tag=x");
  assert.equal(doorSearch("notes", "?include_content=false"), "?include_content=false");
});

test("door words: a write in record words — types split from tags, a person's own field names untouched", () => {
  const types = new Set(["meeting", "task"]);
  assert.deepEqual(toRecordItem({ content: "hi", metadata: { content: "mine", date: "2026-11-10" }, tags: ["meeting", "idea"], path: "M/1", if_exists: "update" }, types), {
    body: "hi",
    fields: { content: "mine", date: "2026-11-10" },
    tags: ["idea"],
    types: ["meeting"],
    path: "M/1",
    if_exists: "update",
  });
  assert.deepEqual(toRecordItem({ tags: { add: ["task", "pinned"], remove: ["meeting"] }, if_updated_at: "t" }, types), {
    tags: { add: ["pinned"], remove: [] },
    types: { add: ["task"], remove: ["meeting"] },
    if_updated_at: "t",
  });
  assert.deepEqual(toRecordItem({ notes: [{ content: "a", tags: ["task"] }, { content: "b" }] }, types), { records: [{ body: "a", tags: [], types: ["task"] }, { body: "b" }] });
});

test("door words: answers in note shape — tags list every name, types kept, history and conflicts too", () => {
  const rec = { id: "r1", body: "hi", fields: { body: "a field called body" }, tags: ["idea"], types: ["meeting"], path: null, createdAt: "c", updatedAt: "u" };
  assert.deepEqual(fromRecordsBody(rec), { id: "r1", content: "hi", metadata: { body: "a field called body" }, tags: ["meeting", "idea"], types: ["meeting"], path: null, createdAt: "c", updatedAt: "u" });
  assert.deepEqual(fromRecordsBody([rec]), [fromRecordsBody(rec)]);
  assert.deepEqual(fromRecordsBody({ records: [rec], created: 1 }), { notes: [fromRecordsBody(rec)], created: 1 });
  assert.deepEqual(fromRecordsBody({ versions: [{ record_id: "r1", version_ix: 0, fields: {}, body_len: 2 }], total: 1 }), {
    versions: [{ note_id: "r1", version_ix: 0, metadata: {}, content_len: 2 }],
    total: 1,
  });
  assert.deepEqual(fromRecordsBody({ error: "conflict", current: rec }), { error: "conflict", current: fromRecordsBody(rec) });
  assert.deepEqual(fromRecordsBody({ ok: true }), { ok: true });
});

// ---------------------------------------------------------------- 0.8: nothing changes

/** The vault calls an owner session and the server client make, minus the probe. */
async function drive(): Promise<Array<Pick<VaultCall, "method" | "path" | "search" | "rawBody" | "authorization">>> {
  fv.put({ id: "n1", content: "one", tags: ["task"], metadata: { status: "open" } });
  const answers: string[] = [];
  answers.push(await (await ownerReq("/notes/n1")).text());
  answers.push(await (await ownerReq("/notes?tag=task&include_content=false&include_metadata=status")).text());
  answers.push(await (await ownerReq("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "two", tags: ["task", "idea"], metadata: { status: "open" } }) })).text());
  answers.push(await (await ownerReq("/notes/n1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "one!", tags: { add: ["idea"] }, force: true }) })).text());
  const v = vaultClient();
  answers.push(JSON.stringify(await v.listNotes({ tags: ["task"], includeMetadata: ["status"] })));
  answers.push(JSON.stringify(await v.updateNote("n1", { metadata: { status: "done" }, tags: { remove: ["idea"] } })));
  driveAnswers = answers;
  return fv.calls
    .filter((c) => !c.path.endsWith("/api/records"))
    .map(({ method, path, search, rawBody, authorization }) => ({ method, path, search, rawBody, authorization }));
}
let driveAnswers: string[] = [];

/** Normalise the per-run stamps the gateway writes (timestamps, generated ids). */
const stable = (s: unknown) => JSON.stringify(s).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>").replace(/new-\d+/g, "new-<n>");

test("a 0.8 vault (no /api/records: 404): auto sends exactly the requests the note door sends, and answers the same", async () => {
  setDoor("notes");
  const pinned = await drive();
  const pinnedAnswers = driveAnswers;

  fv.restore();
  resetDb();
  resetVaultDoors();
  fv = installFakeVault();
  const fake = globalThis.fetch;
  // The real 0.8 vault answers /api/records with 404 {"error":"Not found"} (probed on v0.8.0-pre.1).
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/api/records")) {
      await fake(input, init); // recorded in fv.calls
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return fake(input, init);
  }) as typeof fetch;
  setDoor("auto");
  const auto = await drive();
  assert.equal(stable(auto), stable(pinned));
  assert.equal(stable(driveAnswers), stable(pinnedAnswers));
  assert.equal(fv.calls.filter((c) => c.path.endsWith("/api/records")).length, 1, "one probe, then the answer is remembered");
  assert.equal(await vaultDoor({ url: "http://vault.test", vault: "default", token: "t" }), "notes");
});

test("auto: a probe that cannot decide (500, network) uses the note door and asks again later", async () => {
  setDoor("auto");
  const fake = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/api/records")) {
      probes++;
      if (probes === 1) return new Response("boom", { status: 500 });
      throw new TypeError("fetch failed");
    }
    return fake(input, init);
  }) as typeof fetch;
  fv.put({ id: "n1", content: "one", tags: [] });
  const r = await ownerReq("/notes/n1");
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { content: string }).content, "one");
  assert.ok(fv.calls.some((c) => c.path === "/vault/default/api/notes/n1"));
});

// ---------------------------------------------------------------- 0.9.1: the record door

interface Rec {
  id: string;
  body: string;
  path: string | null;
  fields: Record<string, unknown> | null;
  tags: string[];
  types: string[];
  createdAt: string;
  updatedAt: string;
}

/** A record door per SPEC v2 §2.1/§5.1, strict about its words. */
function installRecordDoor(typeNames: string[]) {
  const recs = new Map<string, Rec>();
  const seen: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  let seq = 0;
  const NOTE_WORDS = ["content", "metadata", "notes", "content_edit", "include_content", "include_metadata"];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = u.pathname.match(/^\/vault\/default\/api(\/.*)$/);
    if (!m) return prev(input, init);
    const sub = m[1]!;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    seen.push({ method, path: sub, search: u.search, body });
    if (sub.startsWith("/notes")) return json({ error: "this test's vault has only the record door" }, 500);
    if (sub === "/types") return json(typeNames.map((name) => ({ name })));
    if (!sub.startsWith("/records")) return prev(input, init);
    for (const k of u.searchParams.keys()) if (NOTE_WORDS.includes(k)) return json({ error: `note word ${k} on the record door` }, 400);
    if (body) for (const k of Object.keys(body)) if (NOTE_WORDS.includes(k)) return json({ error: `note word ${k} on the record door` }, 400);
    const badTag = (names: unknown) => (Array.isArray(names) ? names.find((n) => typeNames.includes(n as string)) : undefined);
    const tagOp = body?.tags as { add?: string[]; remove?: string[] } | string[] | undefined;
    const refused = badTag(Array.isArray(tagOp) ? tagOp : tagOp?.add);
    if (refused) return json({ error: `"${refused}" is a type: use types` }, 400);
    const one = sub.match(/^\/records\/([^/]+)$/);
    const lean = u.searchParams.get("include_body") === "false";
    const out = (r: Rec) => (lean ? { ...r, body: undefined } : r);
    if (sub === "/records" && method === "GET") {
      const tag = u.searchParams.getAll("tag");
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      return json([...recs.values()].filter((r) => tag.every((t) => r.tags.includes(t) || r.types.includes(t))).slice(0, limit).map(out));
    }
    if (sub === "/records" && method === "POST") {
      const id = `r${++seq}`;
      const r: Rec = { id, body: String(body?.body ?? ""), path: (body?.path as string) ?? null, fields: (body?.fields as Record<string, unknown>) ?? null, tags: (body?.tags as string[]) ?? [], types: (body?.types as string[]) ?? [], createdAt: "2026-11-10T00:00:00.000Z", updatedAt: `2026-11-10T00:00:0${seq}.000Z` };
      recs.set(id, r);
      return json(r, 201);
    }
    if (one) {
      const r = recs.get(decodeURIComponent(one[1]!));
      if (!r) return json({ error: "Not found" }, 404);
      if (method === "GET") return json(out(r));
      if (method === "PATCH") {
        if (body?.if_updated_at && body.if_updated_at !== r.updatedAt) return json({ error: "conflict", current: r }, 409);
        if (typeof body?.body === "string") r.body = body.body;
        if (body?.fields) r.fields = { ...(r.fields ?? {}), ...(body.fields as Record<string, unknown>) };
        const ty = body?.types as { add?: string[]; remove?: string[] } | undefined;
        const tg = body?.tags as { add?: string[]; remove?: string[] } | undefined;
        r.types = [...new Set([...r.types, ...(ty?.add ?? [])])].filter((t) => !(ty?.remove ?? []).includes(t));
        r.tags = [...new Set([...r.tags, ...(tg?.add ?? [])])].filter((t) => !(tg?.remove ?? []).includes(t));
        r.updatedAt = `2026-11-10T00:01:0${++seq}.000Z`;
        return json(r);
      }
    }
    return json({ error: "unhandled in test" }, 500);
  }) as typeof fetch;
  return { recs, seen };
}

test("a vault with the record door: auto finds it; reads come back as notes with types, writes leave in record words", async () => {
  setDoor("auto");
  const door = installRecordDoor(["meeting", "task"]);
  door.recs.set("m1", { id: "m1", body: "agenda", path: "Meetings/m1", fields: { date: "2026-11-10" }, tags: ["idea"], types: ["meeting"], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });

  // Owner passthrough read: the web app gets the note shape it always had, plus `types`.
  const read = (await (await ownerReq("/notes/m1")).json()) as Record<string, unknown>;
  assert.deepEqual(read, { id: "m1", content: "agenda", path: "Meetings/m1", metadata: { date: "2026-11-10" }, tags: ["meeting", "idea"], types: ["meeting"], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.ok(door.seen.some((s) => s.path === "/records/m1"), "read through /api/records");

  // Lean list with the renamed parameter.
  const list = (await (await ownerReq("/notes?tag=meeting&include_content=false")).json()) as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.content, undefined);
  assert.deepEqual(list[0]!.tags, ["meeting", "idea"]);
  assert.ok(door.seen.some((s) => s.path === "/records" && s.search.includes("include_body=false")));

  // Owner create: a type's name travels in `types`, never in `tags` (the door refuses that).
  const created = await ownerReq("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "standup", path: "Meetings/m2", tags: ["meeting", "idea"], metadata: { date: "2026-11-11" } }) });
  assert.equal(created.status, 201, await created.clone().text());
  const sent = door.seen.find((s) => s.method === "POST")!.body as Record<string, unknown>;
  assert.equal(sent.body, "standup");
  assert.deepEqual(sent.tags, ["idea"]);
  assert.deepEqual(sent.types, ["meeting"]);
  assert.equal((sent.fields as Record<string, unknown>).date, "2026-11-11");
  const made = (await created.json()) as Record<string, unknown>;
  assert.equal(made.content, "standup");
  assert.deepEqual(made.tags, ["meeting", "idea"]);

  // The server's own client (workers, ingest): PATCH with tag add/remove, and a conflict.
  const v = vaultClient();
  const upd = await v.updateNote("m1", { content: "agenda v2", tags: { add: ["task"], remove: ["idea"] }, ifUpdatedAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(upd.content, "agenda v2");
  assert.deepEqual(upd.types, ["meeting", "task"]);
  assert.deepEqual(upd.tags, ["meeting", "task"]);
  const patch = door.seen.filter((s) => s.method === "PATCH").at(-1)!.body as Record<string, unknown>;
  assert.deepEqual(patch.types, { add: ["task"] });
  assert.deepEqual(patch.tags, { add: [], remove: ["idea"] });
  await assert.rejects(v.updateNote("m1", { content: "stale", ifUpdatedAt: "2026-11-01T00:00:00.000Z" }), (e: { status: number; body: { current: Record<string, unknown> } }) => {
    assert.equal(e.status, 409);
    assert.equal(e.body.current.content, "agenda v2", "the conflict's current record is a note too");
    return true;
  });
  const listed = await v.listNotes({ tags: ["meeting"] });
  assert.deepEqual(listed.map((n) => n.id).sort(), ["m1", "r1"]);
  assert.ok(!door.seen.some((s) => s.path.startsWith("/notes")), "nothing went to /api/notes");
});

test("auto: a bounded call stays bounded — the probe ends with the caller's own deadline when the vault never answers", async () => {
  setDoor("auto");
  const prev = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) =>
    new Promise((_res, rej) => {
      asked.push(new URL(typeof u === "string" ? u : u instanceof URL ? u.href : u.url).pathname);
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as typeof fetch;
  let guard: NodeJS.Timeout | undefined;
  try {
    // (No duration is asserted: the vault NEVER answers, so finishing at all is the proof.)
    await assert.rejects(
      Promise.race([vaultClient(undefined, { timeoutMs: 100 }).getNote("n1"), new Promise((_r, rej) => (guard = setTimeout(() => rej(new Error("hung on the probe")), 60_000)))]),
      (e: Error) => !/hung on the probe/.test(e.message),
    );
    assert.deepEqual(asked, ["/vault/default/api/records", "/vault/default/api/notes/n1"], "probe, then the note door");
  } finally {
    clearTimeout(guard);
    globalThis.fetch = prev;
  }
});

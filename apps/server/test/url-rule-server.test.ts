/**
 * The URL rule on the SERVER: a URL property holds web addresses for every writer, not
 * only the editors — `POST /api/properties/:id`, `/batch`, and the Prism MCP note tools
 * (`prism_create_note`, `prism_update_note`). The rule is the one shared function
 * (`@prism/core/database` url.ts `checkUrlWrite` + schema.ts `urlPropertyKeys`).
 * Through the REAL gateway app and the real MCP endpoint against the fake vault.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { checkUrlWrite, urlPropertyKeys, type SchemaMap } from "@prism/core/database";
import { createApp } from "../src/app";
import { api } from "../src/routes/api";
import { issuePat } from "../src/auth/pat";
import { ensureUser } from "../src/db";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, resetUrlUndoForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { stopConversionWorkers } from "../src/convert/service";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
import { cpuOf } from "./probe";

// ── the shared rule ──────────────────────────────────────────────────────────

test("checkUrlWrite: normalise or refuse; a clear and a restatement of the stored value always pass", () => {
  assert.deepEqual(checkUrlWrite("example.com/a", null), { ok: true, value: "https://example.com/a" });
  assert.deepEqual(checkUrlWrite(" https://example.com ", "https://old.example"), { ok: true, value: "https://example.com" });
  assert.deepEqual(checkUrlWrite("see the wiki", null), { ok: false });
  assert.deepEqual(checkUrlWrite("javascript:alert(1)", "https://example.com"), { ok: false });
  // Clears.
  for (const clear of [null, undefined, "", []]) assert.equal(checkUrlWrite(clear, "see the wiki").ok, true);
  // Exactly what is stored — even when that is no web address — is not a change.
  assert.deepEqual(checkUrlWrite("see the wiki", "see the wiki"), { ok: true, value: "see the wiki" });
  assert.deepEqual(checkUrlWrite(["a", "b"], ["a", "b"]), { ok: true, value: ["a", "b"] });
  assert.deepEqual(checkUrlWrite("see the wiki ", "see the wiki"), { ok: false }, "a different value is a change");
  // Lists: every entry an address; other shapes refused.
  assert.deepEqual(checkUrlWrite(["example.com", "https://b.example/x"], null), { ok: true, value: ["https://example.com", "https://b.example/x"] });
  assert.deepEqual(checkUrlWrite(["example.com", "nope"], null), { ok: false });
  for (const bad of [5, true, { url: "https://example.com" }]) assert.deepEqual(checkUrlWrite(bad, null), { ok: false });
});

test("checkUrlWrite: work is bounded by the value, not by anything hostile in it", () => {
  const long = `https://example.com/${"a".repeat(100_000)}`;
  const many = Array.from({ length: 5_000 }, () => "example.com");
  const { cpuMs } = cpuOf(() => {
    for (let i = 0; i < 50; i++) { checkUrlWrite(long, null); checkUrlWrite(many, null); checkUrlWrite(`${"a.".repeat(40_000)}!`, null); }
  });
  assert.ok(cpuMs < 2_000, `${Math.round(cpuMs)} ms CPU`);
  assert.deepEqual(checkUrlWrite(many, null), { ok: false }, "a list past the cap is refused, not walked");
});

test("urlPropertyKeys: the kind hint, else the vault type and name; a free key by its stored value — as the page shows it", () => {
  const schemas: SchemaMap = {
    book: { description: null, fields: {
      website: { type: "string" }, // a URL by its name
      source: { type: "string", kind: "url" }, // by the owner's hint
      notes: { type: "string" },
      homepage: { type: "string", kind: "text" }, // named like a URL, shown as text by the owner: not held to the rule
      gone: { type: "string", kind: "url", deleted: true },
    } },
  };
  const stored = { ref: "https://example.com/r", memo: "plain", website: "x" };
  assert.deepEqual(urlPropertyKeys(["book"], schemas, stored, ["website", "source", "notes", "homepage", "gone", "ref", "memo", "fresh", "title", "__proto__", "website"]), ["website", "source", "ref"]);
  // Without the tag the declared keys are free keys: only a stored web address makes one a URL property.
  assert.deepEqual(urlPropertyKeys([], schemas, stored, ["website", "source", "ref"]), ["ref"]);
  assert.deepEqual(urlPropertyKeys(["book"], new Map(Object.entries(schemas)), null, ["source"]), ["source"]);
});

// ── the routes ───────────────────────────────────────────────────────────────

let fv: FakeVault;
let innerFetch: typeof fetch;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  resetUrlUndoForTests();
  fv = installFakeVault();
  app = createApp();
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") {
      return Response.json([{ name: "book", description: "Books", fields: { website: { type: "string" }, source: { type: "string" }, notes: { type: "string" }, members: { type: "array" } } }]);
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
  fv.put({ id: "b1", path: "Books/One", tags: ["book"], content: "BODY", metadata: { title: "One", website: "https://example.com/one", notes: "n", ref: "https://example.com/ref" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  // Values stored before the rule (or by another tool): not web addresses.
  fv.put({ id: "b2", path: "Books/Two", tags: ["book"], content: "", metadata: { title: "Two", website: "see the wiki", source: "ask Sam" }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "b3", path: "Books/Three", tags: ["book"], content: "", metadata: { title: "Three" }, updatedAt: "2026-10-01T12:00:00.000Z" });
});
afterEach(() => {
  setSchemaAdminMinter(null);
  globalThis.fetch = innerFetch;
  fv.restore();
});
after(async () => { await stopConversionWorkers(); });

const OWNER = "owner@test.local";
const MEMBER = "kai@test.local";
const J = { "content-type": "application/json" };
const login = (email: string) => sessionCookie(makeSession(email));
const send = (path: string, body: unknown, cookie = login(OWNER), method = "POST") => {
  const headers = new Headers(J);
  headers.set("cookie", cookie);
  return api.request(path, { method, headers, body: JSON.stringify(body) });
};
const stored = (id: string) => fv.notes.get(id)!.metadata as Record<string, unknown>;
const hintSource = async () => assert.equal((await send("/schemas/book", { ui: { source: { kind: "url" } } }, login(OWNER), "PUT")).status, 200);

test("POST /properties/:id: a URL property takes a web address (normalised) or the write is refused per field — for the owner and a member alike", async () => {
  await hintSource();
  grantUser(MEMBER, "tag", "book", "edit");
  for (const cookie of [login(OWNER), login(MEMBER)]) {
    // By name (`website`), by hint (`source`) and a free key whose stored value is an address (`ref`).
    for (const [key, was] of [["website", "https://example.com/one"], ["source", null], ["ref", "https://example.com/ref"]] as const) {
      for (const bad of ["see the wiki", "javascript:alert(1)", "mailto:a@example.com", "https://user:pw@evil.test/x", 42, true, ["nope"]]) {
        const r = await send("/properties/b1", { set: { [key]: bad }, expect: { [key]: was } }, cookie);
        assert.equal(r.status, 400, `${key} ← ${JSON.stringify(bad)}`);
        const b = (await r.json()) as { error: string; fields: string[]; reason: string };
        assert.equal(b.error, "invalid_url");
        assert.deepEqual(b.fields, [key]);
        assert.match(b.reason, /web address/);
        assert.equal(stored("b1")[key] ?? null, was);
      }
    }
  }
  // Accepted, and stored NORMALISED whoever wrote it.
  const ok = await send("/properties/b1", { set: { website: "example.com/two", source: " https://example.org/s " }, expect: { website: "https://example.com/one" } }, login(MEMBER));
  assert.equal(ok.status, 200);
  assert.equal(stored("b1").website, "https://example.com/two");
  assert.equal(stored("b1").source, "https://example.org/s");
  assert.equal(((await ok.json()) as { metadata: Record<string, unknown> }).metadata.website, "https://example.com/two");
  // One bad field refuses the whole write (nothing half-applied), naming only the bad one.
  const mixed = await send("/properties/b1", { set: { notes: "new", website: "nope" } });
  assert.equal(mixed.status, 400);
  assert.deepEqual(((await mixed.json()) as { fields: string[] }).fields, ["website"]);
  assert.equal(stored("b1").notes, "n");
  // A text property is not held to the rule; a URL property can be cleared.
  assert.equal((await send("/properties/b1", { set: { notes: "see the wiki", website: null } })).status, 200);
  assert.equal(stored("b1").notes, "see the wiki");
  assert.equal("website" in stored("b1") && stored("b1").website !== null, false);
  assert.equal(fv.notes.get("b1")!.content, "BODY");
});

test("an old value that is no web address never blocks another write: leaving it, or sending back exactly what is stored, passes", async () => {
  await hintSource();
  // An unrelated field of the same page.
  assert.equal((await send("/properties/b2", { set: { notes: "hello" } })).status, 200);
  // A whole-form save that restates the bad values beside a real change.
  const r = await send("/properties/b2", { set: { website: "see the wiki", source: "ask Sam", notes: "again" }, expect: { website: "see the wiki" } });
  assert.equal(r.status, 200);
  assert.deepEqual([stored("b2").website, stored("b2").source, stored("b2").notes], ["see the wiki", "ask Sam", "again"]);
  // Changing it to OTHER text that is no address is refused; the old value stays.
  const bad = await send("/properties/b2", { set: { website: "see the handbook" }, expect: { website: "see the wiki" } });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid_url");
  assert.equal(stored("b2").website, "see the wiki");
  // It can be fixed, and it can be cleared.
  assert.equal((await send("/properties/b2", { set: { website: "wiki.example.com" }, expect: { website: "see the wiki" } })).status, 200);
  assert.equal(stored("b2").website, "https://wiki.example.com");
  assert.equal((await send("/properties/b2", { set: { source: null }, expect: { source: "ask Sam" } })).status, 200);
});

test("Undo still works: the value a write replaced may be put back (once it is what was replaced), nothing else", async () => {
  // A person fixes the old text…
  assert.equal((await send("/properties/b2", { set: { website: "https://wiki.example.com" }, expect: { website: "see the wiki" } })).status, 200);
  // …some OTHER text is still refused…
  assert.equal((await send("/properties/b2", { set: { website: "see the handbook" }, expect: { website: "https://wiki.example.com" } })).status, 400);
  // …and Undo puts back exactly what was there (per-field compare-and-set as ever).
  const undo = await send("/properties/b2", { set: { website: "see the wiki" }, expect: { website: "https://wiki.example.com" } });
  assert.equal(undo.status, 200);
  assert.equal(stored("b2").website, "see the wiki");
  // Clearing is undoable too.
  assert.equal((await send("/properties/b2", { set: { website: null }, expect: { website: "see the wiki" } })).status, 200);
  assert.equal((await send("/properties/b2", { set: { website: "see the wiki" }, expect: { website: null } })).status, 200);
  assert.equal(stored("b2").website, "see the wiki");
  // The allowance is for THAT page and field: the same text on another page is refused.
  const other = await send("/properties/b3", { set: { website: "see the wiki" } });
  assert.equal(other.status, 400);
  // …and it is forgotten when the server forgets (a restart): then the rule alone decides.
  assert.equal((await send("/properties/b2", { set: { website: "https://wiki.example.com" }, expect: { website: "see the wiki" } })).status, 200);
  resetUrlUndoForTests();
  assert.equal((await send("/properties/b2", { set: { website: "see the wiki" }, expect: { website: "https://wiki.example.com" } })).status, 400);
});

test("POST /properties/batch (bulk edit and its Undo): each row by the same rule, a refusal never stops the others", async () => {
  const set = await send("/properties/batch", { items: [
    { id: "b1", set: { website: "example.com/shared" }, expect: { website: "https://example.com/one" } },
    { id: "b2", set: { website: "example.com/shared" }, expect: { website: "see the wiki" } },
    { id: "b3", set: { website: "not an address" } },
  ] });
  assert.equal(set.status, 207);
  const rows = ((await set.json()) as { results: Array<{ id: string; ok: boolean; error?: string; fields?: string[] }> }).results;
  assert.deepEqual(rows.map((r) => [r.id, r.ok, r.error ?? null]), [["b1", true, null], ["b2", true, null], ["b3", false, "invalid_url"]]);
  assert.deepEqual(rows[2]!.fields, ["website"]);
  assert.equal(stored("b1").website, "https://example.com/shared");
  assert.equal(stored("b2").website, "https://example.com/shared");
  assert.equal("website" in stored("b3"), false);
  // The bulk bar's Undo: every row back to what it held — including the row that held old text.
  const undo = await send("/properties/batch", { items: [
    { id: "b1", set: { website: "https://example.com/one" }, expect: { website: "https://example.com/shared" } },
    { id: "b2", set: { website: "see the wiki" }, expect: { website: "https://example.com/shared" } },
  ] });
  assert.equal(undo.status, 200);
  assert.equal(stored("b1").website, "https://example.com/one");
  assert.equal(stored("b2").website, "see the wiki");
});

test("the structured route is not a way round it: it only writes lists / objects over a stored list / object, never text into a URL property", async () => {
  await hintSource();
  // A URL property holds one text: there is nothing structured stored, so the route has nothing to compare against.
  const r = await send("/properties/b1/structured", { key: "website", value: [{ url: "nope" }], expect: [{ url: "x" }] });
  assert.equal(r.status, 409);
  assert.equal(stored("b1").website, "https://example.com/one");
  assert.equal((await send("/properties/b1/structured", { key: "website", value: "nope", expect: "https://example.com/one" })).status, 400);
  // And a real structured value on the same page is still edited there (the URL rule reads text, not objects).
  fv.put({ ...fv.notes.get("b1")!, metadata: { ...stored("b1"), members: [{ name: "Ada", site: "not a url" }] } });
  const ok = await send("/properties/b1/structured", { key: "members", value: [{ name: "Ada", site: "still free text" }], expect: [{ name: "Ada", site: "not a url" }] });
  assert.equal(ok.status, 200);
});

// ── the Prism MCP note tools ─────────────────────────────────────────────────

async function agent(email = OWNER): Promise<Client> {
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const token = issuePat({ email, vaultId: "primary", scope: "write" }).token;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = new Headers(req.headers);
    h.set("cf-connecting-ip", ip);
    h.set("x-forwarded-for", ip);
    h.set("authorization", `Bearer ${token}`);
    const u = new URL(req.url);
    return app.request(u.pathname + u.search, { method: req.method, headers: h, body: req.method === "POST" ? await req.text() : undefined });
  };
  const client = new Client({ name: "url-rule", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  // In-process: the URL is only a name for the transport; every request goes to `app.request` above.
  await client.connect(new StreamableHTTPClientTransport(new URL("http://prism.test/mcp"), { fetch: fetchImpl as typeof fetch }));
  return client;
}
const call = async (cl: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; out: any; text: string }> => {
  const r: any = await cl.callTool({ name, arguments: args });
  return { isError: !!r.isError, out: r.structuredContent, text: JSON.stringify(r.structuredContent ?? r.content) };
};

for (const who of ["owner", "member"] as const) {
  test(`MCP prism_update_note (${who}): an agent cannot store text that is no web address in a URL property; a real address is normalised`, async () => {
    await hintSource();
    if (who === "member") { ensureUser(MEMBER); grantUser(MEMBER, "tag", "book", "edit"); }
    const rev = (id: string) => fv.notes.get(id)!.updatedAt;
    const cl = await agent(who === "owner" ? OWNER : MEMBER);
    const patches = fv.calls.filter((c) => c.method === "PATCH").length;
    for (const metadata of [{ website: "see the wiki" }, { source: "javascript:alert(1)" }, { ref: "ask Sam" }, { notes: "fine", website: 7 }]) {
      const r = await call(cl, "prism_update_note", { id: "b1", metadata, if_updated_at: rev("b1") });
      assert.equal(r.isError, true, JSON.stringify(metadata));
      assert.match(r.text, /invalid_url|not a web address/);
      assert.match(r.text, new RegExp(Object.keys(metadata).filter((k) => k !== "notes")[0]!));
    }
    assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, patches, "nothing was written");
    assert.deepEqual([stored("b1").website, stored("b1").ref, stored("b1").notes], ["https://example.com/one", "https://example.com/ref", "n"]);
    // A real address lands, normalised; other keys go through untouched.
    const ok = await call(cl, "prism_update_note", { id: "b1", if_updated_at: rev("b1"), metadata: { website: "example.com/agent", source: "https://example.org/s", notes: "see the wiki" } });
    assert.equal(ok.isError, false, ok.text);
    assert.deepEqual([stored("b1").website, stored("b1").source, stored("b1").notes], ["https://example.com/agent", "https://example.org/s", "see the wiki"]);
    assert.equal(ok.out.metadata.website, "https://example.com/agent");
    // Clearing, and sending back an old stored value beside a real change, both pass.
    assert.equal((await call(cl, "prism_update_note", { id: "b1", if_updated_at: rev("b1"), metadata: { source: null } })).isError, false);
    const restate = await call(cl, "prism_update_note", { id: "b2", if_updated_at: rev("b2"), metadata: { website: "see the wiki", notes: "touched by the agent" } });
    assert.equal(restate.isError, false, restate.text);
    assert.deepEqual([stored("b2").website, stored("b2").notes], ["see the wiki", "touched by the agent"]);
    // A content-only edit of a page that holds old bad values is never refused.
    assert.equal((await call(cl, "prism_update_note", { id: "b2", if_updated_at: rev("b2"), content: "new body" })).isError, false);
    assert.equal(fv.notes.get("b2")!.content, "new body");
  });
}

test("MCP prism_create_note: a new page's URL properties follow the rule; nothing is created when one is refused", async () => {
  await hintSource();
  const cl = await agent();
  const before = fv.notes.size;
  const bad = await call(cl, "prism_create_note", { content: "x", path: "Books/Bad", tags: ["book"], metadata: { title: "Bad", website: "see the wiki", source: "https://example.org/ok" } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /website/);
  assert.doesNotMatch(bad.text, /source:/);
  assert.equal(fv.notes.size, before);
  const ok = await call(cl, "prism_create_note", { content: "x", path: "Books/Good", tags: ["book"], metadata: { title: "Good", website: "example.com/good", source: "https://example.org/ok", notes: "any text" } });
  assert.equal(ok.isError, false, ok.text);
  const made = [...fv.notes.values()].find((n) => n.metadata?.title === "Good")!;
  assert.deepEqual([made.metadata!.website, made.metadata!.source, made.metadata!.notes], ["https://example.com/good", "https://example.org/ok", "any text"]);
  // A page without the tag has no URL properties to hold to the rule.
  const free = await call(cl, "prism_create_note", { content: "x", path: "Misc/Free", tags: ["misc"], metadata: { title: "Free", website: "see the wiki" } });
  assert.equal(free.isError, false, free.text);
});

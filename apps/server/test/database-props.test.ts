/**
 * Property management (NP-DB-11) on the server: renames/retypes/option edits are
 * PRESENTATION hints (the vault tag schema stays additive-only), a "delete" hides
 * the property everywhere, and the only data deletion is the owner-only,
 * dry-run-first `remove-values` job with one CAS write per page.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { listActionAudit } from "../src/actions/store";
import { coerceToKind, resolveProperties } from "@prism/core/database";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

let fv: FakeVault;
let vaultTags: Array<{ name: string; count: number; description: string | null; fields: Record<string, unknown> }>;
let tagPuts: Array<{ tag: string; body: any }>;
let innerFetch: typeof fetch;

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetDatabaseCachesForTests();
  fv = installFakeVault();
  vaultTags = [
    { name: "recipe", count: 4, description: "Recipes", fields: { course: { type: "string", enum: ["starter", "main", "dessert"] }, source_url: { type: "string" }, serves: { type: "number" }, vegan: { type: "boolean" }, labels: { type: "array" }, notes: { type: "string" } } },
    { name: "favourite", count: 1, description: null, fields: { notes: { type: "string" } } },
    { name: "task", count: 1, description: null, fields: { status: { type: "string", enum: ["todo", "done"] }, estimate: { type: "number" } } },
  ];
  tagPuts = [];
  innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = url.pathname.match(/^\/vault\/default\/api\/tags(?:\/([^/]+))?$/);
    if (m && !m[1] && (init?.method ?? "GET") === "GET") return Response.json(vaultTags);
    if (m && m[1] && init?.method === "PUT") {
      const tag = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init.body));
      tagPuts.push({ tag, body });
      const row = vaultTags.find((t) => t.name === tag);
      if (row) Object.assign(row, { description: body.description, fields: body.fields });
      else vaultTags.push({ name: tag, count: 0, description: body.description, fields: body.fields });
      return Response.json({ ok: true });
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
  // One process, one owner: the per-owner limits are tested on their own (L5).
  process.env.SCHEMA_WRITES_PER_MINUTE = "1000000";
  process.env.SCHEMA_REMOVE_PER_MINUTE = "1000000";
  process.env.SCHEMA_CONVERT_PER_MINUTE = "1000000";
});
afterEach(() => {
  setSchemaAdminMinter(null);
  fv.restore();
});

const OWNER = "owner@test.local";
const login = (email: string) => sessionCookie(makeSession(email));
const J = { "content-type": "application/json" };
function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return api.request(path, { ...init, headers });
}
const put = (tag: string, body: unknown, cookie = login(OWNER)) => req(`/schemas/${encodeURIComponent(tag)}`, { method: "PUT", cookie, headers: J, body: JSON.stringify(body) });
const fieldsOf = async (tag: string) => ((await (await req(`/schemas?tags=${tag}`, { cookie: login(OWNER) })).json()) as any).schemas[tag].fields as Record<string, any>;
const remove = (tag: string, field: string, body: unknown, cookie = login(OWNER), headers: Record<string, string> = J) =>
  req(`/schemas/${encodeURIComponent(tag)}/fields/${encodeURIComponent(field)}/remove-values`, { method: "POST", cookie, headers, body: JSON.stringify(body) });

function seed() {
  fv.put({ id: "r1", path: "Recipes/Soup", tags: ["recipe"], content: "SOUP-BODY", metadata: { title: "Soup", course: "starter", notes: "salt", labels: ["quick"] }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "r2", path: "Recipes/Stew", tags: ["recipe"], content: "STEW-BODY", metadata: { title: "Stew", course: "main", notes: "slow", labels: ["quick", "winter"] }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "r3", path: "Recipes/Cake", tags: ["recipe", "favourite"], content: "", metadata: { title: "Cake", course: "dessert", notes: "family recipe" }, updatedAt: "2026-10-01T12:00:00.000Z" });
  fv.put({ id: "r4", path: "Recipes/Old", tags: ["recipe", "prism-trashed"], content: "", metadata: { title: "Old", course: "main", notes: "binned" }, updatedAt: "2026-10-01T13:00:00.000Z" });
  fv.put({ id: "r5", path: "Recipes/Plain", tags: ["recipe"], content: "", metadata: { title: "Plain" }, updatedAt: "2026-10-01T14:00:00.000Z" });
}

test("rename, option rename/recolour/reorder and number format are hints: the vault schema and values never move", async () => {
  seed();
  const r = await put("recipe", { ui: {
    course: { label: "Course of the meal", optionLabels: { main: "Main course" }, colors: { main: "green" }, optionOrder: ["dessert", "main", "starter"], kind: "status", statusGroups: { starter: "todo", dessert: "complete" } },
    serves: { format: "comma" },
  } });
  assert.equal(r.status, 200);
  assert.equal(tagPuts.length, 0, "no vault schema write");
  const f = await fieldsOf("recipe");
  assert.equal(f.course.label, "Course of the meal");
  assert.deepEqual(f.course.enum, ["starter", "main", "dessert"], "stored option values are unchanged");
  assert.deepEqual(f.course.optionLabels, { main: "Main course" });
  assert.deepEqual(f.course.optionOrder, ["dessert", "main", "starter"]);
  assert.deepEqual(f.course.statusGroups, { starter: "todo", dessert: "complete" });
  assert.equal(f.serves.format, "comma");
  assert.equal(fv.notes.get("r2")!.metadata!.course, "main");
  assert.equal(fv.notes.get("r2")!.updatedAt, "2026-10-01T11:00:00.000Z", "no note was written");
  // Clearing a rename restores the stored name; two options cannot share a name.
  assert.equal((await put("recipe", { ui: { course: { optionLabels: {} } } })).status, 200);
  assert.deepEqual((await fieldsOf("recipe")).course.optionLabels, {});
  assert.equal((await put("recipe", { ui: { course: { optionLabels: { main: "Same", dessert: "same" } } } })).status, 400);
  assert.equal((await put("recipe", { ui: { serves: { format: "roman" } } })).status, 400);
  assert.equal((await put("recipe", { ui: { course: { statusGroups: { main: "later" } } } })).status, 400);
});

test("retype: only between presentations of the same vault type; a real type change is refused with a reason", async () => {
  assert.equal((await put("recipe", { ui: { source_url: { kind: "url" } } })).status, 200, "text → url");
  assert.equal((await put("recipe", { ui: { source_url: { kind: "email" } } })).status, 200, "url → email");
  assert.equal((await put("recipe", { ui: { course: { kind: "status" } } })).status, 200, "select → status");
  assert.equal((await put("recipe", { ui: { labels: { kind: "person" } } })).status, 200, "array → person");
  for (const [field, kind] of [["source_url", "number"], ["source_url", "checkbox"], ["source_url", "multi_select"], ["serves", "text"], ["vegan", "select"], ["labels", "select"]] as const) {
    const r = await put("recipe", { ui: { [field]: { kind } } });
    assert.equal(r.status, 409, `${field} → ${kind}`);
    const body = (await r.json()) as any;
    assert.equal(body.error, "incompatible_kind");
    assert.equal(body.field, field);
    assert.match(body.detail, /Stored values are never converted/);
  }
  assert.equal((await fieldsOf("recipe")).source_url.kind, "email", "a refused retype changed nothing");
  // The vault type itself still cannot be changed (the additive rule is untouched).
  assert.equal((await put("recipe", { fields: { serves: { type: "string" } } })).status, 409);
  // A new field is checked against the type it is being created with.
  assert.equal((await put("recipe", { fields: { rating: { type: "number" } }, ui: { rating: { kind: "number" } } })).status, 200);
  assert.equal((await put("recipe", { fields: { oops: { type: "number" } }, ui: { oops: { kind: "url" } } })).status, 409);
  assert.equal(tagPuts.length, 1, "the refused combination wrote nothing to the vault");
});

test("option delete: hidden when unused, refused while a live page still holds it", async () => {
  seed();
  const used = await put("recipe", { ui: { course: { hiddenOptions: ["main"] } } });
  assert.equal(used.status, 409);
  const body = (await used.json()) as any;
  assert.equal(body.error, "option_in_use");
  assert.equal(body.count, 1, "the trashed page does not count");
  assert.equal((await fieldsOf("recipe")).course.hiddenOptions, undefined);
  // Multi-select options too.
  assert.equal((await put("recipe", { ui: { labels: { hiddenOptions: ["winter"] } } })).status, 409);
  // Once no page uses it, it can be hidden; the vault enum keeps it (additive-only).
  fv.put({ ...fv.notes.get("r2")!, metadata: { title: "Stew", course: "starter", notes: "slow", labels: ["quick"] } });
  resetDatabaseCachesForTests();
  assert.equal((await put("recipe", { ui: { course: { hiddenOptions: ["main"] }, labels: { hiddenOptions: ["winter"] } } })).status, 200);
  assert.deepEqual((await fieldsOf("recipe")).course.hiddenOptions, ["main"]);
  assert.deepEqual((await fieldsOf("recipe")).course.enum, ["starter", "main", "dessert"]);
  assert.equal(tagPuts.length, 0);
  // Re-sending an already-hidden option costs no listing and is not re-checked.
  assert.equal((await put("recipe", { ui: { course: { hiddenOptions: ["main"] } } })).status, 200);
  // Bringing it back.
  assert.equal((await put("recipe", { ui: { course: { hiddenOptions: [] } } })).status, 200);
  assert.deepEqual((await fieldsOf("recipe")).course.hiddenOptions, []);
});

test("delete = hide everywhere; values are removed only by the explicit owner job, dry-run first, CAS per page", async () => {
  seed();
  // A visible property's values are never removed.
  const visible = await remove("recipe", "notes", { dryRun: false });
  assert.equal(visible.status, 409);
  assert.equal(((await visible.json()) as any).error, "not_deleted");
  assert.equal(((await (await remove("recipe", "notes", {})).json()) as any).total, 2, "a dry run may preview before the delete");
  assert.equal((await put("recipe", { ui: { notes: { deleted: true } } })).status, 200);
  assert.equal((await fieldsOf("recipe")).notes.deleted, true);
  assert.equal(tagPuts.length, 0, "the vault schema keeps the field");
  assert.equal(fv.notes.get("r1")!.metadata!.notes, "salt", "hiding removes nothing");

  // Dry run is the default: counts only, nothing written.
  const dry = (await (await remove("recipe", "notes", {})).json()) as any;
  assert.deepEqual(dry, { dryRun: true, tag: "recipe", field: "notes", total: 2, skipped: { trashed: 1, shared: 1, system: 0, ingest: 0, private: 0 }, truncated: false });
  assert.equal(fv.notes.get("r1")!.metadata!.notes, "salt");

  // Someone edits r2 between the listing and the write: that page is a conflict, never forced.
  const realFetch = globalThis.fetch;
  let bumped = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!bumped && init?.method === "PATCH" && url.includes("/notes/")) {
      bumped = true;
      fv.put({ ...fv.notes.get("r2")!, content: "STEW-EDITED", updatedAt: "2026-10-02T09:00:00.000Z" });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const run = await remove("recipe", "notes", { dryRun: false });
  globalThis.fetch = realFetch;
  assert.equal(run.status, 200);
  const out = (await run.json()) as any;
  assert.equal(out.dryRun, false);
  assert.equal(out.removed + out.conflicts, 2);
  assert.equal(out.conflicts, 1);
  assert.equal(out.failed, 0);
  assert.equal(out.remaining, 1);
  assert.equal(fv.notes.get("r2")!.metadata!.notes, "slow", "the page that moved keeps its value");
  assert.equal(fv.notes.get("r2")!.content, "STEW-EDITED");
  assert.equal("notes" in fv.notes.get("r1")!.metadata!, false, "removed");
  assert.equal(fv.notes.get("r1")!.content, "SOUP-BODY", "the body is never written");
  assert.equal(fv.notes.get("r1")!.metadata!.course, "starter", "other properties stay");
  assert.equal(fv.notes.get("r3")!.metadata!.notes, "family recipe", "a page whose OTHER tag declares the key is left alone");
  assert.equal(fv.notes.get("r4")!.metadata!.notes, "binned", "trashed pages are not touched");
  // Re-running converges.
  const again = (await (await remove("recipe", "notes", { dryRun: false })).json()) as any;
  assert.equal(again.removed, 1);
  assert.equal(again.remaining, 0);
  assert.equal("notes" in fv.notes.get("r2")!.metadata!, false);
  // Audited with counts and names only.
  const audit = listActionAudit({ action: ["schema.remove-values"] });
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes("salt"), false);
  // Restoring the property shows what is left; nothing comes back by itself.
  assert.equal((await put("recipe", { ui: { notes: { deleted: false } } })).status, 200);
  assert.equal((await remove("recipe", "notes", { dryRun: false })).status, 409);
});

test("remove-values: owner + human + same-origin only; never for system, ingest or shared-key cases", async () => {
  seed();
  await put("recipe", { ui: { notes: { deleted: true } } });
  grantUser("kai@test.local", "tag", "recipe", "edit");
  assert.equal((await remove("recipe", "notes", { dryRun: false }, login("kai@test.local"))).status, 403);
  assert.equal((await remove("recipe", "notes", { dryRun: false }, login(OWNER), { "content-type": "text/plain" })).status, 415);
  assert.equal((await remove("recipe", "notes", { dryRun: false }, login(OWNER), { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await remove("recipe", "notes", { dryRun: false }, login(OWNER), { ...J, origin: "https://evil.example" })).status, 403);
  assert.equal((await req("/schemas/recipe/fields/notes/remove-values", { method: "POST", headers: J, body: "{}" })).status, 403, "anon");
  assert.equal(fv.notes.get("r1")!.metadata!.notes, "salt");
  // Ingest-owned and Prism-managed tags, system and ingest keys.
  await put("task", { ui: { estimate: { deleted: true } } });
  const ingest = await remove("task", "estimate", { dryRun: false });
  assert.equal(ingest.status, 409);
  assert.equal(((await ingest.json()) as any).error, "protected_tag");
  assert.equal((await remove("agent-skill", "notes", {})).status, 403);
  assert.equal((await remove("governance-role", "notes", {})).status, 403);
  for (const key of ["prism_creator", "title", "source_id", "source", "__proto__", "a b"]) assert.equal((await remove("recipe", key, {})).status, 400, key);
  assert.equal((await remove("recipe", "notes", { dryRun: "no" })).status, 400);
  assert.equal((await remove("recipe", "notes", { dryRun: false, limit: 5000 })).status, 400);
});

test("non-owners never see or set the management hints beyond what GET /schemas already shows", async () => {
  seed();
  grantUser("kai@test.local", "tag", "recipe", "edit");
  await put("recipe", { ui: { notes: { deleted: true }, course: { optionLabels: { main: "Main course" } } } });
  const kai = (await (await req("/schemas?tags=recipe", { cookie: login("kai@test.local") })).json()) as any;
  assert.equal(kai.canEdit, false);
  assert.equal(kai.schemas.recipe.fields.notes.deleted, true, "members get the hint so the property is hidden for them too");
  assert.equal((await put("recipe", { ui: { notes: { deleted: false } } }, login("kai@test.local"))).status, 403);
});

test("NP-DB-25: a CSV becomes a new database — a brand-new tag's schema, then typed rows through the import route", async () => {
  const cookie = login(OWNER);
  // 1. The properties of a tag nothing uses yet (what the client sends for the CSV's columns).
  const schema = await put("book", {
    fields: { author: { type: "string" }, pages: { type: "number" }, finished: { type: "boolean" }, genre: { type: "string", enum: ["nature", "fiction"] } },
    ui: { author: { kind: "text", label: "Author" }, pages: { kind: "number", label: "Pages" }, finished: { kind: "checkbox", label: "Finished" }, genre: { kind: "select", label: "Genre" } },
  }, cookie);
  assert.equal(schema.status, 200);
  assert.deepEqual(Object.keys(tagPuts.at(-1)!.body.fields), ["author", "pages", "finished", "genre"]);
  // 2. The rows.
  const csv = ["Title,Author,Pages,Finished,Genre", "Braiding Sweetgrass,Robin Wall Kimmerer,408,yes,nature", "The Overstory,Richard Powers,502,no,fiction", "Bad row,Someone,many,no,fiction"].join("\n");
  const body = { tag: "book", csv, mapping: { Title: "$title", Author: "author", Pages: "pages", Finished: "finished", Genre: "genre" }, pathPrefix: "Library/Reading list" };
  const imp = (dryRun: boolean) => req("/databases/import/csv", { method: "POST", cookie, headers: J, body: JSON.stringify({ ...body, dryRun }) });
  const dry = (await (await imp(true)).json()) as any;
  assert.deepEqual(dry.summary, { create: 2, update: 0, unchanged: 0, error: 1 });
  assert.equal([...fv.notes.values()].filter((n) => n.tags?.includes("book")).length, 0, "the dry run wrote nothing");
  const run = await imp(false);
  assert.ok(run.status === 200 || run.status === 207);
  const out = (await run.json()) as any;
  assert.equal(out.result.created, 2);
  const books = [...fv.notes.values()].filter((n) => n.tags?.includes("book"));
  assert.equal(books.length, 2);
  const sweet = books.find((n) => n.metadata?.title === "Braiding Sweetgrass")!;
  assert.equal(sweet.path, "Library/Reading list/Braiding Sweetgrass");
  assert.deepEqual({ author: sweet.metadata!.author, pages: sweet.metadata!.pages, finished: sweet.metadata!.finished, genre: sweet.metadata!.genre }, { author: "Robin Wall Kimmerer", pages: 408, finished: true, genre: "nature" });
  // Re-running converges instead of duplicating.
  const again = (await (await imp(false)).json()) as any;
  assert.equal(again.result.created, 0);
  assert.equal([...fv.notes.values()].filter((n) => n.tags?.includes("book")).length, 2);
});

// ── review round (M1, L1–L7) ────────────────────────────────────────────────

test("M1: remove-values never touches ingest-owned pages that also carry the tag; the dry run says so", async () => {
  seed();
  fv.put({ id: "e1", path: "vault/messages/email/hello-abcd1234", tags: ["email", "recipe"], content: "", metadata: { title: "Mail", source: "proton-bridge", uid: 41, lastMessageAt: 1700000000000, notes: "from mail" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  fv.put({ id: "m1", path: "vault/meetings/2026-10-01/Sync", tags: ["meeting", "recipe"], content: "", metadata: { title: "Sync", calendarEventId: "ev1", start: "2026-10-01T10:00:00Z", notes: "agenda" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  fv.put({ id: "th1", path: "Chats/Team", tags: ["message-thread", "recipe"], content: "", metadata: { title: "Team", lastMessageAt: 1700000000001, notes: "x" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  fv.put({ id: "s1", path: "Recipes/From ClickUp", tags: ["recipe"], content: "", metadata: { title: "From ClickUp", source: "clickup", source_id: "cu1", notes: "y" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  for (const field of ["notes", "uid", "lastMessageAt", "start"]) {
    assert.equal((await put("recipe", { ui: { [field]: { deleted: true } } })).status, 200, field);
    const dry = (await (await remove("recipe", field, {})).json()) as any;
    assert.equal(dry.skipped.ingest, field === "notes" ? 4 : 1 + Number(field === "lastMessageAt"), `dry run counts ingest pages for ${field}`);
    assert.equal((await remove("recipe", field, { dryRun: false })).status, 200);
  }
  assert.deepEqual(fv.notes.get("e1")!.metadata, { title: "Mail", source: "proton-bridge", uid: 41, lastMessageAt: 1700000000000, notes: "from mail" });
  assert.equal(fv.notes.get("m1")!.metadata!.start, "2026-10-01T10:00:00Z");
  assert.equal(fv.notes.get("m1")!.metadata!.notes, "agenda");
  assert.equal(fv.notes.get("th1")!.metadata!.lastMessageAt, 1700000000001);
  assert.equal(fv.notes.get("s1")!.metadata!.notes, "y", "a page an ingester recognises by `source` is left alone");
  assert.equal("notes" in fv.notes.get("r1")!.metadata!, false, "ordinary pages are still cleared");
});

test("L1: prototype-named fields are refused everywhere and never read through the prototype", async () => {
  seed();
  for (const name of ["toString", "valueOf", "hasOwnProperty", "constructor", "isPrototypeOf"]) {
    assert.equal((await put("recipe", { fields: { [name]: { type: "string" } } })).status, 400, `field ${name}`);
    assert.equal((await put("recipe", { ui: { [name]: { deleted: true } } })).status, 400, `hint ${name}`);
    assert.equal((await put("recipe", { ui: { course: { optionLabels: { [name]: "X" } } } })).status, 400, `option ${name}`);
    assert.equal((await remove("recipe", name, {})).status, 400, `remove ${name}`);
  }
  assert.equal(tagPuts.length, 0);
});

test("L2: a page whose OTHER tag declares the key only through schema-ui hints is left alone", async () => {
  seed();
  fv.put({ id: "h1", path: "Recipes/Hinted", tags: ["recipe", "pantry"], content: "", metadata: { title: "Hinted", notes: "pantry owns this too" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  assert.equal((await put("pantry", { ui: { notes: { kind: "text", label: "Pantry notes" } } })).status, 200);
  assert.equal((await put("recipe", { ui: { notes: { deleted: true } } })).status, 200);
  const dry = (await (await remove("recipe", "notes", {})).json()) as any;
  assert.equal(dry.skipped.shared, 2); // r3 (vault schema of `favourite`) + h1 (hints of `pantry`)
  await remove("recipe", "notes", { dryRun: false });
  assert.equal(fv.notes.get("h1")!.metadata!.notes, "pantry owns this too");
});

test("L4: someone else's private page is skipped and counted", async () => {
  seed();
  fv.put({ id: "pv1", path: "Recipes/Secret", tags: ["recipe"], content: "", metadata: { title: "Secret", notes: "mine", prism_visibility: "private", prism_creator: "kai@test.local" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  fv.put({ id: "pv2", path: "Recipes/Own", tags: ["recipe"], content: "", metadata: { title: "Own", notes: "owner's", prism_visibility: "private", prism_creator: OWNER }, updatedAt: "2026-10-01T15:00:00.000Z" });
  await put("recipe", { ui: { notes: { deleted: true } } });
  const dry = (await (await remove("recipe", "notes", {})).json()) as any;
  assert.equal(dry.skipped.private, 1);
  await remove("recipe", "notes", { dryRun: false });
  assert.equal(fv.notes.get("pv1")!.metadata!.notes, "mine");
  assert.equal("notes" in fv.notes.get("pv2")!.metadata!, false, "the owner's own private page is theirs to clear");
});

test("L5: schema writes and remove-values are rate limited per owner; a write run is chunked and says when more remains", async () => {
  for (let i = 0; i < 30; i++) fv.put({ id: `b${i}`, path: `Recipes/B${i}`, tags: ["recipe"], content: "", metadata: { title: `B${i}`, notes: "n" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  await put("recipe", { ui: { notes: { deleted: true } } });
  const first = (await (await remove("recipe", "notes", { dryRun: false, limit: 10 })).json()) as any;
  assert.equal(first.removed, 10);
  assert.equal(first.more, true);
  assert.equal(first.remaining, 20);
  const rest = (await (await remove("recipe", "notes", { dryRun: false, limit: 500 })).json()) as any;
  assert.equal(rest.removed, 20);
  assert.equal(rest.more, false);
  // Per-owner limits (the defaults are 120 schema writes and 30 removal requests a minute).
  process.env.SCHEMA_WRITES_PER_MINUTE = "5";
  process.env.SCHEMA_REMOVE_PER_MINUTE = "5";
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await remove("recipe", "notes", {})).status === 429) limited++;
  assert.ok(limited > 0, "remove-values is rate limited");
  let putLimited = 0;
  for (let i = 0; i < 90; i++) if ((await put("recipe", { ui: { serves: { label: `S${i}` } } })).status === 429) putLimited++;
  assert.ok(putLimited > 0, "schema writes are rate limited");
});

test("L6: hint validation — option names, late field declaration, system keys/tags, control characters", async () => {
  // A label may not collide with another option's stored value or label.
  const clashValue = await put("recipe", { ui: { course: { optionLabels: { main: "starter" } } } });
  assert.equal(clashValue.status, 409);
  assert.equal(((await clashValue.json()) as any).error, "option_name_taken");
  assert.equal((await put("recipe", { ui: { course: { optionLabels: { main: "Sweet" } } } })).status, 200);
  assert.equal((await put("recipe", { ui: { course: { optionLabels: { main: "Sweet", dessert: "sweet" } } } })).status, 400, "two labels the same");
  assert.equal((await put("recipe", { ui: { course: { optionLabels: { main: "Main" } } } })).status, 200, "its own value, re-cased, is fine");
  // A kind stored for a free key is re-validated when the field is declared later.
  assert.equal((await put("recipe", { ui: { rating: { kind: "url" } } })).status, 200);
  const late = await put("recipe", { fields: { rating: { type: "number" } } });
  assert.equal(late.status, 409);
  assert.equal(((await late.json()) as any).error, "incompatible_kind");
  assert.equal((await put("recipe", { fields: { rating: { type: "number" } }, ui: { rating: { kind: "number" } } })).status, 200);
  // System keys and system tags take no hints.
  for (const key of ["prism_creator", "title", "gov_sig", "_caps"]) assert.equal((await put("recipe", { ui: { [key]: { label: "X" } } })).status, 400, key);
  for (const tag of ["prism-trashed", "agent-session", "alert", "governance-role", "agent-skill"]) assert.equal((await put(tag, { ui: { notes: { label: "X" } } })).status, 403, tag);
  // Newlines and bidi controls never reach a stored label.
  assert.equal((await put("recipe", { ui: { serves: { label: "Ser\nves‮!" }, course: { optionLabels: { dessert: "Pud\r\nding⁧" } } } })).status, 200);
  const f = await fieldsOf("recipe");
  assert.equal(f.serves.label, "Ser ves!");
  assert.equal(f.course.optionLabels.dessert, "Pud ding");
});

test("L7: `requireNew` makes the server refuse a tag that is used, governed, published or protected", async () => {
  seed();
  const fresh = (tag: string, body: Record<string, unknown> = {}) => put(tag, { requireNew: true, fields: { author: { type: "string" } }, ...body });
  const used = await fresh("recipe");
  assert.equal(used.status, 409);
  assert.equal(((await used.json()) as any).error, "tag_in_use");
  fv.put({ id: "u1", path: "X/U", tags: ["usedtag"], content: "", metadata: {}, updatedAt: "2026-10-01T10:00:00.000Z" });
  assert.equal((await fresh("usedtag")).status, 409, "a tag with pages but no schema");
  assert.equal((await fresh("#usedtag")).status, 409, "canonicalised");
  grantUser("kai@test.local", "tag", "sharedtag", "edit");
  const governed = await fresh("sharedtag");
  assert.equal(governed.status, 409);
  assert.equal(((await governed.json()) as any).error, "tag_governed");
  for (const tag of ["task", "person", "email", "meeting"]) assert.equal((await fresh(tag)).status, 409, tag);
  for (const tag of ["agent-skill", "prism-trashed", "governance-role"]) assert.equal((await fresh(tag)).status, 403, tag);
  assert.equal(tagPuts.length, 0);
  // The availability probe gives the same answers without writing.
  const probe = async (tag: string) => (await (await req(`/schemas/${encodeURIComponent(tag)}/availability`, { cookie: login(OWNER) })).json()) as any;
  assert.deepEqual(await probe("brandnew"), { tag: "brandnew", available: true });
  assert.equal((await probe("recipe")).available, false);
  assert.equal((await probe("sharedtag")).reason, "tag_governed");
  assert.equal((await req("/schemas/brandnew/availability", { cookie: login("kai@test.local") })).status, 403);
  assert.equal((await fresh("brandnew")).status, 200);
  assert.equal(tagPuts.length, 1);
});

test("L3: a property deleted on one tag does not hide another tag's live property with the same key", () => {
  const schemas = {
    recipe: { description: null, fields: { notes: { type: "string", deleted: true }, course: { type: "string" } } },
    favourite: { description: null, fields: { notes: { type: "string", label: "Why I like it" } } },
  };
  const both = resolveProperties(["recipe", "favourite"], schemas, { notes: "family recipe" });
  assert.deepEqual(both.map((p) => [p.key, p.tag, p.label]), [["course", "recipe", "Course"], ["notes", "favourite", "Why I like it"]]);
  assert.deepEqual(resolveProperties(["favourite", "recipe"], schemas, { notes: "x" }).map((p) => p.key), ["notes", "course"]);
  // Deleted by its only declaring tag: hidden even though the page holds a value.
  assert.deepEqual(resolveProperties(["recipe"], schemas, { notes: "x" }).map((p) => p.key), ["course"]);
});

// ── NP-DB-11: "change type" across vault types = a guided conversion into a NEW field ──────────────

const convert = (tag: string, field: string, body: unknown, cookie = login(OWNER), headers: Record<string, string> = J) =>
  req(`/schemas/${encodeURIComponent(tag)}/fields/${encodeURIComponent(field)}/convert`, { method: "POST", cookie, headers, body: JSON.stringify(body) });

function seedScores() {
  fv.put({ id: "s1", path: "Recipes/A", tags: ["recipe"], content: "A-BODY", metadata: { title: "A", notes: "12" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "s2", path: "Recipes/B", tags: ["recipe"], content: "B-BODY", metadata: { title: "B", notes: " $1,250.50 " }, updatedAt: "2026-10-01T11:00:00.000Z" });
  fv.put({ id: "s3", path: "Recipes/C", tags: ["recipe"], content: "", metadata: { title: "C", notes: "a pinch" }, updatedAt: "2026-10-01T12:00:00.000Z" });
  fv.put({ id: "s4", path: "Recipes/D", tags: ["recipe", "prism-trashed"], content: "", metadata: { title: "D", notes: "7" }, updatedAt: "2026-10-01T13:00:00.000Z" });
  fv.put({ id: "s5", path: "Recipes/E", tags: ["recipe", "favourite"], content: "", metadata: { title: "E", notes: "9" }, updatedAt: "2026-10-01T14:00:00.000Z" });
  fv.put({ id: "s6", path: "Recipes/F", tags: ["recipe"], content: "", metadata: { title: "F", notes: "3", prism_visibility: "private", prism_creator: "kai@test.local" }, updatedAt: "2026-10-01T15:00:00.000Z" });
  fv.put({ id: "s7", path: "Recipes/G", tags: ["recipe"], content: "", metadata: { title: "G" }, updatedAt: "2026-10-01T16:00:00.000Z" });
}

test("convert: dry run by default — counts, uncoercible samples, nothing written, no schema change", async () => {
  seedScores();
  await put("recipe", { ui: { notes: { label: "Chef notes" } } });
  const r = await convert("recipe", "notes", { to: "number" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    dryRun: true, tag: "recipe", field: "notes", to: "number", target: "notes_number", total: 2, uncoercible: 1, samples: ["a pinch"],
    skipped: { trashed: 1, shared: 1, system: 0, ingest: 0, private: 1 }, truncated: false, pending: 2,
  });
  assert.equal(tagPuts.length, 0, "no vault schema write on a dry run");
  assert.equal("notes_number" in (await fieldsOf("recipe")), false);
  assert.equal(fv.notes.get("s1")!.updatedAt, "2026-10-01T10:00:00.000Z");
});

test("convert: a NEW field of the target type, one CAS write per page, old values kept, then the swap; re-running converges", async () => {
  seedScores();
  await put("recipe", { ui: { notes: { label: "Chef notes" } } });
  // s2 is edited between the listing and its write: a conflict, never forced — so the swap does not happen yet.
  const realFetch = globalThis.fetch;
  let bumped = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!bumped && init?.method === "PATCH" && url.includes("/notes/")) {
      bumped = true;
      fv.put({ ...fv.notes.get("s2")!, content: "B-EDITED", updatedAt: "2026-10-02T09:00:00.000Z" });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const first = await convert("recipe", "notes", { to: "number", dryRun: false });
  globalThis.fetch = realFetch;
  assert.equal(first.status, 200);
  const a = (await first.json()) as any;
  assert.equal(a.converted + a.conflicts, 2);
  assert.equal(a.conflicts, 1);
  assert.equal(a.done, false);
  assert.equal(a.more, true);
  // The vault schema gained ONE field, additively: the old field's type is untouched.
  assert.equal(tagPuts.length, 1);
  assert.equal(tagPuts[0]!.body.fields.notes.type, "string");
  assert.equal(tagPuts[0]!.body.fields.notes_number.type, "number");
  // While the copy is incomplete the new property is hidden and the old one is still the visible one.
  let f = await fieldsOf("recipe");
  assert.equal(f.notes_number.deleted, true);
  assert.notEqual(f.notes.deleted, true);
  assert.equal(fv.notes.get("s2")!.content, "B-EDITED");
  assert.equal("notes_number" in fv.notes.get("s2")!.metadata!, false);

  const second = (await (await convert("recipe", "notes", { to: "number", dryRun: false })).json()) as any;
  assert.equal(second.converted, 1);
  assert.equal(second.done, true);
  assert.equal(second.more, false);
  assert.equal(tagPuts.length, 1, "the destination field is created once");
  // Values: numbers in the new field; every old value still stored; bodies never written.
  assert.equal(fv.notes.get("s1")!.metadata!.notes_number, 12);
  assert.equal(fv.notes.get("s2")!.metadata!.notes_number, 1250.5);
  assert.equal(fv.notes.get("s1")!.metadata!.notes, "12");
  assert.equal(fv.notes.get("s2")!.metadata!.notes, " $1,250.50 ");
  assert.equal(fv.notes.get("s1")!.content, "A-BODY");
  for (const id of ["s3", "s4", "s5", "s6", "s7"]) assert.equal("notes_number" in fv.notes.get(id)!.metadata!, false, `${id} is left alone`);
  assert.equal(fv.notes.get("s3")!.metadata!.notes, "a pinch", "an unconvertible value stays on the old property");
  // The swap: the new property carries the old NAME and is shown; the old one is deleted (hidden, restorable).
  f = await fieldsOf("recipe");
  assert.deepEqual({ type: f.notes_number.type, kind: f.notes_number.kind, label: f.notes_number.label, deleted: f.notes_number.deleted, convertedFrom: f.notes_number.convertedFrom },
    { type: "number", kind: "number", label: "Chef notes", deleted: false, convertedFrom: "notes" });
  assert.equal(f.notes.deleted, true);
  assert.equal(f.notes.type, "string");
  const shown = resolveProperties(["recipe"], { recipe: { description: null, fields: f } }, {}).map((p) => p.key);
  assert.equal(shown.includes("notes_number"), true);
  assert.equal(shown.includes("notes"), false);
  // Converges: nothing left to write, nothing written.
  const stamp = fv.notes.get("s1")!.updatedAt;
  const third = (await (await convert("recipe", "notes", { to: "number", dryRun: false })).json()) as any;
  assert.deepEqual({ converted: third.converted, done: third.done, pending: third.pending }, { converted: 0, done: true, pending: 0 });
  assert.equal(fv.notes.get("s1")!.updatedAt, stamp);
  // Undo = restore the old property (a hint); its values were never touched.
  assert.equal((await put("recipe", { ui: { notes: { deleted: false } } })).status, 200);
  // Audited with counts and names only — never a value.
  const audit = listActionAudit({ action: ["schema.convert"] });
  assert.equal(audit.length, 3);
  assert.equal(JSON.stringify(audit).includes("pinch"), false);
  assert.equal(JSON.stringify(audit).includes("1,250"), false);
});

test("convert: other directions coerce faithfully or leave the value out", async () => {
  fv.put({ id: "n1", path: "Recipes/N1", tags: ["recipe"], content: "", metadata: { title: "N1", serves: 4, vegan: true, labels: ["quick", "winter"], notes: "yes" }, updatedAt: "2026-10-01T10:00:00.000Z" });
  fv.put({ id: "n2", path: "Recipes/N2", tags: ["recipe"], content: "", metadata: { title: "N2", serves: 2.5, vegan: false, labels: ["solo"], notes: "maybe" }, updatedAt: "2026-10-01T11:00:00.000Z" });
  const run = async (field: string, to: string) => (await (await convert("recipe", field, { to, dryRun: false })).json()) as any;
  assert.equal((await run("serves", "text")).done, true); // number → text
  assert.deepEqual([fv.notes.get("n1")!.metadata!.serves_text, fv.notes.get("n2")!.metadata!.serves_text], ["4", "2.5"]);
  assert.equal((await run("vegan", "text")).done, true); // checkbox → text
  assert.deepEqual([fv.notes.get("n1")!.metadata!.vegan_text, fv.notes.get("n2")!.metadata!.vegan_text], ["Yes", "No"]);
  assert.equal((await run("labels", "text")).done, true); // multi-select → text
  assert.equal(fv.notes.get("n1")!.metadata!.labels_text, "quick, winter");
  const sel = await run("labels", "select"); // several values are not ONE option
  assert.deepEqual([sel.total, sel.uncoercible, fv.notes.get("n2")!.metadata!.labels_select, "labels_select" in fv.notes.get("n1")!.metadata!], [1, 1, "solo", false]);
  const box = await run("notes", "checkbox"); // text → checkbox: only words that mean yes/no
  assert.deepEqual([box.total, box.uncoercible, box.samples, fv.notes.get("n1")!.metadata!.notes_checkbox], [1, 1, ["maybe"], true]);
  const multi = await run("notes", "multi_select"); // text → multi-select
  assert.deepEqual([multi.done, fv.notes.get("n2")!.metadata!.notes_multi_select], [true, ["maybe"]]);
});

test("convert: owner + human + same-origin only; refused for presentations, ingest/managed tags, system keys and a taken destination", async () => {
  seedScores();
  grantUser("kai@test.local", "tag", "recipe", "edit");
  assert.equal((await convert("recipe", "notes", { to: "number", dryRun: false }, login("kai@test.local"))).status, 403);
  assert.equal((await convert("recipe", "notes", { to: "number" }, login(OWNER), { "content-type": "text/plain" })).status, 415);
  assert.equal((await convert("recipe", "notes", { to: "number" }, login(OWNER), { ...J, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await convert("recipe", "notes", { to: "number" }, login(OWNER), { ...J, origin: "https://evil.example" })).status, 403);
  assert.equal((await req("/schemas/recipe/fields/notes/convert", { method: "POST", headers: J, body: '{"to":"number"}' })).status, 403, "anon");
  // A presentation of the stored type is not a conversion: the hint route does it.
  const same = await convert("recipe", "notes", { to: "url" });
  assert.equal(same.status, 409);
  assert.equal(((await same.json()) as any).error, "compatible_kind");
  assert.equal((await convert("task", "estimate", { to: "text" })).status, 409, "ingest tag");
  assert.equal((await convert("agent-skill", "notes", { to: "number" })).status, 403);
  assert.equal((await convert("recipe", "nope", { to: "number" })).status, 404);
  for (const key of ["prism_creator", "title", "source_id", "source", "__proto__", "a b"]) assert.equal((await convert("recipe", key, { to: "number" })).status, 400, key);
  assert.equal((await convert("recipe", "notes", { to: "formula" })).status, 400);
  assert.equal((await convert("recipe", "notes", {})).status, 400);
  assert.equal((await convert("recipe", "notes", { to: "number", dryRun: "no" })).status, 400);
  assert.equal((await convert("recipe", "notes", { to: "number", limit: 5000 })).status, 400);
  // The destination key already belongs to a property nobody converted into: never taken over.
  vaultTags.find((t) => t.name === "recipe")!.fields.notes_number = { type: "number" };
  resetDatabaseCachesForTests();
  const taken = await convert("recipe", "notes", { to: "number", dryRun: false });
  assert.equal(taken.status, 409);
  assert.equal(((await taken.json()) as any).error, "target_taken");
  assert.equal("notes_number" in fv.notes.get("s1")!.metadata!, false);
  assert.equal(tagPuts.length, 0);
});

test("convert: the coercion is linear on hostile values", () => {
  const started = Date.now();
  for (const v of ["1".repeat(200_000), ",".repeat(200_000), " ".repeat(200_000) + "x", "[[".repeat(100_000), "a,".repeat(100_000)]) {
    for (const k of ["number", "checkbox", "multi_select", "date", "url", "email", "phone", "select", "relation", "text"] as const) coerceToKind(v, k);
  }
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test("convert: a select-like target gets its options from the converted values — distinct, first seen first", async () => {
  for (const [i, v] of ["blue", "green", "blue", "red, green"].entries()) {
    fv.put({ id: `o${i}`, path: `Recipes/O${i}`, tags: ["recipe"], content: "", metadata: { title: `O${i}`, serves: i < 3 ? [3, 5, 3][i] : 7, notes: v }, updatedAt: `2026-10-01T1${i}:00:00.000Z` });
  }
  const sel = (await (await convert("recipe", "serves", { to: "select", dryRun: false })).json()) as any;
  assert.deepEqual([sel.done, sel.options], [true, 3]);
  let f = await fieldsOf("recipe");
  assert.deepEqual([...f.serves_select.optionOrder].sort(), ["3", "5", "7"], "distinct values, each once");
  assert.deepEqual(Object.keys(f.serves_select.colors).sort(), ["3", "5", "7"]);
  assert.equal(f.serves_select.enum, undefined, "no vault enum: later values stay free");
  const multi = (await (await convert("recipe", "notes", { to: "multi_select", dryRun: false })).json()) as any;
  assert.equal(multi.options, 3);
  f = await fieldsOf("recipe");
  assert.deepEqual([...f.notes_multi_select.optionOrder].sort(), ["blue", "green", "red"]);
  // A dry run reports the count and stores nothing.
  const dry = (await (await convert("recipe", "serves", { to: "status" })).json()) as any;
  assert.equal(dry.options, 3);
  assert.equal("serves_status" in (await fieldsOf("recipe")), false);
});

test("convert: bounded like remove-values — pages per run, `more`, one bulk job server-wide, per-owner rate limit", async () => {
  for (let i = 0; i < 5; i++) fv.put({ id: `c${i}`, path: `Recipes/C${i}`, tags: ["recipe"], content: "", metadata: { title: `C${i}`, notes: String(i + 1) }, updatedAt: `2026-10-01T1${i}:00:00.000Z` });
  const a = (await (await convert("recipe", "notes", { to: "number", dryRun: false, limit: 2 })).json()) as any;
  assert.deepEqual({ converted: a.converted, pending: a.pending, more: a.more, done: a.done }, { converted: 2, pending: 3, more: true, done: false });
  assert.notEqual((await fieldsOf("recipe")).notes.deleted, true, "the old property stays the visible one until every page is done");
  // Two runs at once: one works, the other is told a bulk job is running (and writes nothing).
  const [x, y] = await Promise.all([convert("recipe", "notes", { to: "number", dryRun: false, limit: 2 }), convert("recipe", "notes", { to: "number", dryRun: false, limit: 2 })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(((await (x.status === 409 ? x : y).json()) as any).error, "busy");
  const c = (await (await convert("recipe", "notes", { to: "number", dryRun: false, limit: 2 })).json()) as any;
  assert.deepEqual({ converted: c.converted, more: c.more, done: c.done }, { converted: 1, more: false, done: true });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => fv.notes.get(`c${i}`)!.metadata!.notes_number), [1, 2, 3, 4, 5]);
  // Rate limited per owner (dry runs count too).
  process.env.SCHEMA_CONVERT_PER_MINUTE = "3";
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await convert("recipe", "notes", { to: "number" })).status === 429) limited++;
  assert.ok(limited > 0, "convert is rate limited");
});

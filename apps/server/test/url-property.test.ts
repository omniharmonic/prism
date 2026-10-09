/**
 * What a URL property may hold (`@prism/core/database` url.ts) — the ONE rule the
 * editors, the type conversion and the CSV import share — and the CSV import route
 * applying it (a cell bound for a URL property is a web address or the row is reported).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { coerceCsvValue, coerceToKind, normalizeUrlValue, storedWebUrl, MAX_URL_LENGTH } from "@prism/core/database";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetDatabaseCachesForTests, setSchemaAdminMinter } from "../src/routes/databases";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

test("normalizeUrlValue: a web address is kept as typed; a bare domain gets https://", () => {
  for (const [typed, stored] of [
    ["https://example.com", "https://example.com"],
    ["http://example.com/a?b=1#c", "http://example.com/a?b=1#c"],
    ["  https://example.com/x  ", "https://example.com/x"],
    ["HTTPS://Example.com/Path", "HTTPS://Example.com/Path"],
    ["example.com", "https://example.com"],
    ["www.example.co.uk/a/b", "https://www.example.co.uk/a/b"],
    ["docs.example.org?q=1", "https://docs.example.org?q=1"],
    ["example.com:8080/x", "https://example.com:8080/x"],
    ["example.com#top", "https://example.com#top"],
    ["https://localhost:3000/x", "https://localhost:3000/x"],
    ["http://192.168.1.10/admin", "http://192.168.1.10/admin"],
    ["https://example.com/caf%C3%A9", "https://example.com/caf%C3%A9"],
  ] as const) assert.equal(normalizeUrlValue(typed), stored, typed);
});

test("normalizeUrlValue: everything that is not a web address is refused (null), never stored", () => {
  for (const typed of [
    "", "   ", "hello", "see the wiki", "not a url", "example", "TODO: add link",
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd", "ftp://example.com/x",
    "mailto:ada@example.com", "ada@example.com", "tel:+15550100",
    "/page/abc", "//evil.test/x", "#anchor", "../up",
    "https://user:pass@example.com", "https://user@example.com", "user:pass@example.com",
    "https://exa mple.com", "https://example.com/a b", "https://example.com/\\evil", "https://example.com/\tx", "https://example.com/\nx", "exam\u0000ple.com",
    "https://", "https:///", "http://", "https://?x=1",
    "1.2", "3.14", "v1.2.3", "a..b.com", ".com", "example.c", "-example.com", "example.com:99999999",
    `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`,
  ]) assert.equal(normalizeUrlValue(typed), null, JSON.stringify(typed));
  for (const notText of [null, undefined, 5, true, ["https://example.com"], { url: "https://example.com" }]) assert.equal(normalizeUrlValue(notText), null);
});

test("normalizeUrlValue: linear on hostile input", () => {
  const t0 = performance.now();
  for (const s of ["a".repeat(MAX_URL_LENGTH), `a${"_".repeat(2000)}`, `${"a.".repeat(1000)}!`, `${"a-".repeat(1000)}.`, `x${".a".repeat(1000)}:`]) {
    for (let i = 0; i < 200; i++) normalizeUrlValue(s);
  }
  assert.ok(performance.now() - t0 < 1500);
});

test("storedWebUrl: only a value that already is a web address is a link; anything else is plain text", () => {
  assert.equal(storedWebUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(storedWebUrl(" http://example.com "), "http://example.com");
  // Stored without a scheme: shown as text (with the "Not a link" note) until someone saves it again.
  assert.equal(storedWebUrl("example.com"), null);
  assert.equal(storedWebUrl("javascript:alert(1)"), null);
  assert.equal(storedWebUrl("https://user:pw@evil.test"), null, "a link never hands over or hides credentials");
  assert.equal(storedWebUrl("see the wiki"), null);
  assert.equal(storedWebUrl(42), null);
  assert.equal(storedWebUrl(null), null);
});

test("type conversion and CSV cells for a URL property use the same rule", () => {
  assert.deepEqual(coerceToKind("example.com/x", "url"), { ok: true, value: "https://example.com/x" });
  assert.deepEqual(coerceToKind(["https://example.com"], "url"), { ok: true, value: "https://example.com" });
  assert.deepEqual(coerceToKind("see the wiki", "url"), { ok: false });
  assert.deepEqual(coerceToKind("javascript:alert(1)", "url"), { ok: false });
  assert.deepEqual(coerceCsvValue("example.com", { type: "string", kind: "url" }), { value: "https://example.com" });
  assert.deepEqual(coerceCsvValue(" https://example.com/a ", { type: "string", kind: "url" }), { value: "https://example.com/a" });
  assert.deepEqual(coerceCsvValue("", { type: "string", kind: "url" }), { value: null }, "an empty cell is still an empty cell");
  assert.deepEqual(coerceCsvValue("see the wiki", { type: "string", kind: "url" }), { error: "“see the wiki” is not a web address" });
  // Any other property takes the text as it is.
  assert.deepEqual(coerceCsvValue("see the wiki", { type: "string", kind: "text" }), { value: "see the wiki" });
  assert.deepEqual(coerceCsvValue("see the wiki", { type: "string" }), { value: "see the wiki" });
});

// ── POST /api/databases/import/csv ───────────────────────────────────────────

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
    // `website` is a URL by its name; `source` only by the owner's hint (set below); `notes` is plain text.
    if (/^\/vault\/default\/api\/tags$/.test(url.pathname) && (init?.method ?? "GET") === "GET") {
      return Response.json([{ name: "book", description: "Books", fields: { website: { type: "string" }, source: { type: "string" }, notes: { type: "string" } } }]);
    }
    return innerFetch(input, init);
  }) as typeof fetch;
  setSchemaAdminMinter(async () => "admin-jwt-for-test");
});
afterEach(() => {
  setSchemaAdminMinter(null);
  globalThis.fetch = innerFetch;
  fv.restore();
});

const J = { "content-type": "application/json" };
const send = (path: string, body: unknown, method = "POST") => {
  const headers = new Headers(J);
  headers.set("cookie", sessionCookie(makeSession("owner@test.local")));
  return api.request(path, { method, headers, body: JSON.stringify(body) });
};

test("CSV import: a cell for a URL property is normalised or the row is reported — text that is no web address is never stored there", async () => {
  assert.equal((await send("/schemas/book", { ui: { source: { kind: "url" } } }, "PUT")).status, 200);
  const csv = [
    "Title,Website,Source,Notes",
    "Good,example.com/good,https://example.org/s,see the wiki",
    "Bad site,see the wiki,https://example.org/s,fine",
    "Bad source,https://example.com,javascript:alert(1),fine",
    "Empty,,,",
  ].join("\n") + "\n";
  const body = { tag: "book", csv, mapping: { Title: "$title", Website: "website", Source: "source", Notes: "notes" }, pathPrefix: "Books" };
  const dry = await send("/databases/import/csv", { ...body, dryRun: true });
  assert.equal(dry.status, 200);
  const plan = (await dry.json()) as { summary: { create: number; error: number }; errors: Array<{ title: string; action: string; error?: string }> };
  assert.equal(plan.summary.create, 2);
  assert.equal(plan.summary.error, 2);
  const errors = plan.errors.map((s) => s.error);
  assert.deepEqual(errors, ["Website: “see the wiki” is not a web address", "Source: “javascript:alert(1)” is not a web address"]);
  const run = await send("/databases/import/csv", { ...body, dryRun: false });
  assert.equal(run.status, 200);
  const made = [...fv.notes.values()].filter((n) => (n.tags ?? []).includes("book"));
  assert.deepEqual(made.map((n) => n.metadata?.title).sort(), ["Empty", "Good"]);
  const good = made.find((n) => n.metadata?.title === "Good")!.metadata!;
  assert.equal(good.website, "https://example.com/good", "a bare domain is stored with https://");
  assert.equal(good.source, "https://example.org/s");
  assert.equal(good.notes, "see the wiki", "a text property takes any text");
  assert.ok(!JSON.stringify(made).includes("javascript:"));
});

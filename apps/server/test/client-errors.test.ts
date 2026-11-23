/**
 * L-1: client error reports — POST/GET/DELETE /api/admin/client-errors.
 * Server owner only (the admin router's guard), CSRF on writes, strict bounded fields,
 * routes stripped of query/fragment, newest MAX_ROWS kept, an hourly budget.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { MAX_ROWS, REPORTS_PER_HOUR, parseClientError, recordClientError, resetReportSlotsForTests, takeReportSlot } from "../src/client-errors";

const app = createApp();
const J = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
const as = (email: string) => ({ cookie: sessionCookie(makeSession(email)), ...J });
const post = (headers: Record<string, string>, body: unknown) =>
  app.request("/api/admin/client-errors", { method: "POST", headers, body: JSON.stringify(body) });
const list = async () => ((await (await app.request("/api/admin/client-errors", { headers: as(config.ownerEmail) })).json()) as { errors: Array<Record<string, unknown>> }).errors;

beforeEach(() => {
  resetDb();
  resetReportSlotsForTests();
  void app.request("/api/admin/client-errors", { method: "DELETE", headers: as(config.ownerEmail) });
});

test("the owner's client reports an uncaught error; it is listed newest first", async () => {
  const r = await post(as(config.ownerEmail), { kind: "uncaught", message: "Cannot read properties of null", stack: "at x (app.js:1:2)", route: "/page/abc?t=SECRET#h-1", build: "0.9.2", platform: "macos" });
  assert.equal(r.status, 201);
  await post(as(config.ownerEmail), { kind: "stall", message: "main thread stalled", detail: "stalled 4210 ms" });
  const rows = await list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "stall");
  assert.equal(rows[1]!.route, "/page/abc", "a route keeps its path only — never a capability token in a query");
  assert.equal(rows[1]!.build, "0.9.2");
});

test("only the server owner: a member, a link-less anonymous caller and a cross-site write are refused", async () => {
  assert.equal((await post(as("member@x.test"), { kind: "error", message: "x" })).status, 403);
  assert.equal((await post(J, { kind: "error", message: "x" })).status, 403);
  assert.equal((await post({ ...as(config.ownerEmail), "sec-fetch-site": "cross-site" }, { kind: "error", message: "x" })).status, 403);
  assert.equal((await app.request("/api/admin/client-errors", { headers: as("member@x.test") })).status, 403);
  assert.equal((await list()).length, 0);
});

test("strict, bounded body: unknown kinds and empty messages refused, long fields cut, unknown keys dropped", () => {
  assert.equal(parseClientError({ kind: "nope", message: "x" }), null);
  assert.equal(parseClientError({ kind: "error", message: "   " }), null);
  assert.equal(parseClientError(["error"]), null);
  const p = parseClientError({ kind: "error", message: "m".repeat(5_000), stack: "s".repeat(10_000), content: "<p>page text</p>", at: 1 }, 10 ** 13)!;
  assert.equal(p.message.length, 500);
  assert.equal(p.stack!.length, 4_000);
  assert.ok(!("content" in p), "unknown keys never stored");
  assert.equal(p.at, 10 ** 13, "an implausible client time is replaced by the server's");
});

test("an hourly budget per owner; the table keeps the newest MAX_ROWS", async () => {
  for (let i = 0; i < REPORTS_PER_HOUR; i++) assert.equal(takeReportSlot(1_000 + i), true);
  assert.equal(takeReportSlot(2_000), false);
  assert.equal(takeReportSlot(1_000 + 3_600_001), true, "the window moves on");
  resetReportSlotsForTests();
  for (let i = 0; i < MAX_ROWS + 15; i++) recordClientError({ kind: "error", message: `e${i}` });
  const rows = await list();
  assert.ok(rows.length <= MAX_ROWS);
  assert.equal(rows[0]!.message, `e${MAX_ROWS + 14}`);
  const all = ((await (await app.request(`/api/admin/client-errors?limit=${MAX_ROWS}`, { headers: as(config.ownerEmail) })).json()) as { errors: unknown[] }).errors;
  assert.equal(all.length, MAX_ROWS);
});

test("rate limited reports answer 429 (the client drops them)", async () => {
  for (let i = 0; i < REPORTS_PER_HOUR; i++) takeReportSlot();
  assert.equal((await post(as(config.ownerEmail), { kind: "error", message: "x" })).status, 429);
});

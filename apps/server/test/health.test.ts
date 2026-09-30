/**
 * Worker source-health (WP0.5): status computation, desktop freshness inferred
 * from the vault, once-per-episode alerts + recovery, route auth, no secrets.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie, installFakeVault, type FakeVault } from "./helpers";
import { setMembership, getWorkerCursor, setWorkerCursor } from "../src/db";
import {
  computeStatus,
  evaluateAlerts,
  getSourceHealth,
  recordSourceOutcome,
  resetSourceHealth,
  scrubError,
  type AlertDeps,
  type SourceHealth,
} from "../src/worker/health";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

const MIN = 60_000;
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

function deps() {
  const sent: Array<{ to: string; subject: string }> = [];
  const notes: Array<{ path: string; tags: string[] }> = [];
  const d: AlertDeps = {
    send: async (to, subject) => void sent.push({ to, subject }),
    writeNote: async (n) => void notes.push({ path: n.path, tags: n.tags }),
    getFlag: (v, k) => getWorkerCursor(v, k),
    setFlag: (v, k, val) => setWorkerCursor(v, k, val),
  };
  return { sent, notes, d };
}

const row = (over: Partial<SourceHealth>): SourceHealth => ({
  name: "email", kind: "desktop", vaultId: "primary", lastSuccessAt: null, lastError: null,
  failureStreak: 0, staleAfterMs: 30 * MIN, status: "ok", ...over,
});

test("computeStatus: disabled, failing, stale, ok, and threshold 0 = no staleness", () => {
  const base = { lastSuccessAt: 1_000, streak: 0, staleAfterMs: 30 * MIN, now: 1_000 + 10 * MIN, baselineAt: 0 };
  assert.equal(computeStatus({ ...base, configured: false }), "disabled");
  assert.equal(computeStatus({ ...base, configured: true }), "ok");
  assert.equal(computeStatus({ ...base, configured: true, now: 1_000 + 31 * MIN }), "stale");
  assert.equal(computeStatus({ ...base, configured: true, streak: 3 }), "failing");
  assert.equal(computeStatus({ ...base, configured: true, staleAfterMs: 0, now: 1e12 }), "ok");
  // never succeeded: measured from the baseline (boot), not treated as instantly stale
  assert.equal(computeStatus({ ...base, configured: true, lastSuccessAt: null, baselineAt: 1_000 + 5 * MIN }), "ok");
});

test("scrubError removes bearer tokens, key=value secrets and long opaque strings", () => {
  const s = scrubError("401 Authorization: Bearer abc.def-ghi api_key=sk_live_1234 " + "x".repeat(40));
  assert.ok(!/abc\.def|sk_live|xxxxxxxx/.test(s), s);
  assert.ok(s.length <= 200);
});

test("server source: outcomes feed last success / error / streak", async () => {
  recordSourceOutcome("primary", "index", null, Date.now());
  recordSourceOutcome("primary", "index", new Error("boom token=SECRETVALUE"));
  const idx = (await getSourceHealth({ list: async () => [] })).find((h) => h.name === "index");
  // index is disabled in tests (INDEX_INTERVAL_MS=0) but the registry data is still surfaced
  assert.equal(idx!.failureStreak, 1);
  assert.match(idx!.lastError!, /boom/);
  assert.ok(!idx!.lastError!.includes("SECRETVALUE"));
  assert.ok(idx!.lastSuccessAt);
});

test("desktop freshness is inferred from the newest note of each kind, never-seen = disabled", async () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const iso = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const list = async (o: { tags: string[] }) => {
    if (o.tags[0] === "email") {
      return [
        { path: "vault/messages/email/a-1", updatedAt: iso(50) },
        { path: "vault/messages/email/b-2", updatedAt: iso(45) }, // newest wins even if unsorted
      ];
    }
    if (o.tags[0] === "meeting") {
      return [
        { path: "vault/meetings/x", updatedAt: iso(1), metadata: {} }, // no calendarEventId → ignored
        { path: "vault/meetings/y", updatedAt: iso(20), metadata: { calendarEventId: "e1" } },
      ];
    }
    return []; // no agent-dispatch notes ever
  };
  const h = await getSourceHealth({ now, list });
  const by = Object.fromEntries(h.map((x) => [x.name, x]));
  assert.equal(by.email!.status, "stale"); // 45 min > 30
  assert.equal(by.email!.lastSuccessAt, iso(45));
  assert.equal(by.email!.kind, "desktop");
  assert.equal(by.calendar!.status, "ok");
  assert.equal(by.calendar!.lastSuccessAt, iso(20));
  assert.equal(by.skills!.status, "disabled");
});

test("a failing vault probe keeps the last known freshness and surfaces a scrubbed error", async () => {
  const now = Date.now();
  const okList = async () => [{ path: "vault/messages/email/a-1", updatedAt: new Date(now - MIN).toISOString() }];
  await getSourceHealth({ now, list: okList });
  resetProbeCacheByAdvancing();
  const bad = async () => { throw new Error("vault down Bearer abcdef0123456789abcdef0123456789"); };
  const h = await getSourceHealth({ now: now + 10 * MIN, list: bad });
  const e = h.find((x) => x.name === "email")!;
  assert.ok(e.lastSuccessAt, "last known freshness retained");
  assert.match(e.lastError!, /vault down/);
  assert.ok(!/abcdef0123456789/.test(e.lastError!));
  function resetProbeCacheByAdvancing() { /* the 10-min advance above exceeds WORKER_DESKTOP_PROBE_MS */ }
});

test("exactly ONE alert per episode, repeated ticks are silent, then ONE recovery", async () => {
  const { sent, notes, d } = deps();
  const t = 1_000_000;
  const stale = [row({ status: "stale", lastSuccessAt: new Date(t).toISOString() })];
  const r1 = await evaluateAlerts(stale, { now: t, deps: d, force: true });
  const r2 = await evaluateAlerts(stale, { now: t + MIN, deps: d, force: true });
  const r3 = await evaluateAlerts([row({ status: "failing" })], { now: t + 2 * MIN, deps: d, force: true }); // stale→failing, same episode
  assert.deepEqual(r1.alerted, ["email"]);
  assert.deepEqual([r2.alerted, r3.alerted], [[], []]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, config.ownerEmail);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0]!.tags, ["alert"]);
  assert.match(notes[0]!.path, /^vault\/agent\/alerts\/\d{4}-\d\d-\d\d-\d{4}-email$/);

  const rec = await evaluateAlerts([row({ status: "ok" })], { now: t + 3 * MIN, deps: d, force: true });
  assert.deepEqual(rec.recovered, ["email"]);
  const again = await evaluateAlerts([row({ status: "ok" })], { now: t + 4 * MIN, deps: d, force: true });
  assert.deepEqual(again.recovered, []);
  assert.equal(sent.length, 2, "one alert + one recovery");
  assert.match(sent[1]!.subject, /recovered/);

  // a NEW episode alerts again
  const r4 = await evaluateAlerts(stale, { now: t + 5 * MIN, deps: d, force: true });
  assert.deepEqual(r4.alerted, ["email"]);
  assert.equal(sent.length, 3);
});

test("a source that goes disabled mid-episode closes it silently; alerts off by default in tests", async () => {
  const { sent, d } = deps();
  await evaluateAlerts([row({ status: "stale" })], { deps: d, force: true });
  const r = await evaluateAlerts([row({ status: "disabled" })], { deps: d, force: true });
  assert.deepEqual(r.recovered, []);
  assert.equal(sent.length, 1);
  // without force, WORKER_ALERTS_ENABLED=false (.env.test) → nothing happens
  const off = await evaluateAlerts([row({ name: "calendar", status: "stale" })], { deps: d });
  assert.deepEqual(off.alerted, []);
  assert.equal(sent.length, 1);
});

test("an email/note failure never throws out of evaluateAlerts", async () => {
  const d: AlertDeps = {
    send: async () => { throw new Error("resend down"); },
    writeNote: async () => { throw new Error("vault down"); },
    getFlag: (v, k) => getWorkerCursor(v, k),
    setFlag: (v, k, val) => setWorkerCursor(v, k, val),
  };
  const r = await evaluateAlerts([row({ status: "failing" })], { deps: d, force: true });
  assert.deepEqual(r.alerted, ["email"]);
});

test("GET /acl/workers: owner gets sources; admin / anon are 403; no secret material", async () => {
  const r = await acl.request("/workers", { headers: { cookie: ownerCookie() } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { sources: SourceHealth[] };
  const names = body.sources.map((s) => s.name);
  for (const n of ["matrix", "clickup", "fireflies", "fathom", "index", "email", "calendar", "skills"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const s of body.sources) {
    assert.deepEqual(Object.keys(s).sort(), ["failureStreak", "kind", "lastError", "lastSuccessAt", "name", "staleAfterMs", "status", "vaultId"]);
  }
  assert.ok(!/parachuteToken|test-vault-token|sessionSecret|Bearer /.test(JSON.stringify(body)));

  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  const adminCookie = sessionCookie(makeSession("admin@x.co"));
  assert.equal((await acl.request("/workers", { headers: { cookie: adminCookie } })).status, 403);
  assert.equal((await acl.request("/workers")).status, 403);
});

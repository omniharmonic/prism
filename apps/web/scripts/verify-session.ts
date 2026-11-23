/**
 * When a native session ends — the rule stated in src/native/sessionGuard.ts
 * (qa/ios-simulator-findings-2026-10-08.md, findings 4 and 5):
 *   one 401 is confirmed with ONE /auth/me for the same token before anything is dropped;
 *   a dead token is forgotten once and the page reloads — nothing ever starts a sign-in;
 *   after a token was sent, a request with none is not sent.
 * Run: npm run verify:session -w @prism/web
 */
import assert from "node:assert/strict";
import { createSessionGuard, VERDICT_REUSE_MS, type SessionGuardDeps, type Verdict } from "../src/native/sessionGuard.ts";

function world(over: Partial<{ token: string | null; answer: Verdict | (() => Promise<Verdict>) }> = {}) {
  const w = {
    token: "token" in over ? over.token! : "pd_a",
    answer: (over.answer ?? "alive") as Verdict | (() => Promise<Verdict>),
    probes: [] as string[],
    forgets: 0,
    cacheClears: 0,
    reloads: [] as boolean[],
    clock: 1_000_000,
  };
  const deps: SessionGuardDeps = {
    getToken: async () => w.token,
    probe: async (t) => { w.probes.push(t); return typeof w.answer === "function" ? w.answer() : w.answer; },
    forget: async () => { w.forgets++; w.token = null; },
    clearCache: async () => { w.cacheClears++; },
    reload: (rejected) => { w.reloads.push(rejected); },
    now: () => w.clock,
  };
  return { w, guard: createSessionGuard(deps) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
// The guard is handed NO way to start a sign-in: forget, clear, reload are all it can do.
assert.deepEqual(Object.keys(world().guard).sort(), ["closing", "missing", "over", "sent", "unauthorized"]);

// 1. A 401 for a token the server still accepts changes NOTHING.
{
  const { w, guard } = world({ answer: "alive" });
  guard.sent();
  assert.equal(await guard.unauthorized("pd_a"), "alive");
  await settle();
  assert.deepEqual(w.probes, ["pd_a"], "asked once, with the same token");
  assert.equal(w.forgets, 0, "the token is kept");
  assert.deepEqual(w.reloads, []);
  assert.equal(guard.over(), false);
}

// 2. No answer / a 5xx / a proxy page is NOT a sign-out either.
for (const answer of ["unknown", async () => { throw new Error("offline"); }] as const) {
  const { w, guard } = world({ answer: answer as never });
  guard.sent();
  assert.equal(await guard.unauthorized("pd_a"), "unknown");
  await settle();
  assert.equal(w.forgets, 0);
  assert.deepEqual(w.reloads, []);
  assert.equal(guard.over(), false);
}

// 3. A burst of 401s asks ONCE; the answer is reused for a moment, then asked again.
{
  const { w, guard } = world({ answer: "alive" });
  const all = await Promise.all(Array.from({ length: 12 }, () => guard.unauthorized("pd_a")));
  assert.deepEqual([...new Set(all)], ["alive"]);
  assert.equal(w.probes.length, 1, "twelve 401s at once = one question");
  await guard.unauthorized("pd_a");
  assert.equal(w.probes.length, 1, "a straggler just after reuses the answer");
  w.clock += VERDICT_REUSE_MS + 1;
  await guard.unauthorized("pd_a");
  assert.equal(w.probes.length, 2, "later, a 401 is a new question");
}

// 4. A token the server refuses on /auth/me too: forgotten ONCE, one reload, and from that
//    moment nothing authenticated is sent. Still no sign-in anywhere.
{
  const { w, guard } = world({ answer: "dead" });
  guard.sent();
  const all = await Promise.all(Array.from({ length: 6 }, () => guard.unauthorized("pd_a")));
  assert.deepEqual([...new Set(all)], ["dead"]);
  assert.equal(guard.over(), true, "over at once — before the reload happens");
  assert.equal(guard.missing(), true, "a request now is not sent");
  await settle();
  assert.equal(w.probes.length, 1);
  assert.equal(w.forgets, 1, "onUnauthorized once");
  assert.equal(w.cacheClears, 1);
  assert.deepEqual(w.reloads, [true], "one reload, flagged as refused by the server");
  assert.equal(await guard.unauthorized("pd_a"), "dead");
  await settle();
  assert.equal(w.forgets, 1, "…and never again on this page load");
  assert.deepEqual(w.reloads, [true]);
}

// 5. A 401 for an OLD token (a request sent before a new sign-in) says nothing.
{
  const { w, guard } = world({ token: "pd_new", answer: "dead" });
  assert.equal(await guard.unauthorized("pd_old"), "unknown");
  assert.deepEqual(w.probes, [], "not even asked");
  assert.equal(w.forgets, 0);
}
//    …also when the token changed WHILE the server was being asked: the new one is kept.
{
  const { w, guard } = world({ answer: "dead" });
  w.answer = async () => { w.token = "pd_new"; return "dead"; };
  assert.equal(await guard.unauthorized("pd_a"), "unknown");
  await settle();
  assert.equal(w.forgets, 0, "the new token is not forgotten for the old one's 401");
  assert.equal(guard.over(), false);
}

// 6. The token went from under a running page (signed out elsewhere, Keychain cleared): the
//    request is not sent and the page reloads — nothing to forget, nothing "refused".
{
  const { w, guard } = world();
  guard.sent();
  w.token = null;
  assert.equal(guard.missing(), true);
  assert.equal(guard.over(), true);
  await settle();
  assert.equal(w.forgets, 0);
  assert.deepEqual(w.reloads, [false]);
  assert.equal(guard.missing(), true);
  await settle();
  assert.deepEqual(w.reloads, [false], "one reload");
}
//    A page that never sent a token (the sign-in screen itself) is left alone: no reload loop.
{
  const { w, guard } = world({ token: null });
  assert.equal(guard.missing(), false);
  assert.equal(guard.over(), false);
  await settle();
  assert.deepEqual(w.reloads, []);
}

// 7. The person signs out: requests stop at once, and the guard reloads nothing (logout does).
{
  const { w, guard } = world();
  guard.sent();
  guard.closing();
  w.token = null;
  assert.equal(guard.over(), true);
  assert.equal(guard.missing(), true);
  assert.equal(await guard.unauthorized("pd_a"), "dead");
  await settle();
  assert.deepEqual(w.reloads, []);
  assert.equal(w.forgets, 0);
}

// 8. A shell that cannot forget, or a cache that never answers, does not keep the person on a
//    dead workspace: the reload still happens.
{
  const { w, guard } = world({ answer: "dead" });
  const deps: SessionGuardDeps = {
    getToken: async () => "pd_a",
    probe: async () => "dead",
    forget: async () => { throw new Error("keychain"); },
    clearCache: () => new Promise(() => {}),
    reload: (r) => { w.reloads.push(r); },
  };
  const g = createSessionGuard(deps);
  assert.equal(await g.unauthorized("pd_a"), "dead");
  await new Promise((r) => setTimeout(r, 2200));
  assert.deepEqual(w.reloads, [true]);
  void guard;
}

console.log("verify:session — all checks passed");

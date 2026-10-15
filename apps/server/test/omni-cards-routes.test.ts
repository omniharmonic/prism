import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
import { omniApi } from "../src/routes/omni";
import { config } from "../src/config";
import { db } from "../src/db";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { resetOmniStoreForTests } from "../src/omni/store";
import { resetNudgesForTests, upsertNudge, getNudge, type Candidate } from "../src/omni/nudges";
import { resetCardsForTests, parseCardInput, upsertCard, transitionCard, getCard } from "../src/omni/cards";
import { cardInput } from "./omni-card-samples";

const owner = config.ownerEmail;
const J = { "content-type": "application/json" };
const ownerH = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const get = async (path: string) => (await omniApi.request(path, { headers: ownerH() })).json() as Promise<{ cards: Array<Record<string, unknown>>; counts: Record<string, number> }>;
const post = (path: string, body: unknown, headers: Record<string, string> = ownerH()) => omniApi.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const card = (key: string, now: number, over: Record<string, unknown> = {}) => upsertCard(owner, parseCardInput(cardInput({ sourceKey: key, itemRefs: [key], ...over })), `t-${key}`, now).card;
const candidate = (sourceId: string, sourcePath: string): Candidate => ({ sourceId, sourcePath, kind: "reply-owed", title: "Ana is waiting on the venue answer", summary: "She asked whether the barn is free on the 24th.", reasons: ["Waiting"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false });
beforeEach(() => { resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); });

test("GET /cards is the owner's and groups cards into Decide, Approve and In motion", async () => {
  assert.equal((await omniApi.request("/cards")).status, 401);
  assert.equal((await omniApi.request("/cards", { headers: { ...J, cookie: sessionCookie(makeSession("other@example.com")) } })).status, 403);
  const a = card("m1", 1_000);
  const b = card("m2", 2_000);
  const d = card("m3", 3_000);
  transitionCard(owner, b.id, ["proposed"], "draft-ready", { action: "choose", optionId: "a" });
  transitionCard(owner, d.id, ["proposed"], "working", { action: "choose", optionId: "b" });
  const all = await get("/cards");
  assert.deepEqual(all.counts, { decide: 1, approve: 1, motion: 1 });
  assert.deepEqual(all.cards.map((c) => [c.id, c.section]).sort(), [[a.id, "decide"], [b.id, "approve"], [d.id, "motion"]].sort());
  assert.deepEqual((await get("/cards?section=approve")).cards.map((c) => c.id), [b.id]);
  assert.equal((await omniApi.request("/cards?section=later", { headers: ownerH() })).status, 400);
  assert.equal((await omniApi.request(`/cards/${a.id}`, { headers: ownerH() })).status, 200);
  assert.equal((await omniApi.request("/cards/card_missing", { headers: ownerH() })).status, 404);
});

test("a nudge without a card shows as a minimal card; one with a card is not repeated", async () => {
  upsertNudge(owner, candidate("mail1", "mail/ana"));
  upsertNudge(owner, candidate("chat1", "messages/matrix/ana"));
  card("mail1", 1_000);
  const views = (await get("/cards")).cards.filter((c) => c.transitional === true);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.sourceKey, "chat1");
  assert.equal(views[0]!.kind, "message");
  assert.deepEqual(views[0]!.options, []);
  assert.equal(views[0]!.headline, "Ana is waiting on the venue answer");
  assert.deepEqual(views[0]!.context, [{ text: "She asked whether the barn is free on the 24th.", source: null }]);
  assert.equal(typeof views[0]!.nudgeId, "string");
});

test("snooze and dismiss: human only, bounded, feedback kept, the nudge follows", async () => {
  const n = upsertNudge(owner, candidate("mail1", "mail/ana"));
  const c = card("mail1", 1_000);
  const until = Date.now() + 3_600_000;
  assert.equal((await post(`/cards/${c.id}/snooze`, { until }, { ...ownerH(), "x-prism-action-origin": "agent" })).status, 403);
  assert.equal((await post(`/cards/${c.id}/snooze`, { until }, hook)).status, 401);
  assert.equal((await post(`/cards/${c.id}/snooze`, { until: Date.now() - 1 })).status, 400);
  const snoozed = await post(`/cards/${c.id}/snooze`, { until });
  assert.equal(snoozed.status, 200);
  assert.equal((await snoozed.json() as { card: { state: string; section: unknown } }).card.state, "snoozed");
  assert.equal((await get("/cards")).cards.length, 0, "a snoozed card leaves Needs you until it is due");
  assert.equal((db.prepare("SELECT count(*) n FROM omni_feedback WHERE kind='snooze' AND source_id='mail1'").get() as { n: number }).n, 1);
  assert.equal((await post(`/cards/${c.id}/dismiss`, { reason: "maybe" })).status, 400);
  const dismissed = await post(`/cards/${c.id}/dismiss`, { reason: "not-needed" });
  assert.equal(dismissed.status, 200);
  assert.equal(getCard(owner, c.id)!.state, "dismissed");
  assert.equal(getNudge(owner, n.id)!.dismissed, true);
  assert.equal((db.prepare("SELECT count(*) n FROM omni_feedback WHERE kind='noise' AND source_id='mail1'").get() as { n: number }).n, 1);
  const busy = card("mail2", 2_000);
  transitionCard(owner, busy.id, ["proposed"], "working", { action: "choose", optionId: "b" });
  const refused = await post(`/cards/${busy.id}/dismiss`, { reason: "done" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as { error: string }).error, "card_not_open");
});

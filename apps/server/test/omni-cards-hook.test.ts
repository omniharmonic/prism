import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642"; process.env.OMNI_HERMES_KEY = "test-hermes-key-0123456789";
import { omniApi } from "../src/routes/omni";
import { config } from "../src/config";
import { db } from "../src/db";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { resetOmniStoreForTests, eventsAfter, getThread } from "../src/omni/store";
import { resetNudgesForTests, upsertNudge, nudgeAction, getNudge, resolveNudgeSource } from "../src/omni/nudges";
import { resetCardsForTests, getCard, transitionCard } from "../src/omni/cards";
import { dismissCard } from "../src/omni/card-flow";
import { setOmniPusherForTests } from "../src/omni/bus";
import { cardPublish } from "./omni-card-samples";

const revision = "2026-10-15T10:00:00Z";
const hook = { "content-type": "application/json", authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const owner = () => ({ "content-type": "application/json", cookie: sessionCookie(makeSession(config.ownerEmail)) });
const post = (b: unknown, headers: Record<string, string> = hook) => omniApi.request("/hooks/cards", { method: "POST", headers, body: JSON.stringify(b) });
let stub: ReturnType<typeof createHermesStub>;
let pushes: string[] = [];
beforeEach(() => {
  resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); pushes = [];
  stub = createHermesStub({ key: process.env.OMNI_HERMES_KEY! }); setHermesFetchForTests(stub.fetch);
  setOmniPusherForTests(async (_o, kind, id) => { pushes.push(`${kind}:${id}`); });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: revision }) });
});
after(() => { setHermesFetchForTests(null); setOmniRecordSourcesForTests({ resolver: null }); setOmniPusherForTests(null); });
const itemCardEvents = (threadId: string) => eventsAfter(threadId, 0).filter((e) => e.payload.t === "item_card");

test("only the loopback service token may publish a card", async () => {
  assert.equal((await post(cardPublish(), owner())).status, 403);
  assert.equal((await post(cardPublish(), { ...hook, "x-forwarded-for": "8.8.8.8" })).status, 403);
});

test("a new card: one session, a nudge thread bound, an item_card event, an item-card notice and one push", async () => {
  upsertNudge(config.ownerEmail, { sourceId: "mail1", sourcePath: "mail/mail1", kind: "reply-owed", title: "Reply owed", summary: "Budget", reasons: ["Waiting"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false });
  const res = await post(cardPublish());
  assert.equal(res.status, 201);
  const body = await res.json() as { card: { id: string; state: string; threadId: string; section: string } };
  assert.equal(body.card.state, "proposed");
  assert.equal(body.card.section, "decide");
  assert.equal(stub.sessions.size, 1);
  assert.equal(getThread(body.card.threadId)!.taskNoteId, "mail1");
  const nudge = db.prepare("SELECT id FROM omni_nudges WHERE source_id='mail1'").get() as { id: string };
  assert.equal(getNudge(config.ownerEmail, nudge.id)!.threadId, body.card.threadId);
  assert.equal(itemCardEvents(body.card.threadId).length, 1);
  assert.deepEqual(pushes, [`OMNI_CARD:${body.card.id}`]);
  const detail = await omniApi.request(`/threads/${body.card.threadId}`, { headers: owner() });
  const view = await detail.json() as { itemCards: Array<{ id: string }> };
  assert.deepEqual(view.itemCards.map((c) => c.id), [body.card.id]);
});

test("an identical re-publish is a quiet replay; a changed one updates a proposed card without a push", async () => {
  const first = await (await post(cardPublish())).json() as { card: { id: string; threadId: string } };
  const replay = await post(cardPublish());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { changed: boolean }).changed, false);
  const changed = await post(cardPublish({ headline: "Sam sent a corrected budget and still needs your review" }));
  assert.equal((await changed.json() as { changed: boolean }).changed, true);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.headline, "Sam sent a corrected budget and still needs your review");
  assert.equal(itemCardEvents(first.card.threadId).length, 2);
  assert.equal(pushes.length, 1);
});

test("re-publish after the owner acted changes nothing and emits nothing", async () => {
  const first = await (await post(cardPublish())).json() as { card: { id: string; threadId: string } };
  transitionCard(config.ownerEmail, first.card.id, ["proposed"], "working", { action: "choose", optionId: "b" }, { chosenOptionId: "b" });
  const again = await post(cardPublish({ headline: "A fresh take the agent had a minute later" }));
  assert.equal(again.status, 200);
  const aj = (await again.json()) as { ignored?: string; changed: boolean };
  assert.deepEqual([aj.ignored, aj.changed], ["owner_acted", false]);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "working");
  assert.equal(getCard(config.ownerEmail, first.card.id)!.headline, "Sam asks whether you can review the grant budget before Friday");
  assert.equal(itemCardEvents(first.card.threadId).length, 1);
});

test("invalid draft → 400 and no card, no session", async () => {
  const bad = cardPublish({ options: [
    { id: "a", label: "Say yes", plan: "Reply yes", produces: ["email-reply"], draft: { kind: "email-reply", payload: { noteId: "mail1", body: "Yes." } } },
    { id: "b", label: "Not now", plan: "Nothing", produces: ["nothing"] },
  ] });
  const res = await post(bad);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_draft", detail: "options[0].draft: expectTo: required" });
  assert.equal(stub.sessions.size, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM omni_item_cards").get() as { n: number }).n, 0);
});

test("evidence must be current and the owner's dismissal holds", async () => {
  assert.equal((await post(cardPublish({ evidence: [] }))).status, 400);
  assert.equal((await post(cardPublish({ sourceRevision: "old", evidence: [{ sourceId: "mail1", revision: "old" }] }))).status, 409);
  setOmniRecordSourcesForTests({ resolver: async () => null });
  assert.equal((await post(cardPublish())).status, 422);
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: revision }) });
  const n = upsertNudge(config.ownerEmail, { sourceId: "mail1", sourcePath: "mail/mail1", kind: "reply-owed", title: "Reply owed", summary: "x", reasons: ["x"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false });
  nudgeAction(config.ownerEmail, n.id, "dismiss");
  const res = await post(cardPublish());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "source_suppressed" });
  assert.equal(stub.sessions.size, 0);
});

test("dismissing a card suppresses only its current revision: same revision ignored, a new one reopens", async () => {
  upsertNudge(config.ownerEmail, { sourceId: "mail1", sourcePath: "mail/mail1", kind: "reply-owed", title: "Reply owed", summary: "x", reasons: ["x"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false });
  const first = (await (await post(cardPublish())).json()) as { card: { id: string } };
  dismissCard(config.ownerEmail, first.card.id, "not-needed");
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "dismissed");
  const same = await post(cardPublish());
  assert.equal(same.status, 200);
  assert.equal(((await same.json()) as { ignored?: string }).ignored, "owner_acted");
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "dismissed");
  const rev2 = "2026-10-15T11:00:00Z";
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: rev2 }) });
  const res = await post(cardPublish({ sourceRevision: rev2, evidence: [{ sourceId: "mail1", revision: rev2 }] }));
  assert.equal(res.status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "proposed");
});

test("a reopened card stays updatable: the nudge's dismissal is cleared", async () => {
  const n = upsertNudge(config.ownerEmail, { sourceId: "mail1", sourcePath: "mail/mail1", kind: "reply-owed", title: "Reply owed", summary: "x", reasons: ["x"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false });
  const first = (await (await post(cardPublish())).json()) as { card: { id: string } };
  dismissCard(config.ownerEmail, first.card.id, "not-needed");
  const at = (rev: string, over: Record<string, unknown> = {}) => {
    setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: rev }) });
    return post(cardPublish({ sourceRevision: rev, evidence: [{ sourceId: "mail1", revision: rev }], ...over }));
  };
  assert.equal((await at("2026-10-15T11:00:00Z")).status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "proposed");
  assert.equal(getNudge(config.ownerEmail, n.id)!.dismissed, false);
  const r3 = await at("2026-10-15T12:00:00Z");
  assert.equal(r3.status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.sourceRevision, "2026-10-15T12:00:00Z");
  const r4 = await at("2026-10-15T12:00:00Z", { headline: "Sam still needs the budget reviewed before Friday" });
  assert.equal(r4.status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.headline, "Sam still needs the budget reviewed before Friday");
});

test("a resolved nudge always suppresses; only the sweep's upsert un-resolves it", async () => {
  const cand = { sourceId: "mail1", sourcePath: "mail/mail1", kind: "reply-owed" as const, title: "Reply owed", summary: "x", reasons: ["x"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false };
  upsertNudge(config.ownerEmail, cand);
  const first = (await (await post(cardPublish())).json()) as { card: { id: string } };
  transitionCard(config.ownerEmail, first.card.id, ["proposed"], "sent", { action: "sent" });
  resolveNudgeSource(config.ownerEmail, "mail1");
  const rev2 = "2026-10-15T11:00:00Z";
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: rev2 }) });
  const body = cardPublish({ sourceRevision: rev2, evidence: [{ sourceId: "mail1", revision: rev2 }] });
  const res = await post(body);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "source_suppressed" });
  upsertNudge(config.ownerEmail, cand);
  assert.equal((await post(body)).status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "proposed");
});

test("context facts: unknown vault citations are dropped; null, calendar and itemRefs stay", async () => {
  setOmniRecordSourcesForTests({ resolver: async ({ id, path }) => (id === "mail1" ? { id, path: "mail/mail1", tags: ["email"], updatedAt: revision } : path === "projects/real" ? { id: "proj1", path, tags: [], updatedAt: revision } : null) });
  const res = await post(cardPublish({ context: [
    { text: "free Thursday", source: "calendar" }, { text: "from the mail", source: "mail1" },
    { text: "real note", source: "projects/real" }, { text: "made up", source: "nowhere/ghost" },
  ] }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { card: { id: string }; droppedFacts: number };
  assert.equal(body.droppedFacts, 1);
  assert.deepEqual(getCard(config.ownerEmail, body.card.id)!.context.map((f) => f.text), ["free Thursday", "from the mail", "real note"]);
});

test("a finished card reopens with a push when the item's revision changes", async () => {
  const first = (await (await post(cardPublish())).json()) as { card: { id: string } };
  transitionCard(config.ownerEmail, first.card.id, ["proposed"], "done", { action: "done" });
  const rev2 = "2026-10-15T11:00:00Z";
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: rev2 }) });
  const res = await post(cardPublish({ sourceRevision: rev2, evidence: [{ sourceId: "mail1", revision: rev2 }] }));
  assert.equal(res.status, 200);
  assert.equal(getCard(config.ownerEmail, first.card.id)!.state, "proposed");
  assert.equal(pushes.length, 2);
});


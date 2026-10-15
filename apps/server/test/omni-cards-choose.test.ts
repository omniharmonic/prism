import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642"; process.env.OMNI_HERMES_KEY = "test-hermes-key-0123456789";
import { omniApi, setOmniExecutorForTests } from "../src/routes/omni";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { resetOmniStoreForTests, eventsAfter } from "../src/omni/store";
import { resetNudgesForTests } from "../src/omni/nudges";
import { resetCardsForTests, getCard } from "../src/omni/cards";
import { setOmniPusherForTests } from "../src/omni/bus";
import { approvalDigest, listApprovals } from "../src/omni/approvals";
import { turnSettled } from "../src/omni/turns";
import { cardPublish } from "./omni-card-samples";

const revision = "2026-10-15T10:00:00Z";
const J = { "content-type": "application/json" };
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const ownerH = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
let stub: ReturnType<typeof createHermesStub>;
let said: string[] = [];
let executed = 0;
let pushes: string[] = [];
beforeEach(() => {
  resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); said = []; executed = 0; pushes = [];
  stub = createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: (ctx) => { said.push(ctx.message); return { acts: [{ say: "Working on it." }] }; } });
  setHermesFetchForTests(stub.fetch);
  setOmniExecutorForTests(async () => { executed += 1; return { status: "sent", detail: { executor: "test" } }; });
  setOmniPusherForTests(async (_o, kind, id) => { pushes.push(`${kind}:${id}`); });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: revision }) });
});
after(() => { setHermesFetchForTests(null); setOmniExecutorForTests(null); setOmniPusherForTests(null); setOmniRecordSourcesForTests({ resolver: null }); });

const publish = async (over: Record<string, unknown> = {}) =>
  ((await (await omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish(over)) })).json()) as { card: { id: string; threadId: string } }).card;
const choose = (id: string, optionId: string, key: string | null = "choose-key-0001", headers: Record<string, string> = ownerH()) =>
  omniApi.request(`/cards/${id}/choose`, { method: "POST", headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify({ optionId }) });
type Answer = { card: { state: string; approvalIds: string[]; chosenOptionId: string | null }; approval: { id: string; status: string; digest: string; threadId: string } | null; turnId: string | null };

test("choosing is the owner's: human origin and an Idempotency-Key are required", async () => {
  const card = await publish();
  assert.equal((await choose(card.id, "a", "choose-key-0001", { ...ownerH(), "x-prism-action-origin": "agent" })).status, 403);
  assert.equal((await choose(card.id, "a", null)).status, 400);
  assert.equal((await choose(card.id, "z")).status, 400);
  assert.equal((await choose(card.id, "a", "choose-key-0001", hook)).status, 401);
  assert.equal(getCard(config.ownerEmail, card.id)!.state, "proposed");
});

test("an option with a draft becomes a pending approval in the card's thread; nothing is executed or pushed", async () => {
  const card = await publish();
  const pushesBefore = pushes.length;
  const res = await choose(card.id, "a");
  assert.equal(res.status, 201);
  const body = await res.json() as Answer;
  assert.equal(body.card.state, "draft-ready");
  assert.equal(body.card.chosenOptionId, "a");
  assert.equal(body.approval!.status, "pending");
  assert.deepEqual(body.card.approvalIds, [body.approval!.id]);
  assert.equal(body.approval!.threadId, card.threadId);
  assert.equal(body.approval!.digest, approvalDigest("email-reply", { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nThursday afternoon works. I'll send comments by 4.\n\nBenjamin" }));
  assert.equal(body.turnId, null);
  assert.equal(said.length, 0, "no model turn for a ready draft");
  assert.equal(executed, 0);
  assert.equal(pushes.length, pushesBefore);
  const kinds = eventsAfter(card.threadId, 0).map((e) => e.payload.t);
  assert.ok(kinds.includes("approval"));
  assert.equal(kinds.filter((k) => k === "item_card").length, 2);
});

test("same key after a lost answer replays: one approval, one turn", async () => {
  const card = await publish();
  const first = await (await choose(card.id, "a", "lost-answer-0001")).json() as Answer;
  const again = await choose(card.id, "a", "lost-answer-0001");
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal((await again.json() as Answer).approval!.id, first.approval!.id);
  assert.equal(listApprovals(config.ownerEmail, "pending").length, 1);
  assert.equal((await choose(card.id, "a", "a-second-key-0002")).status, 409);
  const conflict = await choose(card.id, "b", "lost-answer-0001");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "idempotency_conflict");

  const other = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const started = await choose(other.id, "b", "plan-key-0001");
  assert.equal(started.status, 202);
  const s = await started.json() as Answer;
  assert.equal(s.card.state, "working");
  await turnSettled(s.turnId!);
  const replay = await choose(other.id, "b", "plan-key-0001");
  assert.equal((await replay.json() as Answer).turnId, s.turnId);
  assert.equal(said.length, 1, "one turn, however many times the answer was lost");
  assert.match(said[0]!, /His choice: Ask to push to Monday\./);
  assert.match(said[0]!, /prepared by Omni earlier, chosen by Benjamin/);
  assert.match(said[0]!, /\[Prism notes referenced \(read them with your Prism tools\): mail2\]/);
});

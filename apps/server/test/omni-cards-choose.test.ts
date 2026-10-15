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
import { resetOmniStoreForTests, eventsAfter, auditRows } from "../src/omni/store";
import { resetNudgesForTests } from "../src/omni/nudges";
import { resetCardsForTests, getCard } from "../src/omni/cards";
import { setOmniPusherForTests, subscribeNotices } from "../src/omni/bus";
import { approvalDigest, listApprovals } from "../src/omni/approvals";
import { turnSettled, startTurn } from "../src/omni/turns";
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

const instruct = (id: string, text: string, key: string | null = "instruct-key-0001") =>
  omniApi.request(`/cards/${id}/instruct`, { method: "POST", headers: { ...ownerH(), ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify({ text }) });

test("something else: his own words start a turn in the card's thread", async () => {
  const card = await publish();
  assert.equal((await instruct(card.id, "   ")).status, 400);
  assert.equal((await instruct(card.id, "Tell her yes", null)).status, 400);
  assert.equal((await omniApi.request(`/cards/${card.id}/instruct`, { method: "POST", headers: { ...ownerH(), "x-prism-action-origin": "agent", "idempotency-key": "instruct-key-0001" }, body: JSON.stringify({ text: "x" }) })).status, 403);
  assert.equal(getCard(config.ownerEmail, card.id)!.state, "proposed");
  const res = await instruct(card.id, "Say yes but ask for the sheet as a PDF first.");
  assert.equal(res.status, 202);
  const body = await res.json() as Answer;
  assert.equal(body.card.state, "working");
  assert.equal(body.approval, null);
  await turnSettled(body.turnId!);
  assert.match(said[0]!, /His own words:\nSay yes but ask for the sheet as a PDF first\./);
  assert.match(said[0]!, /\[Prism notes referenced \(read them with your Prism tools\): mail1\]/);
  const replay = await instruct(card.id, "Say yes but ask for the sheet as a PDF first.");
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal((await replay.json() as Answer).turnId, body.turnId);
  assert.equal(said.length, 1);
  const conflict = await instruct(card.id, "Something different entirely.");
  assert.equal(conflict.status, 409);
});

test("something else on a ready draft cancels the pending draft: one card, one live draft", async () => {
  const card = await publish();
  const ready = await (await choose(card.id, "a", "choose-then-instruct-1")).json() as Answer;
  assert.equal(listApprovals(config.ownerEmail, "pending").length, 1);
  const res = await instruct(card.id, "Actually ask for the PDF first.");
  assert.equal(res.status, 202);
  const body = await res.json() as Answer;
  assert.equal(body.card.state, "working");
  assert.equal(listApprovals(config.ownerEmail, "pending").length, 0);
  const cancelled = listApprovals(config.ownerEmail, "cancelled");
  assert.deepEqual(cancelled.map((a) => a.id), [ready.approval!.id]);
  const audit = auditRows().filter((r) => r.action === "approval.cancel");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.approval_id, ready.approval!.id);
  assert.equal(audit[0]!.actor, config.ownerEmail);
  await turnSettled(body.turnId!);
  assert.equal(said.length, 1);
  const send = await omniApi.request(`/approvals/${ready.approval!.id}/decision`, { method: "POST", headers: { ...ownerH(), "idempotency-key": "send-cancelled-0001" }, body: JSON.stringify({ decision: "send", digest: ready.approval!.digest }) });
  assert.equal(send.status, 409);
  assert.equal(executed, 0);
});

test("something else on a working card is refused and changes nothing", async () => {
  const card = await publish();
  const first = await (await instruct(card.id, "Do the first thing.", "instruct-first-01")).json() as Answer;
  const again = await instruct(card.id, "Do another thing.", "instruct-second-1");
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { error: string }).error, "turn_running");
  // The first turn may already have ended (the turn-ended hook returns the card to Decide); the refused one changed nothing.
  const after = getCard(config.ownerEmail, card.id)!;
  assert.ok(after.state === "working" || (after.state === "proposed" && after.outcomes.at(-1)!.action === "turn-ended"));
  assert.equal(after.outcomes.filter((o) => o.action === "instruct").length, 1);
  await turnSettled(first.turnId!);
  assert.equal(said.length, 1);
});

test("something else: a failing side effect never leaves a draft pending", async () => {
  const card = await publish();
  const ready = await (await choose(card.id, "a", "choose-then-instruct-2")).json() as Answer;
  const off = subscribeNotices(() => { throw new Error("subscriber down"); });
  try {
    const res = await instruct(card.id, "Ask for the PDF first.");
    assert.equal(res.status, 202);
    const body = (await res.json()) as Answer;
    assert.equal(body.card.state, "working");
    await turnSettled(body.turnId!);
  } finally { off(); }
  assert.equal(listApprovals(config.ownerEmail, "pending").length, 0);
  assert.deepEqual(listApprovals(config.ownerEmail, "cancelled").map((a) => a.id), [ready.approval!.id]);
  const rows = auditRows().filter((r) => r.action === "approval.cancel");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.approval_id, ready.approval!.id);
  assert.equal(rows[0]!.actor, config.ownerEmail);
  assert.equal(rows[0]!.status, "ok");
});

test("something else on a ready draft while a turn runs in its thread: refused, card and draft untouched", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  stub = createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: async (ctx) => { said.push(ctx.message); await gate; return { acts: [{ say: "ok" }] }; } });
  setHermesFetchForTests(stub.fetch);
  const card = await publish();
  const ready = await (await choose(card.id, "a", "choose-then-instruct-3")).json() as Answer;
  const running = startTurn(card.threadId, "revise it", "direct-turn-0001");
  assert.ok("turn" in running);
  const res = await instruct(card.id, "Ask for the PDF first.", "instruct-busy-001");
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { error: string }).error, "turn_running");
  const after = getCard(config.ownerEmail, card.id)!;
  assert.equal(after.state, "draft-ready");
  assert.equal(after.chosenOptionId, "a");
  assert.deepEqual(listApprovals(config.ownerEmail, "pending").map((a) => a.id), [ready.approval!.id]);
  assert.equal(auditRows().filter((r) => r.action === "approval.cancel").length, 0);
  release();
  await turnSettled(running.turn.id);
});

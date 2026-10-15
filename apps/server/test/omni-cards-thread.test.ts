import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642"; process.env.OMNI_HERMES_KEY = "test-hermes-key-0123456789";
import { omniApi } from "../src/routes/omni";
import { config } from "../src/config";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { resetOmniStoreForTests, eventsAfter } from "../src/omni/store";
import { resetNudgesForTests } from "../src/omni/nudges";
import { resetCardsForTests, getCard, transitionCard, replaceCardContent, parseCardInput } from "../src/omni/cards";
import { replaceFailure, resolveCardSource } from "../src/omni/card-flow";
import { startTurn, turnSettled } from "../src/omni/turns";
import { setOmniPusherForTests } from "../src/omni/bus";
import { cardPublish } from "./omni-card-samples";

const owner = config.ownerEmail;
const revision = "2026-10-15T10:00:00Z";
const J = { "content-type": "application/json" };
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
let pushes: string[] = [];
beforeEach(() => {
  resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); pushes = [];
  setHermesFetchForTests(createHermesStub({ key: process.env.OMNI_HERMES_KEY! }).fetch);
  setOmniPusherForTests(async (_o, kind, id) => { pushes.push(`${kind}:${id}`); });
  setOmniRecordSourcesForTests({ resolver: async ({ id, path }) => { const k = id ?? path; return k === "ghost" || !k ? null : { id: k, path: `mail/${k}`, tags: ["email"], updatedAt: revision }; } });
});
after(() => { setHermesFetchForTests(null); setOmniPusherForTests(null); setOmniRecordSourcesForTests({ resolver: null }); });
const publish = async () => ((await (await omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish()) })).json()) as { card: { id: string; threadId: string } }).card;
const update = (body: Record<string, unknown>, headers: Record<string, string> = hook) => omniApi.request("/hooks/cards/thread", { method: "POST", headers, body: JSON.stringify(body) });
const errOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const newOptions = [
  { id: "mon", label: "Offer Monday 10am", plan: "Reply offering Monday at 10", produces: ["email-reply"], draft: { kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nCould we do Monday at 10?\n\nBenjamin" } } },
  { id: "kevin", label: "Hand it to Kevin", plan: "Forward to Kevin with a note", produces: ["email"] },
];

test("the card's turn posts new options: the card is back in Decide, in the thread and on the lock screen", async () => {
  const card = await publish();
  transitionCard(owner, card.id, ["proposed"], "working", { action: "choose", optionId: "b" });
  const res = await update({ threadId: card.threadId, options: newOptions, recommended: "mon", ask: "Sam can't do Thursday; pick another time" });
  assert.equal(res.status, 200);
  const after = getCard(owner, card.id)!;
  assert.equal(after.state, "proposed");
  assert.deepEqual(after.options.map((o) => o.id), ["mon", "kevin"]);
  assert.equal(after.headline, "Sam asks whether you can review the grant budget before Friday", "fields not sent are kept");
  assert.equal(after.chosenOptionId, null);
  assert.equal(eventsAfter(card.threadId, 0).filter((e) => e.payload.t === "item_card").length, 2, "published, then updated");
  assert.deepEqual(pushes, [`OMNI_CARD:${card.id}`, `OMNI_CARD:${card.id}`]);
});

test("refusals: unknown thread, the owner's credential, a waiting draft, an invalid draft", async () => {
  const card = await publish();
  assert.equal((await update({ threadId: "omni_0123456789abcdef01234567", options: newOptions })).status, 404);
  assert.equal((await update({ threadId: card.threadId, options: newOptions }, { ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) })).status, 403);
  const bad = await update({ threadId: card.threadId, options: [{ ...newOptions[0], draft: { kind: "email-reply", payload: { body: "x" } } }, newOptions[1]], recommended: "mon" });
  assert.equal(bad.status, 400);
  assert.equal(getCard(owner, card.id)!.options[0]!.id, "a");
  transitionCard(owner, card.id, ["proposed"], "draft-ready", { action: "choose", optionId: "a" });
  const waiting = await update({ threadId: card.threadId, options: newOptions });
  assert.equal(waiting.status, 409);
  assert.equal(await errOf(waiting), "draft_waiting");
});

test("a closed card is card_not_open (409), distinct from an unknown thread (404)", async () => {
  const card = await publish();
  transitionCard(owner, card.id, ["proposed"], "dismissed", { action: "dismiss" });
  const res = await update({ threadId: card.threadId, options: newOptions });
  assert.equal(res.status, 409);
  assert.equal(await errOf(res), "card_not_open");
  assert.equal(await errOf(await update({ threadId: "omni_0123456789abcdef01234567", options: newOptions })), "no_card_for_thread");
});

test("replaceFailure tells missing, wrong source and wrong state apart", async () => {
  const card = await publish();
  const input = parseCardInput({ ...cardPublish(), sourceRevision: revision });
  assert.equal(replaceCardContent(owner, "nope", input, ["proposed"]), null);
  assert.equal(replaceFailure(owner, "nope", "mail1").code, "card_not_found");
  assert.equal(replaceFailure(owner, "nope", "mail1").status, 404);
  assert.equal(replaceCardContent(owner, card.id, { ...input, sourceKey: "other" }, ["proposed"]), null);
  assert.equal(replaceFailure(owner, card.id, "other").code, "card_source_mismatch");
  assert.equal(replaceFailure(owner, card.id, "other").status, 409);
  assert.equal(replaceCardContent(owner, card.id, input, ["working"]), null);
  assert.equal(replaceFailure(owner, card.id, "mail1").code, "card_not_open");
});

test("a card answered elsewhere while its turn runs refuses the post (card_resolved)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  setHermesFetchForTests(createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: async () => { await gate; return { acts: [{ say: "ok" }] }; } }).fetch);
  const card = await publish();
  const running = startTurn(card.threadId, "look at it", "direct-turn-0010");
  assert.ok("turn" in running);
  if (!("turn" in running)) return;
  resolveCardSource(owner, "mail1");
  const res = await update({ threadId: card.threadId, options: newOptions });
  assert.equal(res.status, 409);
  assert.equal(await errOf(res), "card_resolved");
  assert.deepEqual(getCard(owner, card.id)!.options.map((o) => o.id), ["a", "b"]);
  release();
  await turnSettled(running.turn.id);
});

test("posted context goes through the source filter: unresolvable sources are dropped and counted", async () => {
  const card = await publish();
  const res = await update({ threadId: card.threadId, options: newOptions, recommended: "mon", context: [{ text: "from the calendar", source: "calendar" }, { text: "invented", source: "ghost" }, { text: "unsourced", source: null }] });
  assert.equal(res.status, 200);
  const body = await res.json() as { droppedFacts: number };
  assert.equal(body.droppedFacts, 1);
  assert.deepEqual(getCard(owner, card.id)!.context.map((f) => f.text), ["from the calendar", "unsourced"]);
});

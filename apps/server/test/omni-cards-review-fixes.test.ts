import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642"; process.env.OMNI_HERMES_KEY = "test-hermes-key-0123456789";
process.env.OMNI_PROTON_SEND = process.execPath; // "configured": the executor itself is the test's fake
import { omniApi, setOmniExecutorForTests } from "../src/routes/omni";
import { config } from "../src/config";
import { db } from "../src/db";
import { resetDb, makeSession, sessionCookie } from "./helpers";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { resetOmniStoreForTests, eventsAfter } from "../src/omni/store";
import { resetNudgesForTests } from "../src/omni/nudges";
import { resetCardsForTests, getCard, transitionCard } from "../src/omni/cards";
import { setOmniPusherForTests } from "../src/omni/bus";
import { getApproval, type ExecOutcome } from "../src/omni/approvals";
import { startTurn, turnSettled } from "../src/omni/turns";
import { setParticipantsReaderForTests, draftRecipients } from "../src/omni/recipients";
import { cardPublish, seenVersion } from "./omni-card-samples";

/** Final whole-branch review fixes (Important 1–5, Minors 1, 2). */
const owner = config.ownerEmail;
const revision = "2026-10-15T10:00:00Z";
const J = { "content-type": "application/json" };
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const ownerH = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
let executed = 0;
let outcome: ExecOutcome = { status: "sent", detail: { executor: "test" } };
let pushes: string[] = [];
let onItem: string[] | null = ["sam@example.com"];
let rev = revision;
beforeEach(() => {
  resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); executed = 0; pushes = []; onItem = ["sam@example.com"]; rev = revision;
  outcome = { status: "sent", detail: { executor: "test" } };
  setHermesFetchForTests(createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: () => ({ acts: [{ say: "On it." }] }) }).fetch);
  setOmniExecutorForTests(async () => { executed += 1; return outcome; });
  setOmniPusherForTests(async (_o, kind, id) => { pushes.push(`${kind}:${id}`); });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: rev }) });
  setParticipantsReaderForTests(async () => onItem);
});
after(() => { setParticipantsReaderForTests(null); setHermesFetchForTests(null); setOmniExecutorForTests(null); setOmniPusherForTests(null); setOmniRecordSourcesForTests({ resolver: null }); });

type Answer = { card: { state: string }; approval: { id: string; digest: string } | null; turnId: string | null };
const publishRaw = (over: Record<string, unknown> = {}) => omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish(over)) });
const publish = async (over: Record<string, unknown> = {}) => ((await (await publishRaw(over)).json()) as { card: { id: string; threadId: string } }).card;
const chooseRaw = (id: string, optionId: string, key: string, version: string | null = seenVersion(owner, id)) =>
  omniApi.request(`/cards/${id}/choose`, { method: "POST", headers: { ...ownerH(), "idempotency-key": key }, body: JSON.stringify({ optionId, ...(version === null ? {} : { cardVersion: version }) }) });
const choose = async (id: string, optionId: string, key: string) => (await (await chooseRaw(id, optionId, key)).json()) as Answer;
const instructRaw = (id: string, text: string, key: string, version: string = seenVersion(owner, id)) =>
  omniApi.request(`/cards/${id}/instruct`, { method: "POST", headers: { ...ownerH(), "idempotency-key": key }, body: JSON.stringify({ text, cardVersion: version }) });
const decide = (id: string, digest: string, decision: string, key: string) =>
  omniApi.request(`/approvals/${id}/decision`, { method: "POST", headers: { ...ownerH(), "idempotency-key": key }, body: JSON.stringify({ decision, digest }) });
const dismiss = (id: string) => omniApi.request(`/cards/${id}/dismiss`, { method: "POST", headers: ownerH(), body: JSON.stringify({ reason: "not-needed" }) });
const propose = async (body: Record<string, unknown>) =>
  (await (await omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify(body) })).json()) as { id: string; digest: string };
const errOf = async (r: Response) => ((await r.json()) as { error: string }).error;

// ── Important 1: a card's thread is known to the bridge ──────────────────────

test("the bridge can ask whether a thread is an item card's thread (hook auth only)", async () => {
  const card = await publish();
  const ask = (id: string, h: Record<string, string> = hook) => omniApi.request(`/hooks/cards/thread/${id}`, { headers: h });
  assert.deepEqual(await (await ask(card.threadId)).json(), { carded: true });
  assert.deepEqual(await (await ask("omni_0000000000000000000000ff")).json(), { carded: false });
  assert.equal((await ask(card.threadId, ownerH())).status, 403, "an owner cookie is not the bridge");
});

// ── Important 2: a draft that can no longer be sent never strands the card ──

test("an expired draft puts the card back in Decide (draft-expired) so he can choose again", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  db.prepare("UPDATE omni_approvals SET expires_at=1 WHERE id=?").run(r.approval!.id);
  const list = (await (await omniApi.request("/cards", { headers: ownerH() })).json()) as { cards: Array<{ id: string; state: string; section: string }>; counts: Record<string, number> };
  assert.equal(getApproval(owner, r.approval!.id)!.status, "expired");
  const c = getCard(owner, card.id)!;
  assert.deepEqual([c.state, c.chosenOptionId, c.outcomes.at(-1)!.action, c.outcomes.at(-1)!.approvalId], ["proposed", null, "draft-expired", r.approval!.id]);
  assert.deepEqual([list.cards[0]!.section, list.counts.approve, list.counts.decide], ["decide", 0, 1], "Approve no longer counts it");
  assert.equal((await chooseRaw(card.id, "a", "choose-key-0002")).status, 201, "and he can choose again");
});

test("a failed or unknown send puts the card back in Decide (draft-failed); GET /cards/:id settles it too", async () => {
  for (const [i, status] of (["failed", "unknown"] as const).entries()) {
    const card = await publish({ sourceKey: `mail${i + 3}`, itemRefs: [`mail${i + 3}`] });
    const r = await choose(card.id, "a", `choose-key-100${i}`);
    outcome = { status, detail: { executor: "test" } };
    await decide(r.approval!.id, r.approval!.digest, "send", `send-key-0000${i}`);
    const c = getCard(owner, card.id)!;
    assert.deepEqual([c.state, c.outcomes.at(-1)!.action, c.outcomes.at(-1)!.detail], ["proposed", "draft-failed", status], status);
  }
  // A failed approval the decision did not reach (bookkeeping lost): the read route settles the card.
  const card = await publish({ sourceKey: "mail9", itemRefs: ["mail9"] });
  const r = await choose(card.id, "a", "choose-key-2000");
  db.prepare("UPDATE omni_approvals SET status='failed' WHERE id=?").run(r.approval!.id);
  const one = (await (await omniApi.request(`/cards/${card.id}`, { headers: ownerH() })).json()) as { card: { state: string } };
  assert.equal(one.card.state, "proposed");
});

test("Not needed on a draft-ready card closes it and cancels its draft; never while a send is under way", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  const res = await dismiss(card.id);
  assert.equal(res.status, 200);
  assert.equal(getCard(owner, card.id)!.state, "dismissed");
  assert.equal(getApproval(owner, r.approval!.id)!.status, "cancelled");
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001")).status, 409, "the cancelled draft can never be sent");
  assert.equal(executed, 0);

  const other = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const r2 = await choose(other.id, "a", "choose-key-0002");
  db.prepare("UPDATE omni_approvals SET status='approved' WHERE id=?").run(r2.approval!.id);
  const busy = await dismiss(other.id);
  assert.deepEqual([busy.status, await errOf(busy)], [409, "send_in_flight"]);
  assert.equal(getCard(owner, other.id)!.state, "draft-ready");
});

test("Something else on a draft-ready card retires the draft and starts his turn", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  const res = await instructRaw(card.id, "Say yes but ask for the PDF first", "instruct-key-0001");
  assert.equal(res.status, 202);
  assert.equal(getApproval(owner, r.approval!.id)!.status, "cancelled");
  assert.equal(getCard(owner, card.id)!.state, "working");
  await turnSettled(((await res.json()) as { turnId: string }).turnId);
});

// ── Important 3: a new message while his draft waits ─────────────────────────

test("a new message on a draft-ready card flags it, keeps the draft pending and unsent, and tells him", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  pushes = [];
  rev = "2026-10-15T12:00:00Z";
  const res = await publishRaw({ sourceRevision: rev, evidence: [{ sourceId: "mail1", revision: rev }], context: [{ text: "Sam wrote again: Monday is better", source: "mail1" }] });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { flagged?: string; changed: boolean; ignored?: string; card: { sourceChanged: boolean; state: string } };
  assert.deepEqual([body.flagged, body.changed, body.ignored, body.card.sourceChanged, body.card.state], ["source_changed", true, undefined, true, "draft-ready"]);
  assert.equal(getApproval(owner, r.approval!.id)!.status, "pending", "not cancelled");
  assert.equal(executed, 0, "not sent");
  assert.deepEqual(getCard(owner, card.id)!.context, [{ text: "Sam wrote again: Monday is better", source: "mail1" }]);
  assert.deepEqual(pushes, [`OMNI_CARD:${card.id}`]);
  const events = eventsAfter(card.threadId, 0).filter((e) => e.payload.t === "item_card");
  assert.equal((events.at(-1)!.payload.card as { sourceChanged: boolean }).sourceChanged, true);
  // The approval stays decidable: Send still works (he saw the warning), and the card is then sent.
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001")).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "sent");
});

test("a new message while his turn runs flags the card; the same revision again is still ignored", async () => {
  const card = await publish();
  transitionCard(owner, card.id, ["proposed"], "working", { action: "choose", optionId: "b" }, { chosenOptionId: "b" });
  rev = "2026-10-15T12:00:00Z";
  const first = (await (await publishRaw({ sourceRevision: rev, evidence: [{ sourceId: "mail1", revision: rev }] })).json()) as { flagged?: string };
  assert.equal(first.flagged, "source_changed");
  assert.equal(getCard(owner, card.id)!.state, "working");
  const again = (await (await publishRaw({ sourceRevision: rev, evidence: [{ sourceId: "mail1", revision: rev }] })).json()) as { ignored?: string };
  assert.equal(again.ignored, "owner_acted");
});

// ── Important 4: choose / instruct against the card he saw ───────────────────

test("choose and instruct carry the card version: a changed card answers 409 card_changed and runs nothing", async () => {
  const card = await publish();
  const seen = seenVersion(owner, card.id);
  assert.equal((await chooseRaw(card.id, "a", "choose-key-0001", null)).status, 400, "the version is required");
  // The agent's next tick replaces the options under the same ids while the device still shows the old card.
  const changed = await publishRaw({ options: [
    { id: "a", label: "Decline politely", plan: "Reply declining", produces: ["email-reply"], draft: { kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Sorry, no." } } },
    { id: "b", label: "Ask to push to Monday", plan: "Reply proposing Monday instead", produces: ["email-reply"] },
  ] });
  assert.equal(changed.status, 200);
  assert.notEqual(seenVersion(owner, card.id), seen);
  const stale = await chooseRaw(card.id, "a", "choose-key-0002", seen);
  assert.deepEqual([stale.status, await errOf(stale)], [409, "card_changed"]);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
  const staleWords = await instructRaw(card.id, "Tell him yes", "instruct-key-0001", seen);
  assert.deepEqual([staleWords.status, await errOf(staleWords)], [409, "card_changed"]);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
  // A device that refreshed sends the new version and goes through; the same key then replays.
  assert.equal((await chooseRaw(card.id, "a", "choose-key-0003")).status, 201);
  assert.equal((await chooseRaw(card.id, "a", "choose-key-0003", seen)).headers.get("idempotent-replayed"), "true");
});

// ── Important 5: a reply goes only to people on the email it answers ────────

test("Send refuses a reply addressed to anyone not on the original email (409 target_changed, still pending)", async () => {
  const card = await publish();
  const injected = await propose({ kind: "email-reply", threadId: card.threadId, payload: { noteId: "mail1", expectTo: ["sam@example.com"], cc: ["assistant@evil.test"], body: "Hi" } });
  const res = await decide(injected.id, injected.digest, "send", "send-key-00001");
  assert.deepEqual([res.status, await errOf(res)], [409, "target_changed"]);
  assert.equal(executed, 0);
  assert.equal(getApproval(owner, injected.id)!.status, "pending", "he can still edit or cancel it");
  onItem = null; // the original email cannot be read: nothing is sent on a guess
  const ok = await propose({ kind: "email-reply", threadId: null, payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi" } });
  assert.equal((await decide(ok.id, ok.digest, "send", "send-key-00002")).status, 409);
  onItem = ["Sam Rivera <SAM@example.com>".replace(/.*<|>/g, "").toLowerCase(), "owner@example.com"];
  assert.equal((await decide(ok.id, ok.digest, "send", "send-key-00003")).status, 200, "the people on it, case-insensitive");
  assert.equal(executed, 1);
});

test("the approval view lists who is on the original item, so the app can mark a new recipient", async () => {
  const card = await publish();
  const a = await propose({ kind: "email-reply", threadId: card.threadId, payload: { noteId: "mail1", expectTo: ["sam@example.com"], cc: ["kevin@example.com"], body: "Hi" } });
  const one = (await (await omniApi.request(`/approvals/${a.id}`, { headers: ownerH() })).json()) as { approval: { originalRecipients: string[] | null } };
  assert.deepEqual(one.approval.originalRecipients, ["sam@example.com"]);
  const list = (await (await omniApi.request("/approvals?status=pending", { headers: ownerH() })).json()) as { approvals: Array<{ id: string; originalRecipients: string[] | null }> };
  assert.deepEqual(list.approvals.find((x) => x.id === a.id)!.originalRecipients, ["sam@example.com"]);
  assert.deepEqual(draftRecipients({ kind: "email-reply", payload: { expectTo: ["Sam@Example.com"], cc: ["kevin@example.com"] } }), ["sam@example.com", "kevin@example.com"]);
});

// ── Minor 2: a draft he asked for arrives as an approval ─────────────────────

test("a draft proposed after his instruction pushes as OMNI_APPROVAL, not as the card", async () => {
  const card = await publish();
  const started = (await (await instructRaw(card.id, "Reply yes", "instruct-key-0001")).json()) as { turnId: string };
  await turnSettled(started.turnId);
  transitionCard(owner, card.id, ["proposed"], "working", { action: "instruct" });
  pushes = [];
  const p = await propose({ kind: "email-reply", threadId: card.threadId, payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Yes." } });
  assert.equal(getCard(owner, card.id)!.state, "draft-ready");
  assert.deepEqual(pushes, [`OMNI_APPROVAL:${p.id}`]);
});

// ── Minor 1: omni_card pushes once per turn, only for new options ───────────

test("omni_card pushes at most once per turn, and only when the options changed", async () => {
  const card = await publish();
  const options = (label: string) => [
    { id: "mon", label, plan: "Reply offering Monday", produces: ["nothing"] },
    { id: "tue", label: "Offer Tuesday", plan: "Reply offering Tuesday", produces: ["nothing"] },
  ];
  const cardPushes = () => pushes.filter((p) => p.startsWith("OMNI_CARD:"));
  const update = (body: Record<string, unknown>) => omniApi.request("/hooks/cards/thread", { method: "POST", headers: hook, body: JSON.stringify({ threadId: card.threadId, ...body }) });
  const turn = startTurn(card.threadId, "work on it", "turn-key-000001");
  assert.ok("turn" in turn);
  pushes = [];
  assert.equal((await update({ options: options("Offer Monday") })).status, 200);
  assert.equal((await update({ options: options("Offer Monday morning") })).status, 200);
  assert.equal((await update({ options: options("Offer Monday morning"), ask: "Same options, new wording" })).status, 200);
  assert.deepEqual(cardPushes(), [`OMNI_CARD:${card.id}`], "one alert for the turn");
  await turnSettled(turn.turn.id);
  pushes = [];
  assert.equal((await update({ options: options("Offer Monday morning"), ask: "Unchanged options" })).status, 200);
  assert.deepEqual(cardPushes(), [], "no new options, no alert");
  assert.equal((await update({ options: options("Offer Monday at 9") })).status, 200);
  assert.deepEqual(cardPushes(), [`OMNI_CARD:${card.id}`]);
});

// ── Round 2 ─────────────────────────────────────────────────────────────────

const editDraft = (id: string, digest: string, payload: Record<string, unknown>) =>
  omniApi.request(`/approvals/${id}`, { method: "PUT", headers: ownerH(), body: JSON.stringify({ digest, payload }) });

test("N2: a reply-all keeps the original Cc; an older email with no Cc on record says why", async () => {
  const card = await publish();
  setParticipantsReaderForTests(async () => ({ addresses: ["sam@example.com", "pat@example.org"], hasCc: true }));
  const all = await propose({ kind: "email-reply", threadId: card.threadId, payload: { noteId: "mail1", expectTo: ["sam@example.com"], cc: ["Pat@Example.org"], body: "Hi all" } });
  assert.equal((await decide(all.id, all.digest, "send", "send-key-00001")).status, 200, "the original Cc is on the email");
  setParticipantsReaderForTests(async () => ({ addresses: ["sam@example.com"], hasCc: false }));
  const old = await propose({ kind: "email-reply", threadId: null, payload: { noteId: "mail1", expectTo: ["sam@example.com"], cc: ["pat@example.org"], body: "Hi all" } });
  const res = await decide(old.id, old.digest, "send", "send-key-00002");
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "target_changed", detail: "This older email has no Cc on record; remove the Cc or reply from your mail app." });
  // An extra To on an older email is the ordinary refusal (it is not about a missing Cc record).
  const extraTo = await propose({ kind: "email-reply", threadId: null, payload: { noteId: "mail1", expectTo: ["sam@example.com", "x@evil.test"], body: "Hi" } });
  const r2 = (await (await decide(extraTo.id, extraTo.digest, "send", "send-key-00003")).json()) as { detail: string };
  assert.match(r2.detail, /not on the original email/);
  assert.equal(executed, 1);
});

test("unknown send: that draft can never be approved again; the card says check Sent and a new choice is a NEW draft", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  outcome = { status: "unknown", detail: { executor: "test" } };
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001")).status, 502);
  assert.equal(getApproval(owner, r.approval!.id)!.status, "unknown");
  outcome = { status: "sent", detail: { executor: "test" } };
  // Re-deciding with another key, any decision, or editing it: refused, nothing executes.
  for (const [decision, key] of [["send", "send-key-00002"], ["cancel", "cancel-key-0001"], ["revise", "revise-key-0001"]] as const) {
    const again = await decide(r.approval!.id, r.approval!.digest, decision, key);
    assert.deepEqual([again.status, ((await again.json()) as { error: string }).error], [409, "already_decided"], decision);
  }
  assert.equal((await editDraft(r.approval!.id, r.approval!.digest, { noteId: "mail1", expectTo: ["sam@example.com"], body: "Edited" })).status, 409);
  assert.equal(executed, 1, "sent at most once");
  const c = getCard(owner, card.id)!;
  assert.deepEqual([c.state, c.outcomes.at(-1)!.action, c.outcomes.at(-1)!.detail], ["proposed", "draft-failed", "unknown"]);
  // Choosing again is a NEW pending draft; the unknown one stays unknown.
  const again = await choose(card.id, "a", "choose-key-0002");
  assert.notEqual(again.approval!.id, r.approval!.id);
  assert.equal(getApproval(owner, again.approval!.id)!.status, "pending");
  assert.equal(getApproval(owner, r.approval!.id)!.status, "unknown");
  assert.deepEqual(getCard(owner, card.id)!.approvalIds, [r.approval!.id, again.approval!.id]);
});

test("Not needed vs Send: a draft already sending is never cancelled; a Send before its claim loses to Not needed", async () => {
  // (1) Send claimed first and is executing: Not needed is refused, the send completes and the card is sent.
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let entered!: () => void;
  const executing = new Promise<void>((done) => { entered = done; });
  setOmniExecutorForTests(async () => { executed += 1; entered(); await gate; return { status: "sent", detail: { executor: "test" } }; });
  const sending = decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001");
  await executing;
  const busy = await dismiss(card.id);
  assert.deepEqual([busy.status, await errOf(busy)], [409, "send_in_flight"]);
  assert.equal(getApproval(owner, r.approval!.id)!.status, "approved", "not cancelled");
  release();
  assert.equal((await sending).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "sent");

  // (2) Not needed lands while Send is still before its claim (reading the email's recipients): the draft is
  // cancelled, the Send then answers already_decided, and nothing is sent.
  setOmniExecutorForTests(async () => { executed += 1; return outcome; });
  const other = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const r2 = await choose(other.id, "a", "choose-key-0002");
  let readRelease!: () => void;
  const readGate = new Promise<void>((done) => { readRelease = done; });
  let reading!: () => void;
  const inRead = new Promise<void>((done) => { reading = done; });
  setParticipantsReaderForTests(async () => { reading(); await readGate; return ["sam@example.com"]; });
  const before = executed;
  const late = decide(r2.approval!.id, r2.approval!.digest, "send", "send-key-00002");
  await inRead;
  assert.equal((await dismiss(other.id)).status, 200);
  readRelease();
  const lateRes = await late;
  assert.deepEqual([lateRes.status, ((await lateRes.json()) as { error: string }).error], [409, "already_decided"]);
  assert.equal(executed, before, "nothing sent");
  assert.equal(getApproval(owner, r2.approval!.id)!.status, "cancelled");
  assert.equal(getCard(owner, other.id)!.state, "dismissed");
});

test("a send that still goes out on a closed card is recorded on the card", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  // A closed card whose draft is (somehow) still pending and is then sent: state stays, history says sent.
  transitionCard(owner, card.id, ["draft-ready"], "done", { action: "test-closed" });
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001")).status, 200);
  const c = getCard(owner, card.id)!;
  assert.deepEqual([c.state, c.outcomes.at(-1)!.action], ["done", "approval-sent"]);
});

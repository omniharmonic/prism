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
import { resetOmniStoreForTests, auditRows } from "../src/omni/store";
import { subscribeNotices } from "../src/omni/bus";
import { resetNudgesForTests } from "../src/omni/nudges";
import { resetCardsForTests, getCard, transitionCard } from "../src/omni/cards";
import { proposeApproval } from "../src/omni/propose";
import { setOmniPusherForTests } from "../src/omni/bus";
import { getApproval, type ExecOutcome } from "../src/omni/approvals";
import { turnSettled, notifyTurnEnded, startTurn } from "../src/omni/turns";
import { cardPublish } from "./omni-card-samples";

const owner = config.ownerEmail;
const revision = "2026-10-15T10:00:00Z";
const J = { "content-type": "application/json" };
const hook = { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` };
const ownerH = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
let executed = 0;
let outcome: ExecOutcome = { status: "sent", detail: { executor: "test" } };
let pushes: string[] = [];
beforeEach(() => {
  resetDb(); resetOmniStoreForTests(); resetNudgesForTests(); resetCardsForTests(); executed = 0; pushes = [];
  outcome = { status: "sent", detail: { executor: "test" } };
  setHermesFetchForTests(createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: () => ({ acts: [{ say: "On it." }] }) }).fetch);
  setOmniExecutorForTests(async () => { executed += 1; return outcome; });
  setOmniPusherForTests(async (_o, kind, id) => { pushes.push(`${kind}:${id}`); });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: revision }) });
});
after(() => { setHermesFetchForTests(null); setOmniExecutorForTests(null); setOmniPusherForTests(null); setOmniRecordSourcesForTests({ resolver: null }); });

type Answer = { card: { state: string }; approval: { id: string; digest: string } | null; turnId: string | null };
const publish = async (over: Record<string, unknown> = {}) =>
  ((await (await omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish(over)) })).json()) as { card: { id: string; threadId: string } }).card;
const choose = async (id: string, optionId: string, key: string) =>
  (await (await omniApi.request(`/cards/${id}/choose`, { method: "POST", headers: { ...ownerH(), "idempotency-key": key }, body: JSON.stringify({ optionId }) })).json()) as Answer;
const decide = (id: string, digest: string, decision: string, key: string, extra: Record<string, unknown> = {}) =>
  omniApi.request(`/approvals/${id}/decision`, { method: "POST", headers: { ...ownerH(), "idempotency-key": key }, body: JSON.stringify({ decision, digest, ...extra }) });
const propose = async (body: Record<string, unknown>) =>
  (await (await omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify(body) })).json()) as { id: string; digest: string };

test("Send on a card's draft marks the card sent and takes it out of Needs you", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00001")).status, 200);
  assert.equal(executed, 1);
  assert.equal(getCard(owner, card.id)!.state, "sent");
  const list = await (await omniApi.request("/cards", { headers: ownerH() })).json() as { cards: unknown[] };
  assert.equal(list.cards.length, 0);
});

test("Cancel puts the card back in Decide; a failed send keeps it in Approve", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  assert.equal((await decide(r.approval!.id, r.approval!.digest, "cancel", "cancel-key-0001")).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
  assert.equal(getCard(owner, card.id)!.chosenOptionId, null);
  const other = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const r2 = await choose(other.id, "a", "choose-key-0002");
  outcome = { status: "failed", detail: { executor: "test", error: "mailbox_full" } };
  assert.equal((await decide(r2.approval!.id, r2.approval!.digest, "send", "send-key-00002")).status, 422);
  assert.equal(getCard(owner, other.id)!.state, "draft-ready");
  assert.ok(getCard(owner, other.id)!.outcomes.some((o) => o.action === "approval-failed"));
});

test("a draft the card's turn proposes makes it draft-ready; Edit follows the new approval; commands never touch cards", async () => {
  const card = await publish();
  const started = await choose(card.id, "b", "plan-key-0001");
  await turnSettled(started.turnId!);
  // The plan turn ended without a draft (the turn-ended hook put the card back in Decide); put it back to working as a running turn would.
  transitionCard(owner, card.id, ["proposed"], "working", { action: "test-working" });
  await propose({ kind: "command", payload: { tool: "terminal", command: "curl https://example.org", reason: "check the link", rule: "network" }, threadId: card.threadId });
  assert.equal(getCard(owner, card.id)!.state, "working");
  const p = await propose({ kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nMonday works better for me.\n\nBenjamin" }, threadId: card.threadId, summary: "Ask Sam for Monday" });
  assert.equal(getCard(owner, card.id)!.state, "draft-ready");
  assert.deepEqual(getCard(owner, card.id)!.approvalIds, [p.id]);
  assert.ok(pushes.includes(`OMNI_CARD:${card.id}`));
  assert.equal(pushes.includes(`OMNI_APPROVAL:${p.id}`), false, "one notification, the card's");
  const edit = await omniApi.request(`/approvals/${p.id}`, { method: "PUT", headers: ownerH(), body: JSON.stringify({ digest: p.digest, payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nMonday works better. Thanks!\n\nBenjamin" } }) });
  assert.equal(edit.status, 201);
  const edited = (await edit.json() as { approval: { id: string; digest: string } }).approval;
  assert.deepEqual(getCard(owner, card.id)!.approvalIds, [p.id, edited.id]);
  assert.equal((await decide(edited.id, edited.digest, "send", "send-key-00003")).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "sent");
  assert.equal(getApproval(owner, p.id)!.status, "revised");
});

const sentPending = (cardId: string, over: Record<string, unknown> = {}) => {
  const card = getCard(owner, cardId)!;
  return proposeApproval({ owner, threadId: card.threadId, kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nOld draft.\n\nBenjamin", ...over }, summary: "old", ttlMs: 3600_000, actor: owner, via: "test", push: false });
};

test("R7b: sending an older pending draft while the card is working marks it sent; cancelling leaves it working", async () => {
  const card = await publish();
  const old = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "working", { action: "instruct" }, { approvalId: old.id });
  assert.equal((await decide(old.id, old.digest, "send", "send-key-00004")).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "sent");
  const c2 = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const old2 = sentPending(c2.id);
  transitionCard(owner, c2.id, ["proposed"], "working", { action: "instruct" }, { approvalId: old2.id });
  assert.equal((await decide(old2.id, old2.digest, "cancel", "cancel-key-0002")).status, 200);
  assert.equal(getCard(owner, c2.id)!.state, "working");
});

test("R7b: a decision on a draft that is not the card's latest never moves it, but a send is recorded", async () => {
  const card = await publish();
  const old = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "working", { action: "instruct" }, { approvalId: old.id });
  const newer = sentPending(card.id, { body: "Hi Sam,\n\nNewer.\n\nBenjamin" });
  transitionCard(owner, card.id, ["working"], "draft-ready", { action: "draft" }, { approvalId: newer.id });
  assert.equal((await decide(old.id, old.digest, "send", "send-key-00005")).status, 200);
  const after = getCard(owner, card.id)!;
  assert.equal(after.state, "draft-ready");
  assert.ok(after.outcomes.some((o) => o.action === "approval-sent" && o.approvalId === old.id));
  assert.equal((await decide(newer.id, newer.digest, "cancel", "cancel-key-0003")).status, 200);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
});

test("reopening a card supersedes its still-pending drafts", async () => {
  const card = await publish();
  const old = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "waiting", { action: "waiting" }, { approvalId: old.id });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: "2026-10-15T11:00:00Z" }) });
  const r2 = await omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish({ sourceRevision: "2026-10-15T11:00:00Z", evidence: [{ sourceId: "mail1", revision: "2026-10-15T11:00:00Z" }] })) });
  assert.ok(r2.status < 300);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
  assert.equal(getApproval(owner, old.id)!.status, "cancelled");
  assert.equal((await decide(old.id, old.digest, "send", "send-key-00006")).status, 409);
  assert.equal(executed, 0);
});

test("turn-ended: a plan turn that proposes nothing puts the card back in Decide; a drafted card is left alone", async () => {
  const card = await publish();
  const started = await choose(card.id, "b", "plan-key-0002");
  assert.equal(getCard(owner, card.id)!.state, "working");
  await turnSettled(started.turnId!);
  const back = getCard(owner, card.id)!;
  assert.equal(back.state, "proposed");
  assert.equal(back.outcomes.at(-1)!.action, "turn-ended");
  assert.equal(back.outcomes.at(-1)!.detail, "done");
  const other = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  transitionCard(owner, other.id, ["proposed"], "working", { action: "choose" });
  await propose({ kind: "email-reply", payload: { noteId: "mail2", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nHello.\n\nBenjamin" }, threadId: other.threadId });
  assert.equal(getCard(owner, other.id)!.state, "draft-ready");
  notifyTurnEnded(other.threadId, "error");
  assert.equal(getCard(owner, other.id)!.state, "draft-ready");
});

const draftBody = (body: string) => ({ noteId: "mail1", expectTo: ["sam@example.com"], body });

test("end to end: the card's own turn proposes through the bridge and the card ends draft-ready with one card push", async () => {
  const stub = createHermesStub({
    key: process.env.OMNI_HERMES_KEY!,
    bridge: {
      propose: async (body) => { const r = await omniApi.request("/hooks/propose", { method: "POST", headers: hook, body: JSON.stringify(body) }); return { ok: r.ok, status: r.status, id: ((await r.json()) as { id?: string }).id }; },
      turn: async () => ({ ok: true, status: 200 }),
    },
    script: (ctx) => ({ acts: [
      { tool: "omni_propose", args: {}, result: async () => JSON.stringify(await ctx.stub.bridge!.propose({ kind: "email-reply", payload: draftBody("Hi Sam,\n\nMonday works better.\n\nBenjamin"), threadId: ctx.sessionId, summary: "Ask for Monday" })) },
      { say: "Drafted." },
    ] }),
  });
  setHermesFetchForTests(stub.fetch);
  const card = await publish();
  pushes = [];
  const started = await choose(card.id, "b", "plan-key-0003");
  await turnSettled(started.turnId!);
  const done = getCard(owner, card.id)!;
  assert.equal(done.state, "draft-ready");
  assert.equal(done.approvalIds.length, 1);
  assert.deepEqual(pushes, [`OMNI_CARD:${card.id}`].concat(pushes.filter((p) => p.startsWith("OMNI_THREAD"))));
  assert.equal(pushes.filter((p) => p.startsWith("OMNI_CARD")).length, 1);
  assert.equal(pushes.some((p) => p.startsWith("OMNI_APPROVAL")), false);
});

test("a new draft proposed on a draft-ready card supersedes the pending one", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0004");
  pushes = [];
  const p = await propose({ kind: "email-reply", payload: draftBody("Hi Sam,\n\nA better draft.\n\nBenjamin"), threadId: card.threadId });
  assert.equal(getApproval(owner, r.approval!.id)!.status, "cancelled");
  assert.equal(getApproval(owner, p.id)!.status, "pending");
  const c = getCard(owner, card.id)!;
  assert.equal(c.state, "draft-ready");
  assert.deepEqual(c.approvalIds, [r.approval!.id, p.id]);
  assert.deepEqual(pushes, [`OMNI_CARD:${card.id}`]);
  const row = auditRows().find((a) => a.action === "approval.cancel" && a.approval_id === r.approval!.id)!;
  assert.equal(row.actor, "omni");
  assert.equal(row.error, `superseded by ${p.id}`);
});

test("reopen supersede is audited as the system, not the owner", async () => {
  const card = await publish();
  const old = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "waiting", { action: "waiting" }, { approvalId: old.id });
  setOmniRecordSourcesForTests({ resolver: async ({ id }) => ({ id: id!, path: `mail/${id}`, tags: ["email"], updatedAt: "2026-10-15T12:00:00Z" }) });
  await omniApi.request("/hooks/cards", { method: "POST", headers: hook, body: JSON.stringify(cardPublish({ sourceRevision: "2026-10-15T12:00:00Z", evidence: [{ sourceId: "mail1", revision: "2026-10-15T12:00:00Z" }] })) });
  const row = auditRows().find((a) => a.action === "approval.cancel" && a.approval_id === old.id)!;
  assert.equal(row.actor, "omni");
  assert.equal(row.via, "superseded");
});

test("a card bookkeeping failure never hides a real send", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0005");
  const notices: string[] = [];
  const off = subscribeNotices((n) => { notices.push(`${n.type}:${n.op}`); if (n.type === "item-card") throw new Error("card subscriber down"); });
  try {
    assert.equal((await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00007")).status, 200);
  } finally { off(); }
  assert.equal(executed, 1);
  assert.ok(auditRows().some((a) => a.action === "approval.send" && a.approval_id === r.approval!.id && a.status === "sent"));
  assert.ok(notices.includes("approval:sent"));
});

test("revise whose turn was a replay of an ended turn leaves the card in Decide, not stuck working", async () => {
  const card = await publish();
  const first = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "draft-ready", { action: "draft" }, { approvalId: first.id });
  const a = await decide(first.id, first.digest, "revise", "revise-key-0001", { feedback: "Shorter please." });
  const turn1 = ((await a.json()) as { turnId: string }).turnId;
  await turnSettled(turn1);
  assert.equal(getCard(owner, card.id)!.state, "proposed");
  const second = await propose({ kind: "email-reply", payload: draftBody("Hi Sam,\n\nAgain.\n\nBenjamin"), threadId: card.threadId });
  assert.equal(getCard(owner, card.id)!.state, "draft-ready");
  const b = await decide(second.id, second.digest, "revise", "revise-key-0001", { feedback: "Shorter please." });
  assert.equal(((await b.json()) as { turnId: string }).turnId, turn1, "the same key replays the ended turn");
  assert.equal(getCard(owner, card.id)!.state, "proposed");
});

test("editing an older draft does not move the card's latest", async () => {
  const card = await publish();
  const old = sentPending(card.id);
  transitionCard(owner, card.id, ["proposed"], "working", { action: "instruct" }, { approvalId: old.id });
  const newer = sentPending(card.id, { body: "Hi Sam,\n\nNewer.\n\nBenjamin" });
  transitionCard(owner, card.id, ["working"], "draft-ready", { action: "draft" }, { approvalId: newer.id });
  const edit = await omniApi.request(`/approvals/${old.id}`, { method: "PUT", headers: ownerH(), body: JSON.stringify({ digest: old.digest, payload: draftBody("Hi Sam,\n\nEdited old.\n\nBenjamin") }) });
  assert.equal(edit.status, 201);
  assert.deepEqual(getCard(owner, card.id)!.approvalIds, [old.id, newer.id]);
});

test("a draft-ready card resolved elsewhere cancels its draft so it can never be sent", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  const res = await omniApi.request("/hooks/proactive/resolve", { method: "POST", headers: hook, body: JSON.stringify({ sources: [{ sourceId: "mail1", sourceRevision: revision }] }) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { resolved: string[] }).resolved, ["mail1"]);
  assert.equal(getCard(owner, card.id)!.state, "done");
  assert.equal(getApproval(owner, r.approval!.id)!.status, "cancelled");
  assert.equal(getApproval(owner, r.approval!.id)!.decidedVia, "source-resolved");
  const late = await decide(r.approval!.id, r.approval!.digest, "send", "late-send-0001");
  assert.equal(late.status, 409);
  assert.equal(executed, 0);
});

test("the sweep's resolution closes a proposed card; a sent card stays sent", async () => {
  const open = await publish();
  const sweep = (ids: string[]) => omniApi.request("/hooks/nudges/resolve", { method: "POST", headers: hook, body: JSON.stringify({ complete: true, sourceIds: ids }) });
  assert.equal((await sweep(["mail1"])).status, 200);
  assert.equal(getCard(owner, open.id)!.state, "done");
  const sent = await publish({ sourceKey: "mail2", itemRefs: ["mail2"] });
  const r = await choose(sent.id, "a", "choose-key-0002");
  await decide(r.approval!.id, r.approval!.digest, "send", "send-key-00009");
  await sweep(["mail2"]);
  assert.equal(getCard(owner, sent.id)!.state, "sent");
});

const resolveHook = (ids: string[]) => omniApi.request("/hooks/nudges/resolve", { method: "POST", headers: hook, body: JSON.stringify({ complete: true, sourceIds: ids }) });
const outcomesOf = (id: string) => getCard(owner, id)!.outcomes.map((o) => `${o.action}${o.detail ? `:${o.detail}` : ""}`);

test("waiting and snoozed cards close to done; dismissed and done stay put", async () => {
  const w = await publish({ sourceKey: "w1", itemRefs: ["w1"] });
  transitionCard(owner, w.id, ["proposed"], "waiting", { action: "waiting" });
  const sn = await publish({ sourceKey: "s1", itemRefs: ["s1"] });
  transitionCard(owner, sn.id, ["proposed"], "snoozed", { action: "snooze" }, { snoozedUntil: 1 });
  const dm = await publish({ sourceKey: "d1", itemRefs: ["d1"] });
  transitionCard(owner, dm.id, ["proposed"], "dismissed", { action: "dismiss" });
  const dn = await publish({ sourceKey: "n1", itemRefs: ["n1"] });
  transitionCard(owner, dn.id, ["proposed"], "done", { action: "done" });
  await resolveHook(["w1", "s1", "d1", "n1"]);
  assert.equal(getCard(owner, w.id)!.state, "done");
  assert.equal(getCard(owner, sn.id)!.state, "done");
  assert.equal(getCard(owner, dm.id)!.state, "dismissed");
  assert.equal(getCard(owner, dn.id)!.state, "done");
  assert.equal(outcomesOf(dm.id).includes("resolved-elsewhere"), false);
});

test("the proactive resolve path closes the card when a decision row exists too", async () => {
  const card = await publish();
  const now = Date.now();
  db.prepare("INSERT INTO omni_proactive_decisions (owner_email, decision_id, digest, source_id, source_revision, thread_id, nudge_id, body, evidence, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(owner, "dec1", "dg", "mail1", revision, card.threadId, "nudge-x", "b", "[]", now + 3_600_000, now);
  const res = await omniApi.request("/hooks/proactive/resolve", { method: "POST", headers: hook, body: JSON.stringify({ sources: [{ sourceId: "mail1", sourceRevision: revision }] }) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { resolved: string[] }).resolved, ["mail1"]);
  assert.equal(getCard(owner, card.id)!.state, "done");
});

test("resolved elsewhere while the card's turn runs: the draft is cancelled now, the card closes when the turn ends, a draft proposed meanwhile is cancelled too", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  setHermesFetchForTests(createHermesStub({ key: process.env.OMNI_HERMES_KEY!, script: async () => { await gate; return { acts: [{ say: "ok" }] }; } }).fetch);
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  const running = startTurn(card.threadId, "revise it", "direct-turn-0002");
  assert.ok("turn" in running);
  transitionCard(owner, card.id, ["draft-ready"], "working", { action: "test-working" });
  await resolveHook(["mail1"]);
  assert.equal(getCard(owner, card.id)!.state, "working");
  assert.equal(getCard(owner, card.id)!.outcomes.at(-1)!.detail, "pending: turn running");
  assert.equal(getApproval(owner, r.approval!.id)!.status, "cancelled");
  pushes = [];
  const p = await propose({ kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nToo late.\n\nBenjamin" }, threadId: card.threadId });
  assert.equal(getCard(owner, card.id)!.state, "working");
  assert.deepEqual(getCard(owner, card.id)!.approvalIds, [r.approval!.id]);
  assert.equal(pushes.includes(`OMNI_CARD:${card.id}`), false);
  release();
  await turnSettled((running as { turn: { id: string } }).turn.id);
  assert.equal(getCard(owner, card.id)!.state, "done");
  assert.equal(getApproval(owner, p.id)!.status, "cancelled");
  assert.equal((await decide(p.id, p.digest, "send", "late-send-0002")).status, 409);
  assert.equal(executed, 0);
});

test("resolved elsewhere with a send in flight: the card is not closed, the send settles it", async () => {
  const card = await publish();
  const r = await choose(card.id, "a", "choose-key-0001");
  db.prepare("UPDATE omni_approvals SET status='approved', decided_at=? WHERE id=?").run(Date.now(), r.approval!.id);
  await resolveHook(["mail1"]);
  assert.equal(getCard(owner, card.id)!.state, "draft-ready");
  assert.ok(outcomesOf(card.id).includes("resolved-elsewhere:send in flight"));
  assert.equal(getApproval(owner, r.approval!.id)!.status, "approved");
});

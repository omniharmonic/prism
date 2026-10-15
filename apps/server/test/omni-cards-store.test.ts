import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./helpers";
import { config } from "../src/config";
import { cardInput } from "./omni-card-samples";
import {
  parseCardInput, upsertCard, transitionCard, getCard, cardSection, listOpenCards, cardView, linkApproval,
  cardForApproval, replaceCardContent, CardError, resetCardsForTests, compareCardViews,
} from "../src/omni/cards";

const owner = config.ownerEmail;
const reason = (f: () => unknown): { code: string; detail?: string } => {
  try { f(); } catch (e) { if (e instanceof CardError) return { code: e.code, detail: e.detail }; throw e; }
  throw new Error("expected a CardError");
};

beforeEach(() => { resetDb(); resetCardsForTests(); });

test("a valid card parses; drafts keep only the fields the kind allows", () => {
  const c = parseCardInput(cardInput({ options: [
    { id: "a", label: "Say yes", plan: "Reply yes", produces: ["email-reply"], draft: { kind: "email-reply", payload: { noteId: "mail1", expectTo: ["sam@example.com"], body: "Yes.", extra: "dropped" } } },
    { id: "b", label: "Not now", plan: "Snooze", produces: ["nothing"] },
  ] }));
  assert.equal(c.options.length, 2);
  assert.deepEqual(Object.keys(c.options[0]!.draft!.payload).sort(), ["body", "expectTo", "noteId"]);
  assert.equal(c.options[1]!.draft, null);
});

test("options: 2 to 4, unique ids, recommended names one, a sending recommendation needs its draft", () => {
  const one = cardInput(); (one.options as unknown[]).splice(1);
  assert.equal(reason(() => parseCardInput(one)).code, "invalid_options");
  const five = cardInput({ options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}`, plan: "p", produces: ["nothing"] })), recommended: null });
  assert.equal(reason(() => parseCardInput(five)).code, "invalid_options");
  const dup = cardInput({ options: [{ id: "a", label: "x", plan: "p", produces: [] }, { id: "a", label: "y", plan: "p", produces: [] }], recommended: null });
  assert.equal(reason(() => parseCardInput(dup)).code, "invalid_options");
  assert.equal(reason(() => parseCardInput(cardInput({ recommended: "z" }))).code, "invalid_options");
  assert.equal(reason(() => parseCardInput(cardInput({ recommended: "b" }))).detail, "recommended: an option that sends needs its draft");
});

test("an invalid option draft rejects the whole card with its option index", () => {
  const bad = cardInput({ options: [
    { id: "a", label: "Say yes", plan: "Reply", produces: ["email-reply"], draft: { kind: "email-reply", payload: { noteId: "mail1", body: "Yes." } } },
    { id: "b", label: "Later", plan: "Nothing", produces: ["nothing"] },
  ] });
  const r = reason(() => parseCardInput(bad));
  assert.equal(r.code, "invalid_draft");
  assert.match(r.detail!, /^options\[0\]\.draft: expectTo/);
  for (const kind of ["command", "wallet-proposal", "tweet"]) {
    const forbidden = cardInput({ options: [{ id: "a", label: "x", plan: "p", produces: [], draft: { kind, payload: { text: "hi" } } }, { id: "b", label: "y", plan: "p", produces: [] }], recommended: null });
    assert.equal(reason(() => parseCardInput(forbidden)).code, "invalid_draft");
  }
  const unlisted = cardInput({ options: [{ id: "a", label: "x", plan: "p", produces: ["nothing"], draft: { kind: "message", payload: { roomId: "!r:x", body: "hi" } } }, { id: "b", label: "y", plan: "p", produces: [] }], recommended: null });
  assert.match(reason(() => parseCardInput(unlisted)).detail!, /produces must list message/);
});

test("headlines are plain words: slugs, paths and markdown are refused; long text is bounded", () => {
  for (const headline of ["call-dana", "vault/messages/email/x", "notes.md", "**Sam** asks", "[Sam](x) asks"]) {
    assert.equal(reason(() => parseCardInput(cardInput({ headline }))).code, "headline_not_readable", headline);
  }
  assert.equal(reason(() => parseCardInput(cardInput({ headline: "x ".repeat(81) }))).code, "invalid_card");
  assert.equal(parseCardInput(cardInput({ headline: "a".repeat(79) + " " + "b".repeat(80) })).headline.length, 160);
  assert.equal(reason(() => parseCardInput(cardInput({ context: Array.from({ length: 5 }, () => ({ text: "x", source: null })) }))).code, "invalid_card");
  assert.equal(reason(() => parseCardInput(cardInput({ context: [{ text: "y".repeat(201), source: null }] }))).code, "invalid_card");
  assert.equal(reason(() => parseCardInput(cardInput({ itemRefs: ["other"] }))).code, "invalid_card");
  assert.equal(reason(() => parseCardInput(cardInput({ kind: "tweet" }))).code, "invalid_card");
  // Newlines and control characters in one-line fields become single spaces.
  assert.equal(parseCardInput(cardInput({ ask: "line one\n\nline\u0007two" })).ask, "line one line two");
});

test("upsertCard ignores a re-publish once the owner acted", () => {
  const first = upsertCard(owner, parseCardInput(cardInput()), "omni-proactive-t1", 1_000);
  assert.equal(first.created, true);
  assert.equal(first.card.state, "proposed");
  assert.equal(upsertCard(owner, parseCardInput(cardInput()), "omni-proactive-t1", 2_000).changed, false);
  const edited = upsertCard(owner, parseCardInput(cardInput({ headline: "Sam needs the budget review by Friday" })), "omni-proactive-t1", 3_000);
  assert.equal(edited.changed, true);
  assert.equal(edited.card.headline, "Sam needs the budget review by Friday");
  assert.ok(transitionCard(owner, first.card.id, ["proposed"], "working", { action: "choose", optionId: "b" }, { chosenOptionId: "b" }, 4_000));
  const again = upsertCard(owner, parseCardInput(cardInput({ headline: "Something the agent thought later" })), "omni-proactive-t1", 5_000);
  assert.equal(again.ignored, "owner_acted");
  assert.equal(again.changed, false);
  assert.equal(getCard(owner, first.card.id)!.headline, "Sam needs the budget review by Friday");
  assert.equal(getCard(owner, first.card.id)!.state, "working");
});

test("transitions are conditional and append to the outcome log; approvals link once", () => {
  const { card } = upsertCard(owner, parseCardInput(cardInput()), "t1", 1_000);
  assert.equal(transitionCard(owner, card.id, ["working"], "sent", { action: "x" }), null);
  const ready = transitionCard(owner, card.id, ["proposed"], "draft-ready", { action: "choose", optionId: "a" }, { chosenOptionId: "a", approvalId: "apr_1" }, 2_000)!;
  assert.deepEqual(ready.approvalIds, ["apr_1"]);
  assert.equal(linkApproval(owner, card.id, "apr_1", 3_000)!.approvalIds.length, 1);
  assert.deepEqual(linkApproval(owner, card.id, "apr_2", 3_000)!.approvalIds, ["apr_1", "apr_2"]);
  assert.equal(cardForApproval(owner, "apr_2")!.id, card.id);
  assert.deepEqual(getCard(owner, card.id)!.outcomes.map((o) => o.action), ["proposed", "choose"]);
  const replaced = replaceCardContent(owner, card.id, parseCardInput(cardInput({ headline: "Sam sent a new budget" })), ["proposed", "working"], 4_000);
  assert.equal(replaced, null, "a draft-ready card is not replaced");
});

test("sections and order: urgency first, then the oldest; snoozed returns to Decide when due", () => {
  const a = upsertCard(owner, parseCardInput(cardInput({ sourceKey: "m1", itemRefs: ["m1"], urgency: "whenever" })), "t1", 1_000).card;
  const b = upsertCard(owner, parseCardInput(cardInput({ sourceKey: "m2", itemRefs: ["m2"], urgency: "today" })), "t2", 3_000).card;
  const c = upsertCard(owner, parseCardInput(cardInput({ sourceKey: "m3", itemRefs: ["m3"], urgency: "today" })), "t3", 2_000).card;
  const d = upsertCard(owner, parseCardInput(cardInput({ sourceKey: "m4", itemRefs: ["m4"] })), "t4", 4_000).card;
  transitionCard(owner, d.id, ["proposed"], "snoozed", { action: "snooze" }, { snoozedUntil: 10_000 }, 5_000);
  assert.equal(cardSection(getCard(owner, d.id)!, 9_999), null);
  assert.equal(cardSection(getCard(owner, d.id)!, 10_000), "decide");
  const views = listOpenCards(owner, 6_000).map((x) => cardView(x, 6_000)).sort(compareCardViews);
  assert.deepEqual(views.map((v) => v.id), [c.id, b.id, a.id]);
  transitionCard(owner, a.id, ["proposed"], "working", { action: "instruct" }, {}, 7_000);
  assert.equal(cardSection(getCard(owner, a.id)!, 7_000), "motion");
});

test("cardView: ISO times, section, no owner, never transitional", () => {
  const { card } = upsertCard(owner, parseCardInput(cardInput()), "t1", Date.UTC(2026, 9, 15, 16, 0));
  const v = cardView(card, Date.UTC(2026, 9, 15, 16, 1));
  assert.equal(v.createdAt, "2026-10-15T16:00:00.000Z");
  assert.equal(v.section, "decide");
  assert.equal(v.transitional, false);
  assert.equal(v.nudgeId, null);
  assert.equal("owner" in v, false);
  assert.equal("digest" in v, false);
  assert.deepEqual((v.outcomes as Array<{ at: string }>)[0]!.at, "2026-10-15T16:00:00.000Z");
});

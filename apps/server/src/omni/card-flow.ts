/**
 * What happens around an item card (spec 2026-10-15 §5–6): the agent publishing it, the owner's
 * choices, the approval gate and the card's thread. Every outward step goes through
 * proposeApproval → the owner's `decide`; nothing in this module sends anything.
 */
import { db } from "../db";
import { resolveNote } from "./records";
import { bindNudgeThread, listNudges, nudgeAction, resolveNudgeSource, type Candidate, type Nudge } from "./nudges";
import { clip, plainText } from "./titles";
import { activeTurn, ensureThread, getThread, omniAudit, sha256 } from "./store";
import { omniConfig } from "./config";
import { approvalView, closeApproval, getApproval, listApprovals } from "./approvals";
import { proposeApproval } from "./propose";
import { recordProactiveOwnerTurn } from "./proactive";
import { emit, onTurnEnded, startTurn, withNotes } from "./turns";
import { publishNotice, pushOmni } from "./bus";
import { ensureSourceSession } from "./source-session";
import { ACTED_STATES, REOPENABLE_STATES, CardError, cardBySource, cardForApproval, cardsByThread, cardSourceKeys, cardView, compareCardViews, finishCardAction, getCard, linkApproval, listOpenCards, parseCardInput, priorCardAction, releaseCardAction, reserveCardAction, transitionCard, upsertCard, type CardOption, type Card, type CardFact, type CardInput, type CardKind, type CardSection, type CardState } from "./cards";

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export interface CardPublish extends CardInput { evidence: Array<{ sourceId: string; revision: string }> }

export function parseCardPublish(b: Record<string, unknown>): CardPublish {
  const input = parseCardInput(b);
  if (!input.sourceRevision) throw new CardError("invalid_card", 400, "sourceRevision: required");
  const raw = b.evidence;
  const ok = (e: unknown): e is { sourceId: string; revision: string } => {
    if (!e || typeof e !== "object") return false;
    const o = e as Record<string, unknown>;
    return typeof o.sourceId === "string" && NOTE_ID.test(o.sourceId) && typeof o.revision === "string" && o.revision.length > 0 && o.revision.length <= 128;
  };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20 || !raw.every(ok)) throw new CardError("invalid_evidence", 400, "evidence: 1–20 {sourceId, revision}");
  const evidence = raw.map((e) => ({ sourceId: e.sourceId, revision: e.revision }));
  if (!evidence.some((e) => e.sourceId === input.sourceKey && e.revision === input.sourceRevision)) throw new CardError("invalid_evidence", 400, "evidence: must include the source at sourceRevision");
  return { ...input, evidence };
}

async function freshEvidence(p: CardPublish): Promise<void> {
  for (const e of p.evidence) {
    const n = await resolveNote({ id: e.sourceId, fresh: true });
    if (!n?.path || n.trashed || n.tags.includes("prism-trashed") || !n.updatedAt) throw new CardError("source_unavailable", 422);
    if (n.updatedAt !== e.revision) throw new CardError("stale_evidence", 409);
  }
}

/** Keep a context fact only when its source is none, the calendar, one of the card's own item
 *  refs, or a vault note that resolves (by id, then path). Fails closed: a lookup that throws or
 *  finds nothing drops the fact. */
export async function filterFacts(facts: CardFact[], itemRefs: string[]): Promise<{ kept: CardFact[]; dropped: number }> {
  const refs = new Set(itemRefs);
  const kept: CardFact[] = [];
  for (const f of facts) {
    const src = f.source;
    let keep = src === null || src === "calendar" || refs.has(src);
    if (!keep && src !== null) {
      try {
        const n = (await resolveNote({ id: src })) ?? (await resolveNote({ path: src }));
        keep = !!n && !n.trashed;
      } catch {
        keep = false;
      }
    }
    if (keep) kept.push(f);
  }
  return { kept, dropped: facts.length - kept.length };
}

/** Archived, resolved or dismissed by the owner: the agent may not bring it back as a card.
 *  - A resolved nudge (answered elsewhere) always suppresses; only the nudge sweep un-resolves it.
 *  - A dismissal covers only the revision the owner dismissed: a finished card whose item has since
 *    changed may be republished at the new revision (upsertCard reopens it and clears the dismissal).
 *  - A card still open (proposed/snoozed) stays updatable. */
function suppressed(owner: string, sourceKey: string, sourceRevision: string | null): boolean {
  const r = db.prepare("SELECT n.dismissed AS dismissed, n.resolved AS resolved, t.archived AS archived FROM omni_nudges n LEFT JOIN omni_threads t ON t.id=n.thread_id WHERE n.owner_email=? AND n.source_id=?")
    .get(owner, sourceKey) as { dismissed: number; resolved: number; archived: number | null } | undefined;
  if (!r || !(r.dismissed || r.resolved || r.archived)) return false;
  if (r.archived || r.resolved) return true;
  const card = cardBySource(owner, sourceKey);
  if (!card) return true;
  if (card.state === "proposed" || card.state === "snoozed") return false;
  return !(REOPENABLE_STATES.has(card.state) && sourceRevision !== null && card.sourceRevision !== sourceRevision);
}

/** Tell every surface: the card's thread (as a timeline item), the change channel, and — for a
 *  card that now needs the owner — the lock screen. */
export function announceCard(c: Card, op: string, o: { push: boolean }): void {
  if (c.threadId && getThread(c.threadId)) emit(c.threadId, null, { t: "item_card", card: cardView(c) });
  publishNotice({ type: "item-card", id: c.id, op, threadId: c.threadId ?? undefined });
  if (o.push && (c.state === "proposed" || c.state === "draft-ready")) pushOmni("OMNI_CARD", c.id);
}

/** The agent's card for one item. Thread created or reused the way publishProactive does. */
export async function publishCard(owner: string, p: CardPublish, now: number = Date.now()): Promise<{ card: Card; created: boolean; changed: boolean; ignored?: string; droppedFacts: number }> {
  const existing = cardBySource(owner, p.sourceKey);
  // A finished card the item has since changed is reopened by upsertCard; anything else the owner touched is theirs.
  const reopens = !!existing && REOPENABLE_STATES.has(existing.state) && existing.sourceRevision !== p.sourceRevision;
  if (existing && ACTED_STATES.has(existing.state) && !reopens) return { card: existing, created: false, changed: false, ignored: "owner_acted", droppedFacts: 0 };
  if (suppressed(owner, p.sourceKey, p.sourceRevision)) throw new CardError("source_suppressed", 409);
  await freshEvidence(p);
  const { kept, dropped } = await filterFacts(p.context, p.itemRefs);
  const nudge = db.prepare("SELECT id, thread_id FROM omni_nudges WHERE owner_email=? AND source_id=?").get(owner, p.sourceKey) as { id: string; thread_id: string | null } | undefined;
  const threadId = await ensureSourceSession(owner, p.sourceKey, p.headline, existing?.threadId ?? nudge?.thread_id ?? null);
  // Read again after the remote call: a reply or a dismissal during it invalidates the card.
  await freshEvidence(p);
  const { evidence: _evidence, ...rest } = p;
  const input: CardInput = { ...rest, context: kept };
  const r = db.transaction(() => {
    if (suppressed(owner, p.sourceKey, p.sourceRevision)) throw new CardError("source_suppressed", 409);
    ensureThread({ id: threadId, title: p.headline, taskNoteId: p.sourceKey, source: "nudge", state: "waiting" });
    if (nudge) bindNudgeThread(owner, nudge.id, threadId);
    const u = upsertCard(owner, input, threadId, now);
    if (reopens && u.changed && nudge) db.prepare("UPDATE omni_nudges SET dismissed=0, updated_at=? WHERE owner_email=? AND id=?").run(now, owner, nudge.id);
    return u;
  })();
  if (r.changed) {
    // A reopened card is a new question: a draft written against the old content must not stay sendable.
    if (reopens) cancelPendingDrafts(owner, existing!.approvalIds, { via: "superseded", device: null }, `${p.sourceRevision}`, { prefix: "superseded", actor: "omni", detail: "superseded: the item changed" });
    announceCard(r.card, r.created ? "created" : reopens ? "reopened" : "updated", { push: r.created || reopens });
  }
  return { ...r, droppedFacts: dropped };
}

// ── Needs you: open cards, plus nudges that have no card yet (transition) ──

export function nudgeCardKind(c: Candidate): CardKind {
  switch (c.kind) {
    case "meeting": return "invite";
    case "task": case "commitment": return "task";
    case "reply-owed": case "unprocessed": return /message|chat|matrix/i.test(c.sourcePath) ? "message" : "email";
    default: return "other";
  }
}

/** A nudge with no card yet, shown in the card shape so nothing disappears: no options;
 *  its actions are Open / Later / Not needed through the existing nudge routes. */
export function transitionalCardView(n: Nudge, now: number = Date.now()): Record<string, unknown> {
  const c = n.candidate;
  const summary = plainText(c.summary, 200);
  const context = summary && summary.toLowerCase() !== c.title.trim().toLowerCase() ? [{ text: summary, source: null }] : [];
  return {
    id: n.id, sourceKey: c.sourceId, kind: nudgeCardKind(c), state: "proposed", headline: clip(c.title, 160), context, ask: null,
    urgency: n.deadline !== null && n.deadline <= now + 86_400_000 ? "today" : "this-week", options: [], recommended: null,
    itemRefs: c.operationalSource ? [] : [c.sourceId], threadId: n.threadId, approvalIds: [], chosenOptionId: null, outcomes: [],
    createdAt: new Date(n.createdAt).toISOString(), updatedAt: new Date(n.updatedAt).toISOString(), snoozedUntil: null,
    section: "decide", transitional: true, nudgeId: n.id,
  };
}

export function listCardViews(owner: string, now: number = Date.now()): { cards: Record<string, unknown>[]; counts: Record<CardSection, number> } {
  const carded = cardSourceKeys(owner);
  const cards = [
    ...listOpenCards(owner, now).map((c) => cardView(c, now)),
    ...listNudges(owner, false, now).filter((n) => !carded.has(n.candidate.sourceId)).map((n) => transitionalCardView(n, now)),
  ].sort(compareCardViews);
  const counts: Record<CardSection, number> = { decide: 0, approve: 0, motion: 0 };
  for (const v of cards) counts[v.section as CardSection] += 1;
  return { cards, counts };
}

function recordCardFeedback(owner: string, card: Card, kind: string, now: number): void {
  db.prepare("INSERT INTO omni_feedback(owner_email,nudge_id,source_id,sender_id,kind,ts) VALUES(?,?,?,?,?,?)").run(owner, card.id, card.sourceKey, null, kind, now);
}
function notOpen(owner: string, id: string): CardError {
  const c = getCard(owner, id);
  return c ? new CardError("card_not_open", 409, `state: ${c.state}`) : new CardError("not_found", 404);
}

export function snoozeCard(owner: string, id: string, until: number, now: number = Date.now()): Card {
  const card = transitionCard(owner, id, ["proposed", "snoozed"], "snoozed", { action: "snooze", detail: new Date(until).toISOString() }, { snoozedUntil: until }, now);
  if (!card) throw notOpen(owner, id);
  recordCardFeedback(owner, card, "snooze", now);
  announceCard(card, "snoozed", { push: false });
  return card;
}

/** "Not needed" teaches the sweep (noise, like a nudge); "Done" closes the item. */
export function dismissCard(owner: string, id: string, reason: "not-needed" | "done", now: number = Date.now()): Card {
  const to = reason === "done" ? "done" : "dismissed";
  const card = transitionCard(owner, id, ["proposed", "snoozed", "waiting"], to, { action: reason }, {}, now);
  if (!card) throw notOpen(owner, id);
  const nudge = db.prepare("SELECT id FROM omni_nudges WHERE owner_email=? AND source_id=?").get(owner, card.sourceKey) as { id: string } | undefined;
  if (reason === "not-needed") {
    if (nudge) nudgeAction(owner, nudge.id, "noise", null, now);
    else recordCardFeedback(owner, card, "noise", now);
  } else {
    resolveNudgeSource(owner, card.sourceKey, now);
    recordCardFeedback(owner, card, "done", now);
  }
  announceCard(card, to, { push: false });
  return card;
}

// ── the owner's choices ─────────────────────────────────────────────────────

const KEEP_IT_SAFE = "Read the item first. Anything that would reach another person goes through omni_propose as a draft for his approval; nothing is sent without it. If you need him to choose again, post new options with omni_card.";

/** The option's plan was written by the model earlier: it is quoted as the plan he chose, not as new policy. */
export function optionPrompt(card: Card, option: CardOption): string {
  return withNotes([
    `Benjamin chose how to handle this item: "${card.headline}".`,
    `His choice: ${option.label}.`,
    `The plan behind it (prepared by Omni earlier, chosen by Benjamin): ${option.plan}`,
    KEEP_IT_SAFE,
  ].join("\n\n"), card.itemRefs);
}

export interface CardActionAnswer { status: 201 | 202; body: Record<string, unknown>; replayed: boolean }

/** Start the card's turn; a turn already running there puts the card back as it was. */
export function startCardTurn(owner: string, before: Card, claimed: Card, prompt: string, key: string): { status: 202; body: Record<string, unknown> } {
  const r = startTurn(claimed.threadId!, prompt, `card-${sha256(`${claimed.id}:${key}`).slice(0, 40)}`);
  if ("active" in r) {
    transitionCard(owner, claimed.id, ["working"], before.state, { action: "refused", detail: "turn_running" }, { chosenOptionId: before.chosenOptionId, snoozedUntil: before.snoozedUntil });
    throw new CardError("turn_running", 409, "a turn is already running in this card's thread");
  }
  if ("turn" in r) recordProactiveOwnerTurn(owner, claimed.threadId!, r.turn.id);
  announceCard(claimed, "working", { push: false });
  return { status: 202, body: { card: cardView(claimed), approval: null, threadId: claimed.threadId, turnId: "turn" in r ? r.turn.id : r.replay.id } };
}

/** Replay, reserve, run once, store the answer: one Idempotency-Key = one effect. */
function idempotent(owner: string, cardId: string, key: string, action: string, run: () => { status: 201 | 202; body: Record<string, unknown> }): CardActionAnswer {
  const prior = priorCardAction(owner, cardId, key);
  if (prior) {
    if (prior.action !== action) throw new CardError("idempotency_conflict", 409, "this Idempotency-Key was used for another action");
    if (!prior.response || prior.status === null) throw new CardError("in_progress", 409);
    return { status: prior.status as 201 | 202, body: prior.response, replayed: true };
  }
  if (!reserveCardAction(owner, cardId, key, action)) throw new CardError("in_progress", 409);
  try {
    const answer = run();
    finishCardAction(owner, cardId, key, answer.status, answer.body);
    return { ...answer, replayed: false };
  } catch (e) {
    releaseCardAction(owner, cardId, key);
    throw e;
  }
}

export function chooseCardOption(owner: string, cardId: string, optionId: string, key: string, origin: { via: string }): CardActionAnswer {
  return idempotent(owner, cardId, key, `choose:${optionId}`, () => {
    const card = getCard(owner, cardId);
    if (!card) throw new CardError("not_found", 404);
    const option = card.options.find((o) => o.id === optionId);
    if (!option) throw new CardError("unknown_option", 400, `optionId: one of ${card.options.map((o) => o.id).join(", ")}`);
    if (option.draft) {
      // The draft is exactly what the card showed. It becomes a PENDING approval: Send is a separate tap.
      const claimed = transitionCard(owner, cardId, ["proposed", "snoozed"], "draft-ready", { action: "choose", optionId }, { chosenOptionId: optionId });
      if (!claimed) throw notOpen(owner, cardId);
      let a;
      try {
        a = proposeApproval({ owner, threadId: claimed.threadId, kind: option.draft.kind, payload: option.draft.payload, summary: option.label, ttlMs: omniConfig.approvalTtlMs(), actor: owner, via: origin.via, push: false });
      } catch (e) {
        transitionCard(owner, cardId, ["draft-ready"], card.state, { action: "refused", detail: "propose_failed" }, { chosenOptionId: card.chosenOptionId, snoozedUntil: card.snoozedUntil });
        throw e;
      }
      const linked = linkApproval(owner, cardId, a.id)!;
      announceCard(linked, "draft-ready", { push: false });
      return { status: 201, body: { card: cardView(linked), approval: approvalView(a), threadId: linked.threadId, turnId: null } };
    }
    if (!card.threadId || !getThread(card.threadId)) throw new CardError("card_has_no_thread", 409);
    const claimed = transitionCard(owner, cardId, ["proposed", "snoozed"], "working", { action: "choose", optionId }, { chosenOptionId: optionId });
    if (!claimed) throw notOpen(owner, cardId);
    return startCardTurn(owner, card, claimed, optionPrompt(claimed, option), key);
  });
}

/** His words are his: quoted as his instruction, the item is still read as data. */
export function instructPrompt(card: Card, text: string): string {
  return withNotes([`Benjamin's instruction for this item: "${card.headline}".`, `His own words:\n${text}`, KEEP_IT_SAFE].join("\n\n"), card.itemRefs);
}

/** One card, one live draft: his new instruction retires the drafts still waiting on this card.
 *  Cancelled as the owner (audited like his own cancel) through the same close the decision route uses.
 *  The closes are pure database writes and all run first; the audit/notice/event side effects follow
 *  per approval and can never undo or skip a close (a failure is logged and the loop goes on). */
function cancelPendingDrafts(owner: string, ids: string[], origin: { via: string; device: string | null }, key: string, how: { prefix: string; actor: string; detail?: string } = { prefix: "instruct", actor: owner }): void {
  const closed: Array<NonNullable<ReturnType<typeof getApproval>>> = [];
  for (const id of ids) {
    const a = getApproval(owner, id);
    // Not pending any more (decided, expired or revised since the card was last read): nothing left to cancel.
    if (!a || a.status !== "pending") continue;
    if (closeApproval(id, "cancelled", origin.via, origin.device, `${how.prefix}-${sha256(`${id}:${key}`).slice(0, 40)}`)) closed.push(a);
  }
  for (const a of closed) {
    try {
      omniAudit({ actor: how.actor, via: origin.via, action: "approval.cancel", approvalId: a.id, threadId: a.threadId, digest: a.digest, status: "ok", error: how.detail ?? null });
      publishNotice({ type: "approval", id: a.id, op: "cancelled", threadId: a.threadId ?? undefined });
      if (a.threadId && getThread(a.threadId)) emit(a.threadId, null, { t: "approval", approval: approvalView(getApproval(owner, a.id)!) });
    } catch (e) {
      console.error("omni: cancelled draft side effects failed", a.id, e);
    }
  }
}

export function instructCard(owner: string, cardId: string, text: string, key: string, origin: { via: string; device: string | null }): CardActionAnswer {
  const words = text.trim();
  if (!words || words.length > 4000) throw new CardError("invalid_instruction", 400, "text: 1–4000 characters");
  return idempotent(owner, cardId, key, `instruct:${sha256(words).slice(0, 16)}`, () => {
    const card = getCard(owner, cardId);
    if (!card) throw new CardError("not_found", 404);
    if (card.state === "working") throw new CardError("turn_running", 409, "a turn is already running in this card's thread");
    if (!card.threadId || !getThread(card.threadId)) throw new CardError("card_has_no_thread", 409);
    const claimed = transitionCard(owner, cardId, ["proposed", "snoozed", "draft-ready"], "working", { action: "instruct", detail: clip(words, 2000) }, { chosenOptionId: null });
    if (!claimed) throw notOpen(owner, cardId);
    // A turn already running in the thread puts the card back (draft untouched); only a started turn retires the draft.
    const answer = startCardTurn(owner, card, claimed, instructPrompt(claimed, words), key);
    if (card.state === "draft-ready") cancelPendingDrafts(owner, card.approvalIds, origin, key);
    return answer;
  });
}

// ── the approval gate moves the card ───────────────────────────────────────

/** A draft the card's own turn proposed (omni_propose in its thread): the card now waits for Send. */
export function cardAfterProposal(owner: string, threadId: string | null, approvalId: string): Card | null {
  if (!threadId) return null;
  const card = cardsByThread(owner, threadId).find((c) => c.state === "working" || c.state === "proposed" || c.state === "draft-ready");
  if (!card) return null;
  // Answered elsewhere while this turn runs: the draft is never linked or announced; the turn's end cancels it.
  if (resolvedPending(card)) return null;
  const earlier = card.approvalIds;
  const next = transitionCard(owner, card.id, ["working", "proposed", "draft-ready"], "draft-ready", { action: "draft", approvalId }, { approvalId });
  if (!next) return null;
  // One card, one live draft: a newer proposal replaces the one still waiting.
  if (card.state === "draft-ready") cancelPendingDrafts(owner, earlier, { via: "superseded", device: null }, approvalId, { prefix: "superseded", actor: "omni", detail: `superseded by ${approvalId}` });
  announceCard(next, "draft-ready", { push: true });
  return next;
}

/** The owner's decision on a card's draft. Only the card's LATEST draft moves it; an older one that was
 *  sent is recorded (the message did go out) without changing the state. A decision arriving while the
 *  card is `working` (an older draft decided after an instruct): sent finishes the card, the rest leaves it. */
export function cardAfterDecision(owner: string, approvalId: string, outcome: "sent" | "failed" | "unknown" | "cancelled" | "revised"): Card | null {
  const card = cardForApproval(owner, approvalId);
  if (!card) return null;
  const log = { action: `approval-${outcome}`, approvalId };
  if (card.approvalIds[card.approvalIds.length - 1] !== approvalId) {
    if (outcome !== "sent") return null;
    const next = transitionCard(owner, card.id, [card.state], card.state, log);
    if (next) announceCard(next, "approval-sent", { push: false });
    return next;
  }
  let from: CardState[];
  let to: CardState;
  if (card.state === "draft-ready") {
    from = ["draft-ready"];
    to = outcome === "sent" ? "sent" : outcome === "cancelled" ? "proposed" : outcome === "revised" ? "working" : "draft-ready";
  } else if (card.state === "working") {
    from = ["working"];
    to = outcome === "sent" ? "sent" : "working";
    if (outcome === "revised") return null;
  } else return null;
  const next = transitionCard(owner, card.id, from, to, log, outcome === "cancelled" && to === "proposed" ? { chosenOptionId: null } : {});
  if (next) announceCard(next, to === card.state ? `approval-${outcome}` : to, { push: false });
  return next;
}

/** Edit made a new approval for the same draft: the card follows the new one. */
export function relinkApproval(owner: string, oldApprovalId: string, newApprovalId: string): Card | null {
  const card = cardForApproval(owner, oldApprovalId);
  // Only the card's live (latest) draft is followed; editing an older one leaves the card as it is.
  if (!card || card.approvalIds[card.approvalIds.length - 1] !== oldApprovalId) return null;
  const next = linkApproval(owner, card.id, newApprovalId);
  if (next) announceCard(next, "draft-edited", { push: false });
  return next;
}

/** A turn in a card's thread ended. A card whose item was answered elsewhere during the turn closes now and every
 *  draft still pending in the thread (linked or proposed during the turn) is cancelled. Otherwise, if the card is still
 *  `working`, no draft was proposed and no new options were posted, so the question is back with him (Decide);
 *  a drafted card is already `draft-ready` and is left alone. */
export function cardAfterTurnEnded(threadId: string, status: string): void {
  const owner = omniConfig.ownerEmail();
  for (const c of cardsByThread(owner, threadId)) {
    if (resolvedPending(c)) {
      const inThread = listApprovals(owner, "pending", 500).filter((a) => a.threadId === threadId && a.kind !== "command").map((a) => a.id);
      cancelPendingDrafts(owner, [...new Set([...c.approvalIds, ...inThread])], SOURCE_RESOLVED, "source-resolved-turn", ANSWERED_ELSEWHERE);
      const done = transitionCard(owner, c.id, OPEN_STATES, "done", { action: "resolved-elsewhere" });
      if (done) announceCard(done, "resolved", { push: false });
      continue;
    }
    if (c.state !== "working") continue;
    const next = transitionCard(owner, c.id, ["working"], "proposed", { action: "turn-ended", detail: status }, { chosenOptionId: null });
    if (next) announceCard(next, "turn-ended", { push: false });
  }
}
onTurnEnded(cardAfterTurnEnded);

const SOURCE_RESOLVED = { via: "source-resolved", device: null };
const ANSWERED_ELSEWHERE = { prefix: "source-resolved", actor: "omni", detail: "answered elsewhere" };
const OPEN_STATES: CardState[] = ["proposed", "snoozed", "working", "waiting", "draft-ready"];
const TURN_PENDING = "pending: turn running";
/** Resolved elsewhere while a turn was running in the card's thread: the close waits for the turn's end. */
const resolvedPending = (c: Card): boolean => {
  const last = c.outcomes[c.outcomes.length - 1];
  return !!last && last.action === "resolved-elsewhere" && last.detail === TURN_PENDING && OPEN_STATES.includes(c.state);
};

/** Benjamin answered elsewhere (another mail client, the chat app) or the item closed: the card is
 *  done, and a draft for it must never be sendable a second time. Two cases wait instead of closing:
 *  a send already in flight (the decision settles the card) and a running turn in the card's thread
 *  (its end closes the card and cancels whatever draft it proposed meanwhile). */
export function resolveCardSource(owner: string, sourceKey: string, now: number = Date.now()): Card | null {
  const card = cardBySource(owner, sourceKey);
  if (!card || card.state === "sent" || card.state === "done" || card.state === "dismissed") return null;
  cancelPendingDrafts(owner, card.approvalIds, SOURCE_RESOLVED, "source-resolved", ANSWERED_ELSEWHERE);
  if (card.approvalIds.some((id) => getApproval(owner, id)?.status === "approved")) {
    transitionCard(owner, card.id, [card.state], card.state, { action: "resolved-elsewhere", detail: "send in flight" }, {}, now);
    return null;
  }
  if (card.threadId && activeTurn(card.threadId)) {
    if (resolvedPending(card)) return card;
    return transitionCard(owner, card.id, [card.state], card.state, { action: "resolved-elsewhere", detail: TURN_PENDING }, {}, now);
  }
  const next = transitionCard(owner, card.id, OPEN_STATES, "done", { action: "resolved-elsewhere" }, {}, now);
  if (next) announceCard(next, "resolved", { push: false });
  return next;
}

/**
 * What happens around an item card (spec 2026-10-15 §5–6): the agent publishing it, the owner's
 * choices, the approval gate and the card's thread. Every outward step goes through
 * proposeApproval → the owner's `decide`; nothing in this module sends anything.
 */
import { db } from "../db";
import { resolveNote } from "./records";
import { bindNudgeThread, listNudges, nudgeAction, resolveNudgeSource, type Candidate, type Nudge } from "./nudges";
import { clip, plainText } from "./titles";
import { ensureThread, getThread, sha256 } from "./store";
import { omniConfig } from "./config";
import { approvalView } from "./approvals";
import { proposeApproval } from "./propose";
import { recordProactiveOwnerTurn } from "./proactive";
import { emit, startTurn, withNotes } from "./turns";
import { publishNotice, pushOmni } from "./bus";
import { ensureSourceSession } from "./source-session";
import { ACTED_STATES, REOPENABLE_STATES, CardError, cardBySource, cardSourceKeys, cardView, compareCardViews, finishCardAction, getCard, linkApproval, listOpenCards, parseCardInput, priorCardAction, releaseCardAction, reserveCardAction, transitionCard, upsertCard, type CardOption, type Card, type CardFact, type CardInput, type CardKind, type CardSection } from "./cards";

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
  if (r.changed) announceCard(r.card, r.created ? "created" : reopens ? "reopened" : "updated", { push: r.created || reopens });
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

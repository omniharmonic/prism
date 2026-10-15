/**
 * What happens around an item card (spec 2026-10-15 §5–6): the agent publishing it, the owner's
 * choices, the approval gate and the card's thread. Every outward step goes through
 * proposeApproval → the owner's `decide`; nothing in this module sends anything.
 */
import { db } from "../db";
import { resolveNote } from "./records";
import { bindNudgeThread, listNudges, nudgeAction, resolveNudgeSource, type Candidate, type Nudge } from "./nudges";
import { clip, plainText } from "./titles";
import { ensureThread, getThread } from "./store";
import { emit } from "./turns";
import { publishNotice, pushOmni } from "./bus";
import { ensureSourceSession } from "./source-session";
import { ACTED_STATES, REOPENABLE_STATES, CardError, cardBySource, cardSourceKeys, cardView, compareCardViews, getCard, listOpenCards, parseCardInput, transitionCard, upsertCard, type Card, type CardFact, type CardInput, type CardKind, type CardSection } from "./cards";

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

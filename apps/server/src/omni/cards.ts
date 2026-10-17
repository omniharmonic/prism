/**
 * Item cards (spec 2026-10-15 §5–6): Omni's understanding of ONE item (an email thread, a chat
 * thread, an invite, a task) plus 2–4 concrete options. NOT the record cards of store.ts
 * (`omni_cards`, stream `t:"card"`). The agent publishes cards through a hook; only the owner's
 * routes move a card beyond `proposed`. Nothing here sends, proposes or executes anything.
 */
import { db } from "../db";
import { newId, sha256 } from "./store";
import { ApprovalInputError, canonicalJson, validatePayload, type ApprovalKind } from "./approvals";
import { looksLikeSlug, plainInline } from "./titles";

db.exec(`
CREATE TABLE IF NOT EXISTS omni_item_cards (
 id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, source_key TEXT NOT NULL, source_revision TEXT,
 kind TEXT NOT NULL, state TEXT NOT NULL, headline TEXT NOT NULL, context TEXT NOT NULL, ask TEXT,
 urgency TEXT NOT NULL, options TEXT NOT NULL, recommended TEXT, item_refs TEXT NOT NULL,
 thread_id TEXT, approval_ids TEXT NOT NULL DEFAULT '[]', chosen_option_id TEXT,
 outcomes TEXT NOT NULL DEFAULT '[]', digest TEXT NOT NULL, snoozed_until INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_email, source_key)
);
CREATE INDEX IF NOT EXISTS omni_item_cards_state ON omni_item_cards(owner_email, state, updated_at);
CREATE INDEX IF NOT EXISTS omni_item_cards_thread ON omni_item_cards(thread_id);
CREATE TABLE IF NOT EXISTS omni_card_actions (
 owner_email TEXT NOT NULL, card_id TEXT NOT NULL, idem_key TEXT NOT NULL, action TEXT NOT NULL,
 status INTEGER, response TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_email, card_id, idem_key)
);
`);
// Added after the table first shipped to development databases: a new message arrived on the item while
// the owner's draft or turn was under way (the card keeps the draft; the app warns before Send).
if (!(db.prepare("PRAGMA table_info(omni_item_cards)").all() as Array<{ name: string }>).some((c) => c.name === "source_changed")) {
  db.exec("ALTER TABLE omni_item_cards ADD COLUMN source_changed INTEGER NOT NULL DEFAULT 0");
}

export const CARD_KINDS = ["email", "message", "invite", "task", "scheduling", "other"] as const;
export const CARD_STATES = ["proposed", "working", "draft-ready", "sent", "waiting", "snoozed", "dismissed", "done"] as const;
export const CARD_URGENCIES = ["today", "this-week", "whenever"] as const;
export const CARD_PRODUCES = ["email", "email-reply", "message", "calendar-rsvp", "calendar-invite", "task", "note", "nothing"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export type CardState = (typeof CARD_STATES)[number];
export type CardUrgency = (typeof CARD_URGENCIES)[number];
export type CardSection = "decide" | "approve" | "motion";
/** Kinds a card option can draft: the existing outward kinds of the four sources (no new kinds in Phase 1). */
export const SENDABLE_KINDS = new Set<string>(["email", "email-reply", "message", "calendar-rsvp", "calendar-invite"]);
/** States the OWNER moved the card into: an agent re-publish never overwrites them. */
export const ACTED_STATES = new Set<CardState>(["working", "draft-ready", "waiting", "sent", "done", "dismissed"]);
/** Finished or waiting states a changed source item (new sourceRevision) reopens as `proposed`.
 *  `waiting` is reserved for Phase 2 (nothing moves a card there yet); its rules are already in place. */
export const REOPENABLE_STATES = new Set<CardState>(["sent", "done", "dismissed", "waiting"]);
/** The owner's draft or turn is under way: a changed item flags the card instead of replacing it. */
export const FLAGGABLE_STATES = new Set<CardState>(["working", "draft-ready"]);
export const URGENCY_RANK: Record<CardUrgency, number> = { today: 0, "this-week": 1, whenever: 2 };

export interface CardFact { text: string; source: string | null }
export interface CardDraft { kind: ApprovalKind; payload: Record<string, unknown> }
export interface CardOption { id: string; label: string; plan: string; produces: string[]; draft: CardDraft | null }
export interface CardOutcome { at: number; action: string; optionId?: string; approvalId?: string; detail?: string }
export interface CardInput {
  sourceKey: string; sourceRevision: string | null; kind: CardKind; headline: string; context: CardFact[]; ask: string | null;
  urgency: CardUrgency; options: CardOption[]; recommended: string | null; itemRefs: string[];
}
export interface Card extends CardInput {
  id: string; owner: string; state: CardState; threadId: string | null; approvalIds: string[]; chosenOptionId: string | null;
  outcomes: CardOutcome[]; digest: string; snoozedUntil: number | null; createdAt: number; updatedAt: number;
  /** A new message arrived on the item after the owner chose (draft-ready or working). */
  sourceChanged: boolean;
}

export class CardError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409 | 422 = 400, public detail?: string) { super(code); }
}

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,15}$/;
const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** One line of plain text: control characters and runs of whitespace become one space. */
function line(v: unknown, field: string, max: number, required = true): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new CardError("invalid_card", 400, `${field}: required`);
    return null;
  }
  if (typeof v !== "string") throw new CardError("invalid_card", 400, `${field}: a string`);
  const t = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) {
    if (required) throw new CardError("invalid_card", 400, `${field}: required`);
    return null;
  }
  if (Array.from(t).length > max) throw new CardError("invalid_card", 400, `${field}: at most ${max} characters`);
  return t;
}

function parseOption(raw: unknown, i: number, seen: Set<string>, itemRefs: string[] = []): CardOption {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CardError("invalid_options", 400, `options[${i}]: an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !OPTION_ID.test(o.id) || seen.has(o.id)) throw new CardError("invalid_options", 400, `options[${i}].id: unique, [a-z0-9-], at most 16`);
  seen.add(o.id);
  const label = line(o.label, `options[${i}].label`, 80)!;
  const plan = line(o.plan, `options[${i}].plan`, 500)!;
  if (!Array.isArray(o.produces) || o.produces.length > 4 || o.produces.some((p) => !has(CARD_PRODUCES, p))) {
    throw new CardError("invalid_options", 400, `options[${i}].produces: up to 4 of ${CARD_PRODUCES.join("|")}`);
  }
  const produces = [...new Set(o.produces as string[])];
  let draft: CardDraft | null = null;
  if (o.draft !== undefined && o.draft !== null) {
    const d = o.draft as Record<string, unknown>;
    if (typeof d !== "object" || Array.isArray(d)) throw new CardError("invalid_draft", 400, `options[${i}].draft: an object`);
    if (typeof d.kind !== "string" || !SENDABLE_KINDS.has(d.kind)) throw new CardError("invalid_draft", 400, `options[${i}].draft.kind: one of ${[...SENDABLE_KINDS].join(", ")}`);
    try {
      const v = validatePayload(d.kind, d.payload);
      draft = { kind: v.kind, payload: v.payload };
    } catch (e) {
      if (e instanceof ApprovalInputError) throw new CardError("invalid_draft", 400, `options[${i}].draft: ${e.message}`);
      throw e;
    }
    if (draft.kind === "email-reply" && !itemRefs.includes(String(draft.payload.noteId))) {
      throw new CardError("invalid_options", 400, `options[${i}].draft.payload.noteId: an email-reply draft must reply to one of itemRefs`);
    }
    if (!produces.includes(draft.kind)) throw new CardError("invalid_draft", 400, `options[${i}]: produces must list ${draft.kind}`);
  }
  return { id: o.id, label, plan, produces, draft };
}

/** Validate a card from the agent (hook body or omni_card). Throws CardError; never partial. */
export function parseCardInput(b: Record<string, unknown>): CardInput {
  if (typeof b.sourceKey !== "string" || !NOTE_ID.test(b.sourceKey)) throw new CardError("invalid_card", 400, "sourceKey: a note id");
  const sourceRevision = line(b.sourceRevision, "sourceRevision", 128, false);
  if (!has(CARD_KINDS, b.kind)) throw new CardError("invalid_card", 400, `kind: ${CARD_KINDS.join("|")}`);
  const headline = line(b.headline, "headline", 160)!;
  if (looksLikeSlug(headline) || plainInline(headline) !== headline) throw new CardError("headline_not_readable", 400, "headline: plain words, not a slug, path or markdown");
  if (!Array.isArray(b.context) || b.context.length > 4) throw new CardError("invalid_card", 400, "context: up to 4 facts");
  const context = b.context.map((f, i): CardFact => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new CardError("invalid_card", 400, `context[${i}]: an object`);
    const o = f as Record<string, unknown>;
    return { text: line(o.text, `context[${i}].text`, 200)!, source: line(o.source, `context[${i}].source`, 200, false) };
  });
  const ask = line(b.ask, "ask", 300, false);
  if (!has(CARD_URGENCIES, b.urgency)) throw new CardError("invalid_card", 400, `urgency: ${CARD_URGENCIES.join("|")}`);
  if (!Array.isArray(b.itemRefs) || b.itemRefs.length < 1 || b.itemRefs.length > 10 || b.itemRefs.some((x) => typeof x !== "string" || !NOTE_ID.test(x)) || !b.itemRefs.includes(b.sourceKey)) {
    throw new CardError("invalid_card", 400, "itemRefs: 1–10 note ids including sourceKey");
  }
  const itemRefs = [...new Set(b.itemRefs as string[])];
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 4) throw new CardError("invalid_options", 400, "options: 2 to 4");
  const seen = new Set<string>();
  const options = b.options.map((o, i) => parseOption(o, i, seen, itemRefs));
  if (b.recommended !== undefined && b.recommended !== null && typeof b.recommended !== "string") throw new CardError("invalid_options", 400, "recommended: an option id string or null");
  const recommended = b.recommended === undefined || b.recommended === null ? null : b.recommended;
  if (recommended !== null && !seen.has(recommended)) throw new CardError("invalid_options", 400, "recommended: one of the option ids");
  const rec = options.find((o) => o.id === recommended);
  if (rec && rec.produces.some((p) => SENDABLE_KINDS.has(p)) && !rec.draft) throw new CardError("invalid_options", 400, "recommended: an option that sends needs its draft");
  return { sourceKey: b.sourceKey, sourceRevision, kind: b.kind, headline, context, ask, urgency: b.urgency, options, recommended, itemRefs };
}

type Raw = {
  id: string; owner_email: string; source_key: string; source_revision: string | null; kind: string; state: string; headline: string;
  context: string; ask: string | null; urgency: string; options: string; recommended: string | null; item_refs: string; thread_id: string | null;
  approval_ids: string; chosen_option_id: string | null; outcomes: string; digest: string; snoozed_until: number | null; created_at: number; updated_at: number;
  source_changed: number;
};
const toCard = (r: Raw): Card => ({
  id: r.id, owner: r.owner_email, sourceKey: r.source_key, sourceRevision: r.source_revision, kind: r.kind as CardKind, state: r.state as CardState,
  headline: r.headline, context: JSON.parse(r.context) as CardFact[], ask: r.ask, urgency: r.urgency as CardUrgency, options: JSON.parse(r.options) as CardOption[],
  recommended: r.recommended, itemRefs: JSON.parse(r.item_refs) as string[], threadId: r.thread_id, approvalIds: JSON.parse(r.approval_ids) as string[],
  chosenOptionId: r.chosen_option_id, outcomes: JSON.parse(r.outcomes) as CardOutcome[], digest: r.digest, snoozedUntil: r.snoozed_until,
  createdAt: r.created_at, updatedAt: r.updated_at, sourceChanged: !!r.source_changed,
});
const contentDigest = (input: CardInput): string => sha256(canonicalJson(input));
const inputOf = (c: Card): CardInput => ({
  sourceKey: c.sourceKey, sourceRevision: c.sourceRevision, kind: c.kind, headline: c.headline, context: c.context, ask: c.ask,
  urgency: c.urgency, options: c.options, recommended: c.recommended, itemRefs: c.itemRefs,
});
/** What the owner's device saw: choose / instruct carry it back, and a card whose content changed since
 *  (new options, a new message on the item) answers 409 card_changed. State changes alone keep it. */
export const cardVersion = (c: Card): string => c.digest.slice(0, 16);
const OPEN = "('proposed','snoozed','draft-ready','working','waiting')";

export function getCard(owner: string, id: string): Card | null {
  const r = db.prepare("SELECT * FROM omni_item_cards WHERE owner_email=? AND id=?").get(owner, id) as Raw | undefined;
  return r ? toCard(r) : null;
}
export function cardBySource(owner: string, sourceKey: string): Card | null {
  const r = db.prepare("SELECT * FROM omni_item_cards WHERE owner_email=? AND source_key=?").get(owner, sourceKey) as Raw | undefined;
  return r ? toCard(r) : null;
}
export const cardsByThread = (owner: string, threadId: string): Card[] =>
  (db.prepare("SELECT * FROM omni_item_cards WHERE owner_email=? AND thread_id=? ORDER BY updated_at DESC LIMIT 20").all(owner, threadId) as Raw[]).map(toCard);
export function cardForApproval(owner: string, approvalId: string): Card | null {
  const r = db.prepare("SELECT c.* FROM omni_item_cards c, json_each(c.approval_ids) j WHERE c.owner_email=? AND j.value=? LIMIT 1").get(owner, approvalId) as Raw | undefined;
  return r ? toCard(r) : null;
}
export const cardSourceKeys = (owner: string): Set<string> =>
  new Set((db.prepare("SELECT source_key FROM omni_item_cards WHERE owner_email=?").all(owner) as Array<{ source_key: string }>).map((r) => r.source_key));
export const listOpenCards = (owner: string, now = Date.now()): Card[] =>
  (db.prepare(`SELECT * FROM omni_item_cards WHERE owner_email=? AND state IN ${OPEN} ORDER BY updated_at DESC LIMIT 500`).all(owner) as Raw[])
    .map(toCard).filter((c) => cardSection(c, now) !== null);

/** Create, or refresh a card the owner has not acted on. Same content = no change (a replay). */
export const upsertCard = db.transaction((owner: string, input: CardInput, threadId: string, now: number = Date.now()): { card: Card; created: boolean; changed: boolean; ignored?: "owner_acted"; flagged?: "source_changed" } => {
  const digest = contentDigest(input);
  const old = cardBySource(owner, input.sourceKey);
  if (!old) {
    const id = newId("card");
    db.prepare(`INSERT INTO omni_item_cards (id, owner_email, source_key, source_revision, kind, state, headline, context, ask, urgency, options, recommended, item_refs, thread_id, outcomes, digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, owner, input.sourceKey, input.sourceRevision, input.kind, input.headline, JSON.stringify(input.context), input.ask, input.urgency,
      JSON.stringify(input.options), input.recommended, JSON.stringify(input.itemRefs), threadId, JSON.stringify([{ at: now, action: "proposed" }]), digest, now, now);
    return { card: getCard(owner, id)!, created: true, changed: true };
  }
  if (REOPENABLE_STATES.has(old.state) && input.sourceRevision !== null && input.sourceRevision !== old.sourceRevision) {
    const outcomes = [...old.outcomes, { at: now, action: "reopened", detail: `${old.sourceRevision ?? "none"} -> ${input.sourceRevision}` }].slice(-50);
    db.prepare(`UPDATE omni_item_cards SET state='proposed', source_revision=?, kind=?, headline=?, context=?, ask=?, urgency=?, options=?, recommended=?, item_refs=?, digest=?, chosen_option_id=NULL, snoozed_until=NULL, source_changed=0, outcomes=?, thread_id=COALESCE(thread_id, ?), updated_at=? WHERE id=?`).run(
      input.sourceRevision, input.kind, input.headline, JSON.stringify(input.context), input.ask, input.urgency, JSON.stringify(input.options), input.recommended,
      JSON.stringify(input.itemRefs), digest, JSON.stringify(outcomes), threadId, now, old.id);
    return { card: getCard(owner, old.id)!, created: false, changed: true };
  }
  if (FLAGGABLE_STATES.has(old.state) && input.sourceRevision !== null && input.sourceRevision !== old.sourceRevision) {
    // A new message while his draft waits (or his turn runs): the draft is neither cancelled nor sent. The card
    // takes the new revision and context and is flagged, so the app warns before Send and he can choose again.
    const merged: CardInput = { ...inputOf(old), sourceRevision: input.sourceRevision, context: input.context };
    const outcomes = [...old.outcomes, { at: now, action: "source-changed", detail: `${old.sourceRevision ?? "none"} -> ${input.sourceRevision}` }].slice(-50);
    db.prepare("UPDATE omni_item_cards SET source_revision=?, context=?, digest=?, source_changed=1, outcomes=?, updated_at=? WHERE id=?").run(
      input.sourceRevision, JSON.stringify(input.context), contentDigest(merged), JSON.stringify(outcomes), now, old.id);
    return { card: getCard(owner, old.id)!, created: false, changed: true, flagged: "source_changed" };
  }
  if (ACTED_STATES.has(old.state)) return { card: old, created: false, changed: false, ignored: "owner_acted" };
  if (old.digest === digest) return { card: old, created: false, changed: false };
  const outcomes = [...old.outcomes, { at: now, action: "updated" }].slice(-50);
  db.prepare(`UPDATE omni_item_cards SET source_revision=?, kind=?, headline=?, context=?, ask=?, urgency=?, options=?, recommended=?, item_refs=?, digest=?, outcomes=?, source_changed=0, thread_id=COALESCE(thread_id, ?), updated_at=? WHERE id=?`).run(
    input.sourceRevision, input.kind, input.headline, JSON.stringify(input.context), input.ask, input.urgency, JSON.stringify(input.options), input.recommended,
    JSON.stringify(input.itemRefs), digest, JSON.stringify(outcomes), threadId, now, old.id);
  return { card: getCard(owner, old.id)!, created: false, changed: true };
});

/** Atomic state change, only from one of `from`. Null when the card is not in `from` (or unknown). */
export function transitionCard(
  owner: string, id: string, from: CardState[], to: CardState, outcome: Omit<CardOutcome, "at">,
  patch: { chosenOptionId?: string | null; approvalId?: string; snoozedUntil?: number | null } = {}, now: number = Date.now(),
): Card | null {
  return db.transaction((): Card | null => {
    const c = getCard(owner, id);
    if (!c || !from.includes(c.state)) return null;
    const approvals = patch.approvalId && !c.approvalIds.includes(patch.approvalId) ? [...c.approvalIds, patch.approvalId] : c.approvalIds;
    const outcomes = [...c.outcomes, { at: now, ...outcome }].slice(-50);
    const chosen = patch.chosenOptionId !== undefined ? patch.chosenOptionId : c.chosenOptionId;
    const snoozed = to === "snoozed" ? (patch.snoozedUntil !== undefined ? patch.snoozedUntil : c.snoozedUntil) : null;
    // Back in Decide (or closed), he chooses against the card as it now is: the "new message" flag has done its job.
    const flag = c.sourceChanged && FLAGGABLE_STATES.has(to) ? 1 : 0;
    db.prepare("UPDATE omni_item_cards SET state=?, chosen_option_id=?, approval_ids=?, outcomes=?, snoozed_until=?, source_changed=?, updated_at=? WHERE id=? AND owner_email=?")
      .run(to, chosen, JSON.stringify(approvals), JSON.stringify(outcomes), snoozed, flag, now, id, owner);
    return getCard(owner, id);
  })();
}

/** The agent posted new options from the card's thread (omni_card): new content, back to `proposed`. */
export function replaceCardContent(owner: string, id: string, input: CardInput, from: CardState[], now: number = Date.now()): Card | null {
  return db.transaction((): Card | null => {
    const c = getCard(owner, id);
    if (!c || !from.includes(c.state) || input.sourceKey !== c.sourceKey) return null;
    const outcomes = [...c.outcomes, { at: now, action: "agent-update" }].slice(-50);
    db.prepare(`UPDATE omni_item_cards SET state='proposed', source_revision=?, item_refs=?, kind=?, headline=?, context=?, ask=?, urgency=?, options=?, recommended=?, digest=?, chosen_option_id=NULL, snoozed_until=NULL, source_changed=0, outcomes=?, updated_at=? WHERE id=?`).run(
      input.sourceRevision, JSON.stringify(input.itemRefs), input.kind, input.headline, JSON.stringify(input.context), input.ask, input.urgency, JSON.stringify(input.options), input.recommended, contentDigest(input), JSON.stringify(outcomes), now, id);
    return getCard(owner, id);
  })();
}

export function linkApproval(owner: string, cardId: string, approvalId: string, now: number = Date.now()): Card | null {
  return db.transaction((): Card | null => {
    const c = getCard(owner, cardId);
    if (!c) return null;
    if (c.approvalIds.includes(approvalId)) return c;
    db.prepare("UPDATE omni_item_cards SET approval_ids=?, updated_at=? WHERE id=?").run(JSON.stringify([...c.approvalIds, approvalId]), now, cardId);
    return getCard(owner, cardId);
  })();
}

export function cardSection(c: Card, now: number = Date.now()): CardSection | null {
  if (c.state === "proposed" || (c.state === "snoozed" && (c.snoozedUntil ?? 0) <= now)) return "decide";
  if (c.state === "draft-ready") return "approve";
  if (c.state === "working" || c.state === "waiting") return "motion";
  return null;
}

const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

/** The wire shape (docs/omni-module.md § Item cards). Never carries the owner or the digest. */
export function cardView(c: Card, now: number = Date.now()): Record<string, unknown> {
  return {
    id: c.id, sourceKey: c.sourceKey, kind: c.kind, state: c.state, headline: c.headline, context: c.context, ask: c.ask, urgency: c.urgency,
    options: c.options.map((o) => ({ id: o.id, label: o.label, plan: o.plan, produces: o.produces, draft: o.draft })),
    recommended: c.recommended, itemRefs: c.itemRefs, threadId: c.threadId, approvalIds: c.approvalIds, chosenOptionId: c.chosenOptionId,
    outcomes: c.outcomes.map((o) => ({ ...o, at: iso(o.at) })),
    createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt), snoozedUntil: iso(c.snoozedUntil),
    section: cardSection(c, now), transitional: false, nudgeId: null,
    version: cardVersion(c), sourceChanged: c.sourceChanged && FLAGGABLE_STATES.has(c.state),
  };
}
/** Urgency first, then the one waiting longest. Works on views (real and transitional). */
export function compareCardViews(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ra = URGENCY_RANK[a.urgency as CardUrgency] ?? 2, rb = URGENCY_RANK[b.urgency as CardUrgency] ?? 2;
  if (ra !== rb) return ra - rb;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
}

// ── idempotent owner actions (choose / instruct) ────────────────────────────

export function priorCardAction(owner: string, cardId: string, key: string): { action: string; status: number | null; response: Record<string, unknown> | null } | null {
  const r = db.prepare("SELECT action, status, response FROM omni_card_actions WHERE owner_email=? AND card_id=? AND idem_key=?").get(owner, cardId, key) as { action: string; status: number | null; response: string | null } | undefined;
  return r ? { action: r.action, status: r.status, response: r.response ? (JSON.parse(r.response) as Record<string, unknown>) : null } : null;
}
export const reserveCardAction = (owner: string, cardId: string, key: string, action: string): boolean =>
  db.prepare("INSERT OR IGNORE INTO omni_card_actions (owner_email, card_id, idem_key, action, created_at) VALUES (?, ?, ?, ?, ?)").run(owner, cardId, key, action, Date.now()).changes > 0;
export const finishCardAction = (owner: string, cardId: string, key: string, status: number, response: Record<string, unknown>): void =>
  void db.prepare("UPDATE omni_card_actions SET status=?, response=? WHERE owner_email=? AND card_id=? AND idem_key=?").run(status, JSON.stringify(response), owner, cardId, key);
export const releaseCardAction = (owner: string, cardId: string, key: string): void =>
  void db.prepare("DELETE FROM omni_card_actions WHERE owner_email=? AND card_id=? AND idem_key=? AND response IS NULL").run(owner, cardId, key);

export function resetCardsForTests(): void {
  db.exec("DELETE FROM omni_item_cards; DELETE FROM omni_card_actions;");
}

// Contact tidy-up (D17, PRD §5.11a): Comms helps the owner make the vault's people accurate.
//
//   list    "People to tidy": DM counterparts with no person note, ranked by how much the owner
//           talks with them (indexed messages) and how recently. Ignored ones never come back.
//   link    write the counterpart's handle (Matrix id / phone / email) onto an EXISTING person note
//           with the identity layer's own key patch (people-metadata.ts addKeyPatch), compare-and-set.
//   create  a NEW person note, the person-creation path's shape (worker/people.ts findOrCreate:
//           path vault/people/<slug>, metadata {type, name, channels}, tag person), validated
//           against vault-shapes.json before it is sent.
//   ignore  local only (comms_tidy_ignored); nothing is written to the vault.
//   undo    every action is recorded with what undo needs (comms_tidy_actions): the person-note
//           fields before and after the write. Undo restores the fields only while the note still
//           holds exactly what was written; a created note is removed only while unchanged.
//
// Rules (review focus: a wrong link is data damage): every write is an explicit owner request
// (human origin; agent-origin is refused), a handle another person already claims is never
// written (409), a name that matches existing people is never created silently (409 with them),
// and persons are NEVER merged here — "same person?" goes to Prism's merge-recommendation queue
// (people-agent-store.ts recommendMerge), where the owner decides in Prism.
import { randomUUID } from "node:crypto";
import { db, resolveVaultEntry } from "../db";
import { config } from "../config";
import { visibleSql } from "./store";
import { vaultClient, VaultConflictError, VaultError, type Note } from "../parachute";
import { IdentityIndex, isNonHumanPerson, matrixKeys, normalizePhone, looksLikeEmail, ownerProfile, slugKey, cleanName, type IdentityKey } from "../identity";
import { ownerConfigFor } from "../people-owner";
import { storedOwnerSenders } from "./owner";
import { agentSenderIds } from "../worker/matrix";
import { isBridgeLike } from "./bridge-like";
import { addKeyPatch } from "../people-metadata";
import { acquirePeopleLock } from "../people-lock";
import { peopleListing } from "../people-review-service";
import { invalidatePeople } from "../people-cache";
import { resetConversationIndex } from "../people-conversations";
import { treeRemoveNote, treeUpsertNote } from "../tree";
import { creationRefusal, rustSanitizePath, cleanDisplayName } from "../worker/people";
import { declaredViolations, shapeViolations } from "../vault-shapes";
import { recommendMerge, dismissRecommendation } from "../people-agent-store";
import { appendEvent } from "./store";
import { messageCountsFor } from "./search-index";
import { recordTrashedNote } from "../pages";
import { TRASH_META, TRASH_TAG } from "@prism/core/pages";
import { ghostContact, personName } from "./people";
import { exactNameKey } from "../person-name";
import type { AvatarRef, Network } from "./types";

export const tidyEnabled = (): boolean => config.commsEnabled && config.commsTidyEnabled;

export class TidyError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 503, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
  body(): Record<string, unknown> { return { error: this.code, ...this.extra }; }
}

// ── handles ──────────────────────────────────────────────────────────────────

export interface TidyHandle { kind: "phone" | "email" | "username" | "userId" | "matrix"; value: string }

/** The identity key a counterpart's member id gives (what link/create write), or null. */
export function memberKey(memberId: string): IdentityKey | null {
  const id = memberId.trim().toLowerCase();
  if (id.startsWith("tel:")) {
    const d = normalizePhone(id.slice(4));
    return d ? { kind: "phone", value: d } : null;
  }
  if (id.startsWith("mailto:")) {
    const e = id.slice(7);
    return looksLikeEmail(e) ? { kind: "email", value: e } : null;
  }
  return matrixKeys(id)[0] ?? null; // the Matrix id itself (a puppet's remote id rides inside it)
}

/** Every key a member id carries (a puppet's phone / remote id too): what a claim is checked against. */
export const claimKeysOf = (members: string[]): IdentityKey[] =>
  members.flatMap((m) => (matrixKeys(m).length ? matrixKeys(m) : [memberKey(m)].filter((k): k is IdentityKey => !!k)));

/** What to show the owner for a member (a phone, an email, a username) — never the raw puppet id. */
export function memberHandle(memberId: string): TidyHandle | null {
  const id = memberId.trim().toLowerCase();
  if (id.startsWith("tel:")) return { kind: "phone", value: id.slice(4) };
  if (id.startsWith("mailto:")) return { kind: "email", value: id.slice(7) };
  const g = ghostContact(id);
  if (g.phone) return { kind: "phone", value: g.phone.value };
  if (g.handle) return { kind: g.handle.kind, value: g.handle.value };
  return id.startsWith("@") && !/^@[a-z]+_/.test(id) ? { kind: "matrix", value: id } : null;
}

// ── who is unlinked ──────────────────────────────────────────────────────────

interface UnlinkedRow {
  vault_note_id: string | null;
  thread_id: string; network: Network; title: string; avatar_json: string | null; last_event_at: string; member_id: string; folder: string;
}

const E_FOLDER = `COALESCE(t.o_folder, CASE WHEN COALESCE(t.o_archived, c.archived) = 1 THEN 'archived' ELSE c.folder END)`;

function unlinkedRows(threadId?: string): UnlinkedRow[] {
  return db.prepare(`SELECT t.id AS thread_id, c.vault_note_id, c.network, c.title, c.avatar_json, c.last_event_at, cm.member_id, ${E_FOLDER} AS folder
    FROM comms_threads t JOIN comms_thread_members m ON m.thread_id = t.id JOIN comms_conversations c ON c.id = m.conversation_id
    JOIN comms_conversation_members cm ON cm.conversation_id = c.id
    WHERE c.kind = 'dm' AND t.person_id IS NULL AND cm.person_id IS NULL AND ${visibleSql()} ${threadId ? "AND t.id = ?" : ""}
      AND NOT EXISTS (SELECT 1 FROM comms_tidy_ignored i WHERE i.member_id = cm.member_id)
    ORDER BY t.id, cm.member_id`).all(...(threadId ? [threadId] : [])) as UnlinkedRow[];
}

export interface TidySuggestion { personId: string; name: string; reason: "same-handle" | "same-name" }
export interface TidyItem {
  threadId: string; network: Network; name: string; avatar: AvatarRef | null; handle: TidyHandle | null;
  messageCount: number; lastActivityAt: string; score: number; suggestions: TidySuggestion[];
}

/** Volume + recency: log(1 + messages) + 3·e^(−age/30 days). */
export const tidyScore = (messages: number, lastActivityMs: number, now: number): number =>
  Math.log1p(messages) + 3 * Math.exp(-Math.max(0, now - lastActivityMs) / (30 * 86_400_000));

/** One item per thread (its members' best handle: a phone over an opaque id). */
function itemsOf(rows: UnlinkedRow[], now: number): TidyItem[] {
  // Message volume from the maintained per-conversation counts (review I3: no index scan).
  const scopeOf = (r: UnlinkedRow) => r.vault_note_id ?? `t:${r.thread_id}`;
  const counts = messageCountsFor([...new Set(rows.flatMap((r) => [scopeOf(r), `t:${r.thread_id}`]))]);
  const byThread = new Map<string, { row: UnlinkedRow; members: string[] }>();
  for (const r of rows) {
    if (r.folder === "spam") continue;
    const cur = byThread.get(r.thread_id);
    if (cur) cur.members.push(r.member_id);
    else byThread.set(r.thread_id, { row: r, members: [r.member_id] });
  }
  const out: TidyItem[] = [];
  for (const { row, members } of byThread.values()) {
    const handles = members.map(memberHandle).filter((h): h is TidyHandle => !!h);
    const handle = handles.find((h) => h.kind === "phone") ?? handles.find((h) => h.kind === "email") ?? handles[0] ?? null;
    let avatar: AvatarRef | null = null;
    try { avatar = row.avatar_json ? (JSON.parse(row.avatar_json) as AvatarRef) : null; } catch { avatar = null; }
    const n = (counts.get(scopeOf(row)) ?? 0) + (row.vault_note_id ? counts.get(`t:${row.thread_id}`) ?? 0 : 0);
    const at = Date.parse(row.last_event_at);
    out.push({
      threadId: row.thread_id, network: row.network, name: row.title, avatar, handle, messageCount: n, lastActivityAt: row.last_event_at,
      score: Math.round(tidyScore(n, Number.isFinite(at) ? at : 0, now) * 1000) / 1000, suggestions: [],
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.lastActivityAt < b.lastActivityAt ? 1 : -1) || a.threadId.localeCompare(b.threadId));
}

/** Every unlinked DM counterpart (best first) with its member ids and thread note: the batch's input. */
export function tidyCandidates(now = Date.now()): Array<{ item: TidyItem; members: string[]; vaultNoteId: string | null }> {
  const rows = unlinkedRows();
  const byThread = new Map<string, { members: string[]; note: string | null }>();
  for (const r of rows) {
    const cur = byThread.get(r.thread_id);
    if (cur) cur.members.push(r.member_id);
    else byThread.set(r.thread_id, { members: [r.member_id], note: r.vault_note_id });
  }
  return itemsOf(rows, now).map((item) => {
    const t = byThread.get(item.threadId)!;
    return { item, members: [...new Set(t.members)].slice(0, 5), vaultNoteId: t.note };
  });
}

/** People the owner might mean: whoever already holds one of the handles, then same-name people. */
function suggestionsFor(idx: IdentityIndex, name: string, members: string[]): TidySuggestion[] {
  const out = new Map<string, TidySuggestion>();
  for (const mid of members) {
    for (const k of claimKeysOf([mid])) {
      for (const p of idx.claimants(k)) {
        const live = idx.canonicalOf(p);
        if (live && !isNonHumanPerson(live)) out.set(live.id, { personId: live.id, name: personName(live), reason: "same-handle" });
      }
    }
  }
  for (const p of idx.named(name)) {
    const live = idx.canonicalOf(p);
    if (live && !isNonHumanPerson(live) && !out.has(live.id)) out.set(live.id, { personId: live.id, name: personName(live), reason: "same-name" });
  }
  return [...out.values()].slice(0, 5);
}

const peopleIndex = async (vaultId: string, fresh = false): Promise<IdentityIndex> =>
  new IdentityIndex((await peopleListing(vaultId, fresh)).filter((n) => (n.tags ?? []).includes("person")));

/** "People to tidy": a page of unlinked DM counterparts, best first, with suggestions. */
export async function listTidy(vaultId: string, o: { offset: number; limit: number; now?: number }): Promise<{ items: TidyItem[]; total: number; partial: boolean }> {
  const rows = unlinkedRows();
  const all = itemsOf(rows, o.now ?? Date.now());
  const items = all.slice(o.offset, o.offset + o.limit);
  let partial = false;
  if (items.length) {
    try {
      const idx = await peopleIndex(vaultId);
      for (const it of items) it.suggestions = suggestionsFor(idx, it.name, rows.filter((r) => r.thread_id === it.threadId).map((r) => r.member_id));
    } catch {
      partial = true; // the people directory is unavailable: the list still shows
    }
  }
  return { items, total: all.length, partial };
}

/** "Who is this?" for one DM, or null when it needs nothing (linked, ignored, a group). */
export async function tidyForThread(vaultId: string, threadId: string): Promise<{ item: TidyItem; partial: boolean } | null> {
  const rows = unlinkedRows(threadId);
  const [item] = itemsOf(rows, Date.now());
  if (!item) return null;
  try {
    item.suggestions = suggestionsFor(await peopleIndex(vaultId), item.name, rows.map((r) => r.member_id));
    return { item, partial: false };
  } catch {
    return { item, partial: true };
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

export interface TidyActor { email: string; via: string }
/** What a batch passes along (scripts/comms-batch-tidy.ts): the batch id on every action row, and
 *  the `source` a created person note records. The single-thread routes pass nothing. */
export interface TidyOptions {
  batchId?: string | null; source?: string | null;
  /** Pause after every thread-note read/write (a batch's rate limit; the routes go at once). */
  paceMs?: number; sleep?: (ms: number) => Promise<void>;
  /** The people index to decide on (a batch's short-lived cache); default: a fresh listing. */
  index?: () => Promise<IdentityIndex>;
  /** Told about every person note written (the batch keeps its cached index current). */
  onPersonWrite?: (n: Note) => void;
  /** Batch A: refuse unless this person (and only this person) still holds the counterpart's key. */
  requireHeld?: boolean;
  /** Batch exact-name: refuse unless the person's name still equals this display name (exactNameKey). */
  requireName?: string;
}
/** `recommend` = a batch filed a link question in Prism's review queue (no vault write). */
export type TidyActionKind = "link" | "create" | "ignore" | "recommend";
export interface TidyAction {
  id: string; kind: TidyActionKind; threadId: string; personId: string | null; personName: string | null;
  at: string; undone: boolean; recommendations?: number;
  /** Server-side only (the batch's counts): thread-note edges added / already there / failed. */
  threadLinks?: { added: number; existing: number; failed: number };
}

type ActionRow = {
  id: string; kind: TidyActionKind; thread_id: string; member_ids: string; person_id: string | null; person_name: string | null;
  before_json: string | null; after_json: string | null; after_updated_at: string | null; recommendation_ids: string | null;
  actor: string; at: number; undone_at: number | null; batch_id?: string | null; thread_links?: string | null;
};
const actionOut = (r: ActionRow): TidyAction => ({
  id: r.id, kind: r.kind, threadId: r.thread_id, personId: r.person_id, personName: r.person_name, at: new Date(r.at).toISOString(), undone: r.undone_at !== null,
  ...(r.recommendation_ids ? { recommendations: (JSON.parse(r.recommendation_ids) as string[]).length } : {}),
});

export function recordAction(a: Omit<ActionRow, "id" | "at" | "undone_at">, now = Date.now()): ActionRow {
  const row: ActionRow = { ...a, batch_id: a.batch_id ?? null, id: `ta_${randomUUID().replace(/-/g, "")}`, at: now, undone_at: null };
  db.prepare(`INSERT INTO comms_tidy_actions (id, kind, thread_id, member_ids, person_id, person_name, before_json, after_json, after_updated_at, recommendation_ids, actor, at, batch_id)
    VALUES (@id, @kind, @thread_id, @member_ids, @person_id, @person_name, @before_json, @after_json, @after_updated_at, @recommendation_ids, @actor, @at, @batch_id)`).run(row);
  return row;
}

/** The last actions the client shows (its wire kinds only: a batch's review-queue entries are not undone there). */
export function recentActions(limit = 20): TidyAction[] {
  return (db.prepare(`SELECT * FROM comms_tidy_actions WHERE kind IN ('link', 'create', 'ignore') ORDER BY at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(100, limit))) as ActionRow[]).map(actionOut);
}

/** The thread's unlinked members (the DM counterpart); 404 when it is not a DM that needs tidying. */
function membersToTidy(threadId: string): { members: string[]; title: string; network: Network } {
  const rows = unlinkedRows(threadId);
  if (!rows.length) {
    const t = db.prepare(`SELECT c.kind FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id WHERE m.thread_id = ?`).get(threadId) as { kind: string } | undefined;
    if (!t) throw new TidyError(404, "thread_unavailable");
    throw new TidyError(409, t.kind === "dm" ? "already_linked" : "not_a_dm");
  }
  return { members: [...new Set(rows.map((r) => r.member_id))].slice(0, 5), title: rows[0]!.title, network: rows[0]!.network };
}

/** Point the Comms projection at the person now (the next rebuild agrees: the note claims the handles). */
function applyLocalLink(threadId: string, members: string[], personId: string | null): void {
  const touched = new Set<string>([threadId]);
  db.transaction(() => {
    for (const mid of members) {
      db.prepare(`UPDATE comms_conversation_members SET person_id = ? WHERE member_id = ?`).run(personId, mid.toLowerCase());
      for (const r of db.prepare(`SELECT m.thread_id AS id FROM comms_conversation_members cm JOIN comms_conversations c ON c.id = cm.conversation_id
        JOIN comms_thread_members m ON m.conversation_id = c.id WHERE cm.member_id = ? AND c.kind = 'dm'`).all(mid.toLowerCase()) as { id: string }[]) touched.add(r.id);
    }
    for (const t of touched) db.prepare(`UPDATE comms_threads SET person_id = ? WHERE id = ?`).run(personId, t);
  })();
  for (const t of touched) appendEvent("thread.updated", t, { threadId: t, reason: "tidy" });
}

const vaultFor = (vaultId: string) => vaultClient(vaultId, { timeoutMs: config.peopleVaultTimeoutMs > 0 ? config.peopleVaultTimeoutMs : 15_000 });

/** Local follow-ups of a vault write that already happened: a failure here is logged, never
 *  turned into an error answer (the write and its undo record stand). */
function afterWrite(f: () => void): void {
  try { f(); } catch (e) { console.warn(`[comms] tidy follow-up failed: ${e instanceof Error ? e.name : "error"}`); }
}

function withLock<T>(f: () => Promise<T>): Promise<T> {
  const release = acquirePeopleLock("comms-tidy");
  if (!release) throw new TidyError(409, "busy");
  return f().finally(release);
}

function afterVaultWrite(vaultId: string, note: Note | null, removedId?: string): void {
  const entry = resolveVaultEntry(vaultId);
  if (note) treeUpsertNote(entry, note);
  if (removedId) treeRemoveNote(entry, removedId);
  invalidatePeople(vaultId);
  resetConversationIndex(vaultId);
}

const vaultFailure = (e: unknown): TidyError => {
  if (e instanceof TidyError) return e;
  if (e instanceof VaultConflictError) return new TidyError(409, "conflict");
  if (e instanceof VaultError && e.status === 404) return new TidyError(404, "person_unavailable");
  return new TidyError(503, "source_unavailable");
};

/** Who already claims one of these keys (other than `exceptId`). */
function claimedElsewhere(idx: IdentityIndex, keys: IdentityKey[], exceptId: string | null): Note | null {
  for (const k of keys) {
    for (const p of idx.claimants(k)) {
      const live = idx.canonicalOf(p) ?? p;
      if (live.id !== exceptId) return live;
    }
    const blocked = idx.claimedBy(k)[0];
    if (blocked) return blocked;
  }
  return null;
}

// ── who the counterpart is (never the owner, never a second member) ───────────

const keyIdOf = (k: IdentityKey): string => `${k.kind}\u0000${k.value}`;

/** An address in the form two spellings of one mailbox share: lower case, `+tag` dropped (every
 *  domain), dots dropped and googlemail → gmail for Gmail. Used to recognise, never to write. */
export function looseEmail(e: string): string {
  const t = e.trim().toLowerCase();
  const at = t.lastIndexOf("@");
  if (at <= 0) return t;
  let local = t.slice(0, at).split("+")[0]!;
  let domain = t.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** A phone written without "+" (person notes): 10 digits → the default country code + it; 11–15
 *  digits → taken as already international. Digits only (the identity layer's phone value). */
export function loosePhone(raw: string, defaultCode = config.peopleDefaultCountryCode): string | null {
  const t = raw.trim();
  if (!/^[\d\s().+-]+$/.test(t)) return null;
  const d = t.replace(/\D/g, "").replace(/^00/, "");
  if (t.startsWith("+") || t.startsWith("00")) return d.length >= 7 && d.length <= 15 ? d : null;
  if (d.length === 10) return `${defaultCode}${d}`;
  if (d.length === 11 && defaultCode === "1" && d.startsWith("1")) return d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export interface OwnerContext {
  /** The configured owner note: never a link target, never a review candidate. */
  personId: string | null;
  /** EVERY live note that is the owner: the configured one, any other holding his keys / addresses,
   *  or named with his full name / a multi-word alias. Never targets, never candidates. */
  personIds: Set<string>;
  /** slugKeys of his full names and aliases: a chat titled so is the owner (D). */
  names: Set<string>;
  /** His addresses, loosely normalised (`looseEmail`). */
  looseEmails: Set<string>;
  /** Member ids that are the owner (his bridge ghosts, the sync user, the agent's senders). */
  selfIds: Set<string>;
  /** Strong keys of the owner (his person note's keys + his addresses). */
  keys: Set<string>;
}

/** The owner, from configuration + his person note (ownerProfile, as the projection does). */
export function ownerContext(idx: IdentityIndex, vaultId: string): OwnerContext {
  const prof = ownerProfile(idx, ownerConfigFor(vaultId));
  const selfIds = new Set([...storedOwnerSenders(), ...agentSenderIds(), ...prof.matrixIds].map((i) => i.trim().toLowerCase()));
  const keys = new Set<string>();
  for (const e of prof.emails) keys.add(keyIdOf({ kind: "email", value: e }));
  for (const m of prof.matrixIds) for (const k of matrixKeys(m)) keys.add(keyIdOf(k));
  if (prof.person) for (const k of idx.keysFor(prof.person.id).strong) keys.add(keyIdOf(k));
  const looseEmails = new Set([...prof.emails].map(looseEmail));
  if (prof.person) for (const k of idx.keysFor(prof.person.id).strong) if (k.kind === "email") looseEmails.add(looseEmail(k.value));
  // His names: his note's own multi-word names (even when a duplicate note shares them — that is the
  // case to catch), his configured aliases, and ownerProfile's full names.
  const names = new Set([...prof.fullNames, ...prof.aliases]);
  if (prof.person) for (const n of idx.keysFor(prof.person.id).names) if (n.split("-").length >= 2) names.add(n);
  for (const a of ownerConfigFor(vaultId).aliases ?? []) { const k = slugKey(cleanName(a)); if (k && !looksLikeEmail(a)) names.add(k); }
  const multiWord = new Set([...names].filter((n) => n.split("-").length >= 2));
  const personIds = new Set<string>(prof.person ? [prof.person.id] : []);
  for (const p of idx.live()) {
    if (personIds.has(p.id)) continue;
    const k = idx.keysFor(p.id);
    if (k.strong.some((x) => keys.has(keyIdOf(x)) || (x.kind === "email" && looseEmails.has(looseEmail(x.value))))) personIds.add(p.id);
    else if ([...k.names, ...k.aliases].some((n) => multiWord.has(n))) personIds.add(p.id);
  }
  return { personId: prof.person?.id ?? null, personIds, names, looseEmails, selfIds, keys };
}

/** Is this display name the owner's (his full name or one of his configured aliases)? */
export const isOwnerName = (owner: OwnerContext, name: string): boolean => {
  const k = slugKey(cleanName(name));
  return !!k && owner.names.has(k);
};

/**
 * The ONE counterpart of a DM: members minus the owner (his ids, or a key his person holds) and
 * bridge bots. null when that leaves anything but exactly one — such a "DM" is never linked or
 * created from (a missed owner ghost or a third person would get someone else's keys).
 */
export function counterpartOf(members: string[], owner: OwnerContext): { counterpart: string[] | null; others: number; owner: boolean } {
  let ownerHit = false;
  const rest = members.filter((m) => {
    const id = m.trim().toLowerCase();
    if (owner.selfIds.has(id)) { ownerHit = true; return false; }
    if (isBridgeLike(id)) return false;
    if (claimKeysOf([id]).some((k) => owner.keys.has(keyIdOf(k)))) { ownerHit = true; return false; }
    if (id.startsWith("mailto:") && owner.looseEmails.has(looseEmail(id.slice(7)))) { ownerHit = true; return false; }
    return true;
  });
  // A WhatsApp contact can be two ghosts — its phone and its LID — paired by the projection under one
  // display name: that is ONE counterpart (both ids are theirs).
  const waPhone = rest.filter((m) => /^@whatsapp_\d{7,15}:/i.test(m));
  const waLid = rest.filter((m) => /^@whatsapp_lid-/i.test(m));
  if (rest.length === 2 && waPhone.length === 1 && waLid.length === 1) return { counterpart: rest, others: 1, owner: ownerHit };
  return { counterpart: rest.length === 1 ? rest : null, others: rest.length, owner: ownerHit };
}

// ── the conversation notes' person links ─────────────────────────────────────
//
// A person link is two facts: the person note holds the handle (above), and every message-thread note
// of the counterpart's DMs carries a `messages-with` edge to the person — the edge the Matrix and
// BlueBubbles ingesters write (worker/matrix.ts participantLinks, bluebubbles/ingest.ts) and that
// link health counts. Ingest appends only ever ADD links (`links: {add}`), so an edge written here
// stays. Each write is links-only (no body, no metadata, no title), compare-and-set, and verified by
// reading the note back; what was added is recorded for undo.

export const THREAD_RELATIONSHIP = "messages-with";
/** added = the edge was written (and verified) by this action; failed = to be retried on a resume. */
export interface ThreadLinkRecord { noteId: string; added: boolean; failed?: boolean }

/** The vault message-thread notes of the counterpart's DMs (this thread's and any other DM with them). */
export function threadNotesOf(threadId: string, members: string[]): string[] {
  const out = new Set<string>();
  for (const r of db.prepare(`SELECT c.vault_note_id AS n FROM comms_thread_members m JOIN comms_conversations c ON c.id = m.conversation_id
    WHERE m.thread_id = ? AND c.kind = 'dm' AND c.vault_note_id IS NOT NULL`).all(threadId) as { n: string }[]) out.add(r.n);
  for (const mid of members) {
    for (const r of db.prepare(`SELECT c.vault_note_id AS n FROM comms_conversation_members cm JOIN comms_conversations c ON c.id = cm.conversation_id
      WHERE cm.member_id = ? AND c.kind = 'dm' AND c.vault_note_id IS NOT NULL`).all(mid.toLowerCase()) as { n: string }[]) out.add(r.n);
  }
  return [...out].sort().slice(0, 20);
}

const hasEdge = (n: Note, from: string, to: string): boolean =>
  (n.links ?? []).some((l) => l.sourceId === from && l.targetId === to && l.relationship === THREAD_RELATIONSHIP);
const linkRead = (vault: ReturnType<typeof vaultFor>, id: string) => vault.getNote(id, { includeLinks: true, includeContent: false, includeMetadata: ["type"] });

/** Give each thread note the edge to the person; record each one as it lands (crash-safe undo). */
const pause = async (o: TidyOptions) => { if (o.paceMs) await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(o.paceMs); };

async function addThreadLinks(vaultId: string, actionId: string, noteIds: string[], personId: string, o: TidyOptions, prior: ThreadLinkRecord[] = []): Promise<{ added: number; existing: number; failed: number }> {
  const vault = vaultFor(vaultId);
  const records: ThreadLinkRecord[] = prior.filter((r) => !r.failed);
  const res = { added: 0, existing: 0, failed: 0 };
  const save = () => db.prepare(`UPDATE comms_tidy_actions SET thread_links = ? WHERE id = ?`).run(JSON.stringify(records), actionId);
  for (const id of noteIds) {
    if (records.some((r) => r.noteId === id)) continue;
    await pause(o); // every note costs reads (and maybe a write): paced
    try {
      let note: Note;
      try { note = await linkRead(vault, id); } catch (e) { if (e instanceof VaultError && e.status === 404) continue; throw e; } // gone: nothing to link
      if (!(note.tags ?? []).includes("message-thread")) continue; // only conversation notes
      if (hasEdge(note, note.id, personId)) { records.push({ noteId: note.id, added: false }); res.existing++; save(); continue; }
      for (let attempt = 0; ; attempt++) {
        try {
          await vault.updateNote(note.id, { links: { add: [{ target: personId, relationship: THREAD_RELATIONSHIP }] }, ...(note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}) });
          break;
        } catch (e) {
          if (!(e instanceof VaultConflictError) || attempt >= 1) throw e;
          note = await linkRead(vault, id); // an append landed meanwhile: once more on the new version
          if (hasEdge(note, note.id, personId)) break;
        }
      }
      const check = await linkRead(vault, id); // verify by reading it back
      if (hasEdge(check, check.id, personId)) { records.push({ noteId: check.id, added: true }); res.added++; save(); }
      else { records.push({ noteId: id, added: false, failed: true }); res.failed++; save(); }
    } catch (e) {
      records.push({ noteId: id, added: false, failed: true });
      save();
      res.failed++;
      console.warn(`[comms] tidy thread link failed: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  return res;
}

/** A resume: try again the thread notes an action could not link (records marked failed). */
export async function retryThreadLinks(vaultId: string, actionId: string, o: TidyOptions = {}): Promise<{ added: number; existing: number; failed: number } | null> {
  const row = db.prepare(`SELECT * FROM comms_tidy_actions WHERE id = ?`).get(actionId) as ActionRow | undefined;
  if (!row || row.undone_at !== null || !row.person_id || (row.kind !== "link" && row.kind !== "create")) return null;
  const prior = threadLinksOf(row);
  const failed = prior.filter((r) => r.failed).map((r) => r.noteId);
  if (!failed.length) return null;
  return addThreadLinks(vaultId, row.id, failed, row.person_id, o, prior);
}

/**
 * Undo's edge removal: every `messages-with` edge to the person on the counterpart's DM thread notes —
 * the ones this action added AND the ones ingest added since because the person held the key —
 * except an edge that was already there before the action (recorded added:false). Paced, verified.
 * Throws on a vault failure (the action stays not undone; a retry continues).
 */
async function removeThreadLinks(vault: ReturnType<typeof vaultFor>, records: ThreadLinkRecord[], personId: string, dmNotes: string[], o: TidyOptions): Promise<void> {
  const keep = new Set(records.filter((r) => !r.added && !r.failed).map((r) => r.noteId));
  const ids = [...new Set([...records.filter((r) => r.added).map((r) => r.noteId), ...dmNotes])].filter((id) => !keep.has(id));
  for (const id of ids) {
    await pause(o);
    let note: Note;
    try { note = await linkRead(vault, id); } catch (e) { if (e instanceof VaultError && e.status === 404) continue; throw e; }
    if (!(note.tags ?? []).includes("message-thread") || !hasEdge(note, note.id, personId)) continue;
    const r = { noteId: id };
    await vault.updateNote(note.id, { links: { remove: [{ target: personId, relationship: THREAD_RELATIONSHIP }] }, ...(note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}) });
    const check = await linkRead(vault, r.noteId);
    if (hasEdge(check, check.id, personId)) throw new TidyError(503, "source_unavailable");
  }
}

/** The DM thread notes whose edges an undo may remove (+ which notes are the counterpart's). */
const dmNotesOfRow = (row: ActionRow): string[] => threadNotesOf(row.thread_id, JSON.parse(row.member_ids) as string[]);

const threadLinksOf = (row: ActionRow): ThreadLinkRecord[] => {
  try { return row.thread_links ? (JSON.parse(row.thread_links) as ThreadLinkRecord[]) : []; } catch { return []; }
};

/** The single counterpart (as a list) or a refusal: the owner's own chat, or not exactly one other. */
function oneCounterpart(members: string[], owner: OwnerContext): string[] {
  const cp = counterpartOf(members, owner);
  if (cp.counterpart) return cp.counterpart;
  if (cp.owner && cp.others === 0) throw new TidyError(409, "owner_person");
  throw new TidyError(409, "not_one_counterpart");
}

/** Does exactly this person (and no dead end) hold the counterpart's strong keys right now? */
function heldOnlyBy(idx: IdentityIndex, members: string[], personId: string): boolean {
  let held = false;
  for (const k of claimKeysOf(members)) {
    if (idx.claimedBy(k).length) return false;
    for (const p of idx.claimants(k)) {
      const live = idx.canonicalOf(p);
      if (!live || live.id !== personId) return false;
      held = true;
    }
  }
  return held;
}

/** Link the DM's counterpart to an existing person. */
export async function linkThread(vaultId: string, threadId: string, personId: string, actor: TidyActor, opts: TidyOptions = {}): Promise<TidyAction> {
  const { members: all } = membersToTidy(threadId);
  return withLock(async () => {
    try {
      const idx = opts.index ? await opts.index() : await peopleIndex(vaultId, true);
      const owner = ownerContext(idx, vaultId);
      const members = oneCounterpart(all, owner);
      const keys = members.map(memberKey).filter((k): k is IdentityKey => !!k);
      if (!keys.length) throw new TidyError(422, "no_handle");
      const picked = idx.get(personId);
      const person = picked ? idx.canonicalOf(picked) : null;
      if (!person || isNonHumanPerson(person)) throw new TidyError(404, "person_unavailable");
      if (owner.personIds.has(person.id)) throw new TidyError(409, "owner_person"); // never a note that is the owner
      if (opts.requireHeld && !heldOnlyBy(idx, members, person.id)) throw new TidyError(409, "changed_since_plan");
      if (opts.requireName !== undefined && exactNameKey(personName(person)) !== exactNameKey(opts.requireName)) throw new TidyError(409, "changed_since_plan");
      const other = claimedElsewhere(idx, claimKeysOf(members), person.id);
      if (other) throw new TidyError(409, "claimed_by_another_person", { person: { id: other.id, name: personName(other) } });
      const vault = vaultFor(vaultId);
      const fresh = await vault.getNote(person.id);
      if (!fresh.updatedAt) throw new TidyError(503, "source_unavailable");
      // Each key's patch on top of the previous ones (nested `channels` is sent whole).
      const working: Note = { ...fresh, metadata: { ...(fresh.metadata ?? {}) } };
      const patch: Record<string, unknown> = {};
      for (const k of keys) {
        const r = addKeyPatch(working, k);
        if (r.skipped) throw new TidyError(409, "unexpected_shape", { field: r.skipped });
        if (!r.patch) continue;
        Object.assign(patch, r.patch);
        Object.assign(working.metadata!, r.patch);
      }
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) before[key] = fresh.metadata?.[key] ?? null;
      let updated: Note = fresh;
      if (Object.keys(patch).length) {
        updated = await vault.updateNote(fresh.id, { metadata: patch, ifUpdatedAt: fresh.updatedAt });
        opts.onPersonWrite?.(updated);
      }
      // The undo record is written right after the vault write, before anything that could fail
      // (review M10): a changed person note always has its undo.
      const row = recordAction({
        kind: "link", thread_id: threadId, member_ids: JSON.stringify(members), person_id: person.id, person_name: personName(person),
        before_json: JSON.stringify(before), after_json: JSON.stringify(patch), after_updated_at: updated.updatedAt ?? null,
        recommendation_ids: null, actor: actor.email, batch_id: opts.batchId ?? null,
      });
      const links = await addThreadLinks(vaultId, row.id, threadNotesOf(threadId, members), person.id, opts);
      afterWrite(() => {
        if (Object.keys(patch).length) afterVaultWrite(vaultId, updated);
        applyLocalLink(threadId, members, person.id);
      });
      return { ...actionOut(row), threadLinks: links };
    } catch (e) {
      throw vaultFailure(e);
    }
  });
}

/** The metadata of a person note created for this counterpart (person-creation path's shape). */
export function newPersonMetadata(name: string, keys: IdentityKey[], network: Network, source?: string | null): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  const md: Record<string, unknown> = { type: "person", name };
  if (source) md.source = source; // the schema's own field: where this entity was first captured
  for (const k of keys) {
    if (k.kind === "matrix") {
      if (!channels.matrix) channels.matrix = k.value;
      const platform = /^@([a-z]+)_/.exec(k.value)?.[1];
      if (platform && !channels[platform]) channels[platform] = k.value;
      else if (!platform && network && network !== "matrix" && !channels[network]) channels[network] = k.value;
    } else if (k.kind === "email") {
      channels.email = [...((channels.email as string[] | undefined) ?? []), k.value];
      if (!md.email) md.email = k.value;
    } else if (k.kind === "phone") {
      if (!md.phone) md.phone = `+${k.value}`;
    }
  }
  if (Object.keys(channels).length) md.channels = channels;
  return md;
}

/**
 * A new person for the DM's counterpart. Refused when a handle is already someone's, and — unless
 * `allowSimilar` — when people with that name exist (409 similar_people: link instead?). With
 * `allowSimilar`, the new note is created and each same-name person is filed as a "same person?"
 * recommendation in Prism's merge queue (never merged here).
 */
export async function createPerson(vaultId: string, threadId: string, rawName: string, actor: TidyActor, allowSimilar = false, opts: TidyOptions = {}): Promise<TidyAction> {
  const name = cleanDisplayName(rawName.normalize("NFC")).replace(/\s+/g, " ").trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(name)) throw new TidyError(422, "invalid_name");
  const refusal = creationRefusal(name);
  if (refusal) throw new TidyError(422, "invalid_name", { reason: refusal });
  const { members: all, network } = membersToTidy(threadId);
  return withLock(async () => {
    try {
      const idx = opts.index ? await opts.index() : await peopleIndex(vaultId, true);
      const owner = ownerContext(idx, vaultId);
      if (isOwnerName(owner, name)) throw new TidyError(409, "owner_person"); // never a new note for the owner
      const members = oneCounterpart(all, owner);
      const keys = members.map(memberKey).filter((k): k is IdentityKey => !!k);
      if (!keys.length) throw new TidyError(422, "no_handle");
      const other = claimedElsewhere(idx, claimKeysOf(members), null);
      if (other) throw new TidyError(409, "claimed_by_another_person", { person: { id: other.id, name: personName(other) } });
      const similar = idx.named(name).map((p) => idx.canonicalOf(p)).filter((p): p is Note => !!p && !isNonHumanPerson(p));
      const uniq = [...new Map(similar.map((p) => [p.id, p])).values()].slice(0, 5);
      if (uniq.length && !allowSimilar) {
        throw new TidyError(409, "similar_people", { people: uniq.map((p) => ({ id: p.id, name: personName(p) })) });
      }
      const metadata = newPersonMetadata(name, keys, network, opts.source);
      const problems = [...shapeViolations(metadata, "person"), ...declaredViolations(metadata, "person", shapeViolations(metadata, "person"))];
      if (problems.length) throw new TidyError(422, "invalid_shape", { fields: problems });
      const vault = vaultFor(vaultId);
      const base = `vault/people/${rustSanitizePath(name)}`;
      const content = `# ${name}\n\nAdded from Comms.`;
      let made: (Note & { existed?: boolean }) | null = null;
      for (let i = 0; i < 6 && !made; i++) {
        const path = i === 0 ? base : `${base}-${i + 1}`;
        const n = await vault.createNote({ content, path, metadata, tags: ["person"], ifExists: "ignore" });
        if (!n.existed) made = n; // a taken path is someone else's note: never adopt it
      }
      if (!made) throw new TidyError(409, "path_taken");
      opts.onPersonWrite?.(made);
      const row = recordAction({
        kind: "create", thread_id: threadId, member_ids: JSON.stringify(members), person_id: made.id, person_name: name,
        before_json: null, after_json: JSON.stringify({ metadata, content }), after_updated_at: made.updatedAt ?? null,
        recommendation_ids: null, actor: actor.email, batch_id: opts.batchId ?? null,
      });
      const links = await addThreadLinks(vaultId, row.id, threadNotesOf(threadId, members), made.id, opts);
      // "Same person?" — for the owner to decide in Prism's merge queue.
      const recs: string[] = [];
      afterWrite(() => {
        afterVaultWrite(vaultId, made);
        applyLocalLink(threadId, members, made.id);
        for (const p of uniq) {
          const r = recommendMerge({
            vaultId, a: made.id, b: p.id, canonicalId: p.id, confidence: 0.5, detected: false, capKey: `comms-tidy:${actor.email}`, credentialId: "comms-tidy",
            rationale: "Created from Comms while a person with the same name already existed. Same person?",
          });
          if (r.result === "created") recs.push(r.recommendation.id);
        }
        if (recs.length) db.prepare(`UPDATE comms_tidy_actions SET recommendation_ids = ? WHERE id = ?`).run(JSON.stringify(recs), row.id);
      });
      return { ...actionOut({ ...row, recommendation_ids: recs.length ? JSON.stringify(recs) : null }), threadLinks: links };
    } catch (e) {
      throw vaultFailure(e);
    }
  });
}

/** Never list / prompt this counterpart again (local only). */
export function ignoreThread(threadId: string, actor: TidyActor, now = Date.now(), opts: TidyOptions = {}): TidyAction {
  const { members } = membersToTidy(threadId);
  db.transaction(() => {
    for (const m of members) db.prepare(`INSERT OR REPLACE INTO comms_tidy_ignored (member_id, thread_id, at) VALUES (?, ?, ?)`).run(m, threadId, now);
  })();
  appendEvent("thread.updated", threadId, { threadId, reason: "tidy" });
  return actionOut(recordAction({
    kind: "ignore", thread_id: threadId, member_ids: JSON.stringify(members), person_id: null, person_name: null,
    before_json: null, after_json: null, after_updated_at: null, recommendation_ids: null, actor: actor.email, batch_id: opts.batchId ?? null,
  }, now));
}

/** Deep equality that ignores object key order (review M2: the vault may reorder `channels`). */
export function same(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Undo one action. Refuses (409 changed_since) rather than overwrite anything edited since. */
export async function undoAction(vaultId: string, actionId: string, o: TidyOptions = {}): Promise<TidyAction> {
  const row = db.prepare(`SELECT * FROM comms_tidy_actions WHERE id = ?`).get(actionId) as ActionRow | undefined;
  if (!row) throw new TidyError(404, "action_unavailable");
  if (row.undone_at !== null) throw new TidyError(409, "already_undone");
  const members = JSON.parse(row.member_ids) as string[];
  const done = () => {
    db.prepare(`UPDATE comms_tidy_actions SET undone_at = ? WHERE id = ?`).run(Date.now(), row.id);
    return actionOut({ ...row, undone_at: Date.now() });
  };
  if (row.kind === "ignore") {
    db.transaction(() => { for (const m of members) db.prepare(`DELETE FROM comms_tidy_ignored WHERE member_id = ?`).run(m); })();
    appendEvent("thread.updated", row.thread_id, { threadId: row.thread_id, reason: "tidy" });
    return done();
  }
  if (row.kind === "recommend") {
    // A review-queue question a batch filed: withdrawn only while still open and only if THIS action
    // created it (a refreshed existing row was there before; an answered one is the owner's decision).
    const filed = JSON.parse(row.after_json ?? "{}") as { candidateId?: string; created?: boolean };
    if (filed.candidateId && filed.created) {
      const open = db.prepare(`SELECT status FROM identity_candidates WHERE id = ?`).get(filed.candidateId) as { status: string } | undefined;
      if (open && open.status !== "open") throw new TidyError(409, "changed_since");
      if (open) db.prepare(`DELETE FROM identity_candidates WHERE id = ? AND status = 'open'`).run(filed.candidateId);
    }
    return done();
  }
  return withLock(async () => {
    try {
      const vault = vaultFor(vaultId);
      if (row.kind === "link") {
        const after = JSON.parse(row.after_json ?? "{}") as Record<string, unknown>;
        const before = JSON.parse(row.before_json ?? "{}") as Record<string, unknown>;
        const unchanged = (n: Note) => !!n.updatedAt && !Object.keys(after).some((k) => !same(n.metadata?.[k], after[k]));
        if (Object.keys(after).length && !unchanged(await vault.getNote(row.person_id!))) throw new TidyError(409, "changed_since");
        // The thread notes' edges first (the action's and ingest's since — never one that predates it),
        // then the person's fields.
        await removeThreadLinks(vault, threadLinksOf(row), row.person_id!, dmNotesOfRow(row), o);
        if (Object.keys(after).length) {
          const cur = await vault.getNote(row.person_id!);
          // Restore only while each field still holds exactly what the link wrote.
          if (!unchanged(cur)) throw new TidyError(409, "changed_since");
          const restore: Record<string, unknown> = {};
          for (const k of Object.keys(after)) restore[k] = before[k] ?? null;
          // Nested objects are merge-patched: a key the link ADDED inside `channels` must be nulled.
          for (const [k, v] of Object.entries(restore)) {
            const a = after[k];
            if (v && typeof v === "object" && !Array.isArray(v) && a && typeof a === "object" && !Array.isArray(a)) {
              const o = { ...(v as Record<string, unknown>) };
              for (const inner of Object.keys(a as Record<string, unknown>)) if (!(inner in o)) o[inner] = null;
              restore[k] = o;
            }
          }
          const updated = await vault.updateNote(cur.id, { metadata: restore, ifUpdatedAt: cur.updatedAt! });
          afterVaultWrite(vaultId, updated);
        }
      } else {
        // Undo of a create (review I6): the note goes to Prism's Trash (restorable), never a hard
        // delete, and only while it is EXACTLY what was created — same body, tags and metadata, and no
        // link to or from it other than `messages-with` from the counterpart's own DM thread notes
        // (written by this action or by ingest since; those are removed first). Anything else = the
        // person is in use: refused (changed_since) and reported. The trash write is compare-and-set
        // on the version just re-read, so an edit landing in between makes the vault refuse it (409).
        let cur: Note | null = null;
        try { cur = await vault.getNote(row.person_id!, { includeLinks: true }); } catch (e) { if (!(e instanceof VaultError && e.status === 404)) throw e; }
        if (cur) {
          const made = JSON.parse(row.after_json ?? "{}") as { metadata?: Record<string, unknown>; content?: string };
          const dmNotes = dmNotesOfRow(row);
          const ours = new Set([...threadLinksOf(row).filter((r) => r.added).map((r) => r.noteId), ...dmNotes]);
          const pristine = (n: Note, allowOurs: boolean) => {
            const linked = (n.links ?? []).some((l) => (l.sourceId === n.id || l.targetId === n.id)
              && !(allowOurs && l.targetId === n.id && l.relationship === THREAD_RELATIONSHIP && ours.has(l.sourceId)));
            return !!n.updatedAt && !linked && same([...(n.tags ?? [])].sort(), ["person"])
              && (made.content === undefined || (n.content ?? "").trim() === made.content.trim())
              && (made.metadata === undefined || same(n.metadata ?? {}, made.metadata));
          };
          // Only the edges THIS action gave its thread notes may point at it; anything else = in use.
          if (!pristine(cur, true)) throw new TidyError(409, "changed_since");
          await removeThreadLinks(vault, threadLinksOf(row), cur.id, dmNotes, o);
          const again = await vault.getNote(cur.id, { includeLinks: true });
          if (!pristine(again, false)) throw new TidyError(409, "changed_since");
          cur = again;
          const at = new Date().toISOString();
          const trashed = await vault.updateNote(cur.id, {
            metadata: { [TRASH_META.at]: at, [TRASH_META.by]: row.actor, [TRASH_META.root]: cur.id, [TRASH_META.path]: cur.path ?? null },
            tags: { add: [TRASH_TAG] },
            ifUpdatedAt: cur.updatedAt!,
          });
          recordTrashedNote(vaultId, cur.id, at, row.actor);
          afterWrite(() => afterVaultWrite(vaultId, trashed));
        }
        for (const id of row.recommendation_ids ? (JSON.parse(row.recommendation_ids) as string[]) : []) dismissRecommendation(vaultId, id, "comms-tidy-undo");
      }
      applyLocalLink(row.thread_id, members, null);
      return done();
    } catch (e) {
      throw vaultFailure(e);
    }
  });
}

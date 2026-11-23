// Batch contact tidy (scripts/comms-batch-tidy.ts): "People to Tidy" holds thousands of unlinked DM
// counterparts — too many to go through one by one. A batch sorts them into tiers and acts on the
// safe ones with THE SAME code the single-thread routes use (comms/tidy.ts linkThread /
// createPerson / ignoreThread: same writes, same compare-and-set, same shape rules, same
// comms_tidy_actions rows — each carrying the batch id), and files the unsure ones as questions in
// Prism's existing people review queue (identity_candidates, the reconcile convention for
// AMBIGUOUS). Persons are NEVER merged here.
//
//   A  a strong key (E.164 phone, exact email, the bridge / Matrix id) the counterpart carries is
//      held by exactly ONE live human person, and nothing else claims it   → link to that person
//   B  no person holds any key or the name, the owner talks with them often (≥ minTotal messages
//      with ≥ minOwner from the owner, or a DM with ≥ dmMinOwner from the owner) and the display
//      name is a real name (not a number / handle / email / bot / short code)  → create + link
//   C  a key held by SEVERAL people (or by a person and a dead end), or no key match but the same
//      name as existing people                                → a link question in the review queue
//   D  everything else (one-offs, short codes, bots, unnamed numbers) → left in People to Tidy, or
//      ignored with --ignore-low (local only, undoable)
//
// Flow: buildPlan (read-only) → the plan file → applyPlan (refuses a stale plan: every entry not yet
// done must still be decided the same way) → undoBatch. Idempotent and resumable: an entry with an
// action row of this batch is never redone.
import { createHash } from "node:crypto";
import { db } from "../db";
import { vaultClient, type Note } from "../parachute";
import { IdentityIndex, isNonHumanPerson, isGenericName, nameTokens, type IdentityKey } from "../identity";
import { peopleListing } from "../people-review-service";
import { creationRefusal, cleanDisplayName, isNonhumanEmail, normalizeName } from "../worker/people";
import { isLowMessage, mailboxes, type StoredMeta } from "./email";
import { candidateStatus, enqueueCandidate, vaultIdentity, keyHash } from "../identity-store";
import {
  claimKeysOf, counterpartOf, createPerson, isOwnerName, looseEmail, loosePhone, ownerContext, retryThreadLinks, threadNotesOf, type OwnerContext, ignoreThread, linkThread, memberHandle, memberKey, recordAction, tidyCandidates, undoAction,
  TidyError, type TidyActor, type TidyItem,
} from "./tidy";
import { BUSINESS_WORDS, exactNameKey, personName, straightQuotes, stripDecorations } from "../person-name";
import type { Network } from "./types";

export type Tier = "A" | "B" | "C" | "D";
export const TIERS: readonly Tier[] = ["A", "B", "C", "D"];

export interface BatchOptions {
  /** B: at least this many messages in all … */
  minTotal: number;
  /** … with at least this many from the owner; */
  minOwner: number;
  /** or, in a DM, at least this many from the owner. */
  dmMinOwner: number;
  /** D: mark the low tier ignored (local only). Off by default. */
  ignoreLow: boolean;
  /** Owner-approved: a C `name-only` entry whose display name EQUALS its single candidate's name
   *  (exactNameKey, ≥ 2 name tokens) is linked like A (reason `exact-name`). Off by default. */
  promoteExactNames?: boolean;
  /** Owner-approved exclusions: display names (exactNameKey) never created or promoted (→ D). */
  excludeNames?: string[];
  /** Networks left out entirely (→ D `skipped-network`). */
  skipNetworks?: string[];
  /** Email may be promoted / created from (off by default: an email sender is often a platform). */
  allowEmail?: boolean;
}
export const DEFAULT_BATCH_OPTIONS: BatchOptions = { minTotal: 10, minOwner: 3, dmMinOwner: 3, ignoreLow: false };

/** The review-queue origin a batch files under (owner-visible in Prism's people review). */
export const BATCH_ORIGIN = "backfill:comms-tidy";
export const BATCH_SOURCE = "comms-tidy";
const RELATIONSHIP = "messages-with";

export interface MessageStats { total: number; owner: number }

export interface PlanEntry {
  threadId: string;
  network: Network;
  /** The counterpart's display name (the conversation title). */
  displayName: string;
  tier: Tier;
  reason: string;
  members: string[];
  stats: MessageStats;
  /** A: the person to link. */
  personId?: string;
  personName?: string;
  /** B: the name the new person gets. */
  name?: string;
  /** C: the people the question offers, the key it is about, and the thread note it hangs on. */
  candidateIds?: string[];
  candidateNames?: string[];
  key?: { kind: string; value: string };
  sourceNoteId?: string;
  /** A / B: the message-thread notes that get a `messages-with` edge to the person (forecast only). */
  threadNotes?: string[];
}

/** What A + B would do to the thread notes' person links (link health's thread.person), per platform. */
export interface LinkForecast {
  /** false = the thread-note listing failed: nothing below is known. */
  known: boolean;
  threadNotes: number;
  withPersonNow: number;
  withPersonAfter: number;
  byPlatform: Record<string, { notes: number; withPersonNow: number; gain: number }>;
}

export interface Plan {
  version: 1;
  batchId: string;
  createdAt: string;
  vaultId: string;
  options: BatchOptions;
  entries: PlanEntry[];
  /** sha256 over vaultId + options + every entry's decision (not its message counts). */
  hash: string;
  forecast?: LinkForecast;
  /** Planned with --allow-no-owner-person: the apply's freshness plan needs the same (re-review N7). */
  allowNoOwnerPerson?: boolean;
}

// ── message volume ────────────────────────────────────────────────────────────

/** Messages in a thread and how many the owner sent: the search index (live + vault history), or the
 *  projected messages when they know more (search off, history still indexing). */
export function messageStats(threads: Array<{ threadId: string; vaultNoteId: string | null }>): Map<string, MessageStats> {
  const byNote = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(from_self), 0) AS s FROM comms_search_rows WHERE thread_note_id = ?`);
  const byThread = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(from_self), 0) AS s FROM comms_search_rows WHERE thread_note_id IS NULL AND thread_id = ?`);
  const projected = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN json_extract(json, '$.sender.isSelf') THEN 1 ELSE 0 END), 0) AS s
    FROM comms_messages WHERE thread_id = ?`);
  const out = new Map<string, MessageStats>();
  for (const t of threads) {
    const a = t.vaultNoteId ? (byNote.get(t.vaultNoteId) as { n: number; s: number }) : { n: 0, s: 0 };
    const b = byThread.get(t.threadId) as { n: number; s: number };
    const indexed = { total: a.n + b.n, owner: a.s + b.s };
    const p = projected.get(t.threadId) as { n: number; s: number };
    out.set(t.threadId, p.n > indexed.total ? { total: p.n, owner: p.s } : indexed);
  }
  return out;
}

export function isFrequent(s: MessageStats, isDm: boolean, o: BatchOptions): boolean {
  return (s.total >= o.minTotal && s.owner >= o.minOwner) || (isDm && s.owner >= o.dmMinOwner);
}

// ── who is a person at all ───────────────────────────────────────────────────

const BOT_NAME = /(^|[\s_.-])(bot|robot|noreply|no-reply|donotreply|notifications?|alerts?|verify|verification|otp|security code|support|customer service|helpdesk)([\s_.-]|$)|bot$/i;
const PLACEHOLDER = /^(unknown|whatsapp user|signal user|telegram user|deleted account|no name|unnamed|me|myself|null|undefined|~)$/i;

/** Why this counterpart is not someone to make a person of, or null: short codes, bots, role
 *  addresses (any tier — never linked or created by a batch). */
export function botOrShortCode(members: string[], name: string): string | null {
  for (const m of members) {
    const id = m.trim().toLowerCase();
    const h = memberHandle(id);
    if (h?.kind === "phone") {
      const digits = h.value.replace(/\D/g, "");
      if (digits.length > 0 && digits.length <= 6) return "short-code";
    }
    if (id.startsWith("tel:") && id.replace(/\D/g, "").length <= 6) return "short-code";
    if (id.startsWith("mailto:") && isNonhumanEmail(id.slice(7))) return "bot";
    if (h?.kind === "username" && /bot$/i.test(h.value)) return "bot";
    if (/^@[a-z0-9]*bot:/.test(id) || /^@[a-z]+_[a-z0-9_]*bot:/.test(id)) return "bot";
  }
  if (BOT_NAME.test(name.trim())) return "bot";
  return null;
}

/** A display name good enough to name a new person, or null with the reason it is not. */
export function realName(raw: string): { name: string } | { reason: string } {
  const name = stripDecorations(straightQuotes(cleanDisplayName(String(raw ?? "").normalize("NFC")))).replace(/\s+/g, " ").trim();
  if (!name || !/\p{L}/u.test(name)) return { reason: "no-name" };
  if (PLACEHOLDER.test(name) || isGenericName(name)) return { reason: "no-name" };
  if (name.startsWith("+") || name.startsWith("@") || name.startsWith("~")) return { reason: "handle-not-name" };
  if (!/\s/.test(name) && (/[_\d]/.test(name) || /^[a-z0-9.]+$/.test(name))) return { reason: "handle-not-name" }; // "john_doe92", "jdoe"
  if (/^https?:|www\./i.test(name)) return { reason: "handle-not-name" };
  if (name.length > 120 || /[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(name)) return { reason: "no-name" };
  if (isNonhumanEmail(name) || BOT_NAME.test(name)) return { reason: "bot" };
  const refusal = creationRefusal(name);
  if (refusal) return { reason: refusal.includes("phone") ? "number-not-name" : refusal.includes("email") ? "handle-not-name" : "no-name" };
  return { name };
}

// ── email senders ────────────────────────────────────────────────────────────

/** Platforms / services whose mail is sent on someone's behalf or to a list: never a person's address. */
const PLATFORM_DOMAINS = /(^|\.)(hylo\.com|github\.com|gitlab\.com|linkedin\.com|facebookmail\.com|facebook\.com|slack\.com|notion\.so|substack\.com|mailchimp(app)?\.com|mcsv\.net|sendgrid\.net|google\.com|googlegroups\.com|discord\.com|medium\.com|meetup\.com|eventbrite\.com|lu\.ma|luma-mail\.com|zoom\.us|calendly\.com|docusign\.net|intercom(-mail)?\.(io|com)|hubspot(email)?\.(com|net)|mailgun\.org|amazonses\.com|twitter\.com|x\.com|airtable\.com|figma\.com|canva\.com|dropbox\.com|typeform\.com|zapier\.com|telegram\.org|whatsapp\.com|paypal\.com|stripe\.com|apple\.com|microsoft\.com|asana\.com|trello\.com|atlassian\.net|clickup\.com|loom\.com|circle\.so|mightynetworks\.com|discourse\.org|groups\.io|lists?\.[a-z0-9.-]+)$/i;
const ROLE_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer|bounces?|news(letter)?s?|digest|updates?|info|hello|team|support|marketing|automated|bot|robot|admin|community|events?|invites?|calendar|members?|list|announce(ments)?|feedback|billing|receipts?)([._+-]|$)/i;
const MAIL_SUBDOMAIN = /^(mail|email|e|em|news|newsletter|info|mkt|marketing|send|bounce|reply|notify|notifications)\./i;

/**
 * Is this the address of ONE person's own mailbox? No role / no-reply local part, no platform or
 * mailing domain, no "X (via Y)" sender name, no bulk / automated / list labels on the thread's mail.
 * Only such an address may be written onto a person (A); otherwise the address would match every
 * notification that platform sends (re-review: "Clare Brodeur (via Hylo)").
 */
export function personalMailbox(addr: string, names: string[], labels: string[][]): boolean {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return false;
  const local = a.slice(0, at), domain = a.slice(at + 1);
  if (isNonhumanEmail(a) || ROLE_LOCAL.test(local) || PLATFORM_DOMAINS.test(domain) || MAIL_SUBDOMAIN.test(domain)) return false;
  if (names.some((n) => /\bvia\b/i.test(n) || /\b(team|community|newsletter|digest|updates|notifications?)\b/i.test(n))) return false;
  if (labels.some((l) => isLowMessage(l) || l.some((x) => /^(LIST|LIST-ID|MAILING-LIST|NEWSLETTER|BULK|AUTOMATED)$/i.test(x)))) return false;
  return true;
}

/** The sender names and labels of a thread's inbound email (comms_email_messages; bounded). */
function emailEvidence(threadId: string): { names: string[]; labels: string[][] } {
  const rows = db.prepare(`SELECT em.meta_json AS j FROM comms_email_messages em JOIN comms_thread_members m ON m.conversation_id = em.conversation_id
    WHERE m.thread_id = ? AND em.is_self = 0 ORDER BY em.sent_at DESC LIMIT 50`).all(threadId) as { j: string }[];
  const names: string[] = [];
  const labels: string[][] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(r.j) as StoredMeta;
      for (const b of mailboxes(m.from)) if (b.name) names.push(b.name);
      // The raw header too: an address parser drops "(via Hylo)" as a comment.
      if (typeof m.from === "string") names.push(m.from.replace(/<[^>]*>/g, " ").trim());
      labels.push(Array.isArray(m.labels) ? m.labels : []);
    } catch { /* an unreadable row says nothing */ }
  }
  return { names, labels };
}

// ── classification ───────────────────────────────────────────────────────────

export interface Candidate { item: TidyItem; members: string[]; vaultNoteId: string | null }

/** Who holds the counterpart's strong keys: the live humans, whether a dead end / non-human claims too,
 *  and the key the holders were found by. */
function strongHolders(idx: IdentityIndex, members: string[]): { live: Map<string, Note>; blocked: boolean; key: IdentityKey | null } {
  const live = new Map<string, Note>();
  let blocked = false;
  let key: IdentityKey | null = null;
  for (const k of claimKeysOf(members)) {
    const raw = idx.claimants(k);
    for (const p of raw) {
      const person = idx.canonicalOf(p);
      if (!person || isNonHumanPerson(person)) { blocked = true; continue; }
      live.set(person.id, person);
    }
    if (idx.claimedBy(k).length) blocked = true;
    if (!key && (raw.length || idx.claimedBy(k).length)) key = k;
  }
  return { live, blocked, key };
}

const humans = (idx: IdentityIndex, notes: Note[]): Note[] =>
  [...new Map(notes.map((p) => idx.canonicalOf(p)).filter((p): p is Note => !!p && !isNonHumanPerson(p)).map((p) => [p.id, p])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));

const NICKNAME = /\b(mom|mum|mama|mommy|dad|daddy|papa|mother|father|grandma|grandpa|granny|nana|babe|baby|bae|honey|hubby|wifey|wife|husband|bro|sis|aunt|auntie|aunty|uncle|cousin|landlord|boss|doctor|doc|dr|work|home|cell|mobile|old|new|my)\b/i;

/** Tier B's bar: a real human's FULL name (≥ 2 name tokens), no business / nickname words. */
export function fullPersonName(raw: string): { ok: true } | { ok: false; reason: string } {
  const name = straightQuotes(raw);
  if (BUSINESS_WORDS.test(name)) return { ok: false, reason: "business-name" };
  if (NICKNAME.test(name)) return { ok: false, reason: "nickname" };
  const toks = nameTokens(name);
  if (toks.length < 2) return { ok: false, reason: "single-token-name" };
  if (toks.some((t) => Array.from(t).length < 2)) return { ok: false, reason: "initial-only" }; // "Ana S", "Ben O."
  if (toks.some((t) => /\d/.test(t))) return { ok: false, reason: "not-a-name" }; // "Razvan ZER8"
  return { ok: true };
}

/** The name tokens a person answers to (own names + aliases), for the A-tier name check. */
function personTokens(idx: IdentityIndex, p: Note): Set<string> {
  const k = idx.keysFor(p.id);
  const out = new Set<string>();
  for (const slug of [...k.names, ...k.aliases]) for (const t of slug.split("-")) if (/\p{L}/u.test(t)) out.add(t);
  for (const t of nameTokens(personName(p))) out.add(t);
  return out;
}

/** The plan's decisions, in a fixed order (input order = People to Tidy's ranking). Pure over its inputs. */
export function classify(cands: Candidate[], idx: IdentityIndex, stats: Map<string, MessageStats>, o: BatchOptions, owner: OwnerContext): PlanEntry[] {
  const plannedKeys = new Set<string>(); // keys a planned B create will claim
  const plannedNames = new Set<string>(); // names a planned B create will hold
  const keyId = (k: IdentityKey) => `${k.kind}\u0000${k.value}`;
  const notOwner = (p: Note) => !owner.personIds.has(p.id);
  const excluded = new Set((o.excludeNames ?? []).map(exactNameKey).filter(Boolean));
  const skipped = new Set((o.skipNetworks ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
  // Possible duplicates by a looser spelling of a key (re-review N5): Gmail dots / +tags, a person
  // note's phone written without "+". Evidence for a QUESTION only, never for a link.
  let loose: Map<string, Note[]> | null = null;
  const looseHolders = (members: string[]): Note[] => {
    if (!loose) {
      loose = new Map();
      const put = (k: string, p: Note) => { const l = loose!.get(k) ?? []; if (!l.some((x) => x.id === p.id)) l.push(p); loose!.set(k, l); };
      for (const p of idx.live()) {
        if (isNonHumanPerson(p) || !notOwner(p)) continue;
        for (const k of idx.keysFor(p.id).strong) if (k.kind === "email") put(`e:${looseEmail(k.value)}`, p);
        const md = (p.metadata ?? {}) as Record<string, unknown>;
        const ch = (md.channels && typeof md.channels === "object" ? md.channels : {}) as Record<string, unknown>;
        for (const v of [md.phone, ch.phone, md.phones].flat()) if (typeof v === "string") { const d = loosePhone(v); if (d) put(`p:${d}`, p); }
      }
    }
    const out = new Map<string, Note>();
    for (const m of members) {
      const id = m.trim().toLowerCase();
      if (id.startsWith("mailto:")) for (const p of loose.get(`e:${looseEmail(id.slice(7))}`) ?? []) out.set(p.id, p);
      for (const k of claimKeysOf([id])) if (k.kind === "phone") for (const p of loose.get(`p:${k.value}`) ?? []) out.set(p.id, p);
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  let tokenIndex: Map<string, Note[]> | null = null;
  const byToken = (t: string): Note[] => {
    if (!tokenIndex) {
      tokenIndex = new Map();
      for (const p of idx.live()) {
        if (isNonHumanPerson(p) || !notOwner(p)) continue;
        for (const slug of idx.keysFor(p.id).names) for (const tok of slug.split("-")) {
          if (!/\p{L}/u.test(tok)) continue;
          const list = tokenIndex.get(tok) ?? [];
          if (!list.some((x) => x.id === p.id)) list.push(p);
          tokenIndex.set(tok, list);
        }
      }
    }
    return tokenIndex.get(t) ?? [];
  };
  const out: PlanEntry[] = [];
  for (const c of cands) {
    const s = stats.get(c.item.threadId) ?? { total: 0, owner: 0 };
    const base0 = { threadId: c.item.threadId, network: c.item.network, displayName: c.item.name, members: c.members, stats: s };
    const d0 = (reason: string): PlanEntry => ({ ...base0, tier: "D", reason });
    // Exactly one counterpart, never the owner (review C1/C2).
    if (skipped.has(String(c.item.network).toLowerCase())) { out.push(d0("skipped-network")); continue; }
    // A chat titled with the owner's own name / alias is the owner (re-review N2).
    if (isOwnerName(owner, c.item.name)) { out.push(d0("owner")); continue; }
    const cp = counterpartOf(c.members, owner);
    if (!cp.counterpart) { out.push(d0(cp.owner && cp.others === 0 ? "owner" : "not-one-counterpart")); continue; }
    const one = cp.counterpart;
    const base = { ...base0, members: one };
    const d = (reason: string): PlanEntry => ({ ...base, tier: "D", reason });
    const keys = one.map(memberKey).filter((k): k is IdentityKey => !!k);
    const bot = botOrShortCode(one, c.item.name);
    if (bot) { out.push(d(bot)); continue; }
    // Email: an address is written onto a person only when it is a personal mailbox; and email is never
    // promoted / created from unless allowEmail.
    const isEmail = c.item.network === "email" || one.some((m) => m.toLowerCase().startsWith("mailto:"));
    let emailOk = true;
    if (isEmail) {
      const ev = c.item.network === "email" ? emailEvidence(c.item.threadId) : { names: [], labels: [] };
      const addrs = one.filter((m) => m.toLowerCase().startsWith("mailto:")).map((m) => m.slice(7));
      if (addrs.some((a) => !personalMailbox(a, [c.item.name, ...ev.names], ev.labels))) { out.push(d("email-not-personal")); continue; }
      emailOk = !!o.allowEmail || c.item.network !== "email";
    }
    if (!keys.length) { out.push(d("no-handle")); continue; }
    const allKeys = claimKeysOf(one);
    if (allKeys.some((k) => plannedKeys.has(keyId(k)))) { out.push(d("shares-handle-with-planned-create")); continue; }
    // A question needs a conversation note to hang on, and an email note is not one (review M2).
    const canAsk = !!c.vaultNoteId && c.item.network !== "email";
    const ask = (reason: string, people: Note[], key: IdentityKey): PlanEntry => canAsk
      ? { ...base, tier: "C", reason, candidateIds: people.map((p) => p.id), candidateNames: people.map(personName), key, sourceNoteId: c.vaultNoteId! }
      : d(`${reason}-no-thread-note`);

    const held = strongHolders(idx, one);
    if ([...held.live.values()].some((p) => !notOwner(p))) { out.push(d("owner")); continue; }
    if (held.live.size === 1 && !held.blocked) {
      const p = [...held.live.values()][0]!;
      // A real full name that shares nothing with the person's names: a shared / recycled number (review I2).
      const nm = realName(c.item.name);
      // The GIVEN name must be one the person answers to: a shared surname alone is a family line.
      if ("name" in nm && nameTokens(nm.name).length >= 2) {
        const mine = personTokens(idx, p);
        if (!mine.has(nameTokens(nm.name)[0]!)) { out.push(ask("name-key-mismatch", [p], held.key ?? keys[0]!)); continue; }
      }
      out.push({ ...base, tier: "A", reason: "strong-key", personId: p.id, personName: personName(p), threadNotes: threadNotesOf(c.item.threadId, one) });
      continue;
    }
    if (held.live.size >= 1) {
      // Several people (or a person and a dead end) hold the key: never A — the owner decides.
      out.push(ask("ambiguous-key", [...held.live.values()].sort((a, b) => a.id.localeCompare(b.id)), held.key ?? keys[0]!));
      continue;
    }
    if (held.blocked) { out.push(d("claimed-by-non-person")); continue; }
    const near = looseHolders(one);
    if (near.length) { out.push(ask("loose-key", near, keys[0]!)); continue; }

    const nm = realName(c.item.name);
    if (!("name" in nm)) { out.push(d(nm.reason)); continue; }
    if (excluded.has(exactNameKey(nm.name))) { out.push(d("excluded-by-owner")); continue; }
    const named = humans(idx, idx.named(nm.name)).filter(notOwner);
    // Owner-approved promotion: exactly one person, whose name IS this full name → link (no key held by anyone).
    if (o.promoteExactNames && emailOk && named.length === 1 && nameTokens(nm.name).length >= 2 && exactNameKey(personName(named[0]!)) === exactNameKey(nm.name)) {
      const p = named[0]!;
      out.push({ ...base, tier: "A", reason: "exact-name", personId: p.id, personName: personName(p), threadNotes: threadNotesOf(c.item.threadId, one) });
      continue;
    }
    if (named.length) { out.push(ask(named.length > 1 ? "ambiguous-name" : "name-only", named, keys[0]!)); continue; }
    const full = fullPersonName(nm.name);
    if (!full.ok) {
      // A first name only: a question when it is a token of existing people, else left (reconcile §4).
      const toks = nameTokens(nm.name);
      const maybe = full.reason === "single-token-name" && toks.length === 1 ? humans(idx, byToken(toks[0]!)).filter(notOwner).slice(0, 10) : [];
      out.push(maybe.length ? ask("single-token-name", maybe, keys[0]!) : d(full.reason));
      continue;
    }
    if (!emailOk) { out.push(d("email-not-creatable")); continue; }
    if (!isFrequent(s, true, o)) { out.push(d("infrequent")); continue; }
    const norm = normalizeName(nm.name);
    if (plannedNames.has(norm)) { out.push(d("same-name-as-planned-create")); continue; }
    plannedNames.add(norm);
    for (const k of allKeys) plannedKeys.add(keyId(k));
    out.push({ ...base, tier: "B", reason: "frequent-new", name: nm.name, threadNotes: threadNotesOf(c.item.threadId, one) });
  }
  return out;
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** What must not change between the dry run and the apply (message counts may). */
export function decisionOf(e: PlanEntry): string {
  return JSON.stringify([e.threadId, e.tier, e.reason, [...e.members].sort(), e.personId ?? null, e.name ?? null,
    e.candidateIds ?? null, e.key ?? null, e.sourceNoteId ?? null]);
}

export function planHash(p: Pick<Plan, "vaultId" | "options" | "entries">): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([p.vaultId, p.options.minTotal, p.options.minOwner, p.options.dmMinOwner, p.options.ignoreLow]));
  // Added options join the hash only when set (plans made before them keep their hash).
  if (p.options.promoteExactNames) h.update("\npromote-exact-names");
  const ex = [...new Set((p.options.excludeNames ?? []).map(exactNameKey))].sort();
  if (ex.length) h.update(`\nexclude:${JSON.stringify(ex)}`);
  const skip = [...new Set((p.options.skipNetworks ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))].sort();
  if (skip.length) h.update(`\nskip:${JSON.stringify(skip)}`);
  if (p.options.allowEmail) h.update("\nallow-email");
  for (const e of p.entries) h.update(`\n${decisionOf(e)}`);
  return h.digest("hex");
}

export interface PlanSources {
  /** The vault's person notes (default: the people listing, fresh). */
  people?: (vaultId: string) => Promise<Note[]>;
  /** The message-thread notes with their links (lean; default: one vault listing). null = skip the forecast. */
  threadNotes?: ((vaultId: string) => Promise<Note[]>) | null;
  now?: number;
  /** Plan even when the owner's person note cannot be told apart (it then cannot be excluded by id). */
  allowNoOwnerPerson?: boolean;
}

export class NoOwnerPersonError extends Error {
  constructor() { super("the owner's person note cannot be told apart (configure it: PUT /api/admin/people/owner), so it cannot be excluded"); }
}

/** Read-only: decide every unlinked DM counterpart. Writes nothing anywhere. */
export async function buildPlan(vaultId: string, options: BatchOptions, src: PlanSources = {}): Promise<Plan> {
  const now = src.now ?? Date.now();
  const cands = tidyCandidates(now);
  const notes = await (src.people ?? ((v: string) => peopleListing(v, true)))(vaultId);
  const idx = new IdentityIndex(notes.filter((n) => (n.tags ?? []).includes("person")));
  const owner = ownerContext(idx, vaultId);
  if (!owner.personId && !src.allowNoOwnerPerson) throw new NoOwnerPersonError();
  const stats = messageStats(cands.map((c) => ({ threadId: c.item.threadId, vaultNoteId: c.vaultNoteId })));
  const entries = classify(cands, idx, stats, options, owner);
  const body = { vaultId, options, entries };
  const hash = planHash(body);
  const plan: Plan = { version: 1, batchId: `tb_${hash.slice(0, 16)}`, createdAt: new Date(now).toISOString(), ...body, hash, ...(src.allowNoOwnerPerson ? { allowNoOwnerPerson: true } : {}) };
  if (src.threadNotes !== null) {
    const list = src.threadNotes ?? ((v: string) => vaultClient(v, { timeoutMs: 120_000 }).listNotes({ tags: ["message-thread"], includeContent: false, includeLinks: true, includeMetadata: ["platform"] }));
    let threads: Note[] | null = null;
    try { threads = await list(vaultId); } catch { threads = null; }
    plan.forecast = forecastLinks(entries, threads, new Set(notes.filter((n) => (n.tags ?? []).includes("person")).map((n) => n.id)));
  }
  return plan;
}

/** Thread notes with a person edge now, and after A + B add theirs (read-only arithmetic). */
export function forecastLinks(entries: PlanEntry[], threads: Note[] | null, personIds: Set<string>): LinkForecast {
  const f: LinkForecast = { known: !!threads, threadNotes: 0, withPersonNow: 0, withPersonAfter: 0, byPlatform: {} };
  if (!threads) return f;
  const gaining = new Set(entries.filter((e) => e.tier === "A" || e.tier === "B").flatMap((e) => e.threadNotes ?? []));
  for (const n of threads) {
    if (!(n.tags ?? []).includes("message-thread")) continue;
    const platform = typeof n.metadata?.platform === "string" && n.metadata.platform ? n.metadata.platform.toLowerCase() : "unknown";
    const p = (f.byPlatform[platform] ??= { notes: 0, withPersonNow: 0, gain: 0 });
    // Link health counts ANY link between the thread and a person, in either direction.
    const now = (n.links ?? []).some((l) => (l.sourceId === n.id && personIds.has(l.targetId)) || (l.targetId === n.id && personIds.has(l.sourceId)));
    f.threadNotes++; p.notes++;
    if (now) { f.withPersonNow++; p.withPersonNow++; }
    if (now || gaining.has(n.id)) f.withPersonAfter++;
    if (!now && gaining.has(n.id)) p.gain++;
  }
  return f;
}

/** Is a parsed file a plan this build can run, untouched since it was written? */
export function checkPlanIntegrity(p: unknown): Plan {
  const plan = p as Plan;
  if (!plan || plan.version !== 1 || !Array.isArray(plan.entries) || typeof plan.hash !== "string" || typeof plan.vaultId !== "string") throw new Error("not a batch tidy plan");
  if (planHash(plan) !== plan.hash || plan.batchId !== `tb_${plan.hash.slice(0, 16)}`) throw new Error("the plan file was changed after it was written (hash mismatch)");
  return plan;
}

export interface Summary {
  total: number;
  tiers: Record<Tier, number>;
  byNetwork: Record<string, Record<Tier, number>>;
  reasons: Record<Tier, Record<string, number>>;
  samples: Record<Tier, string[]>;
}

const arrow = (e: PlanEntry): string => {
  if (e.tier === "A") return `${e.displayName} → ${e.personName}`;
  if (e.tier === "B") return `${e.displayName} → (new) ${e.name}`;
  if (e.tier === "C") return `${e.displayName} → ? ${(e.candidateNames ?? []).join(" | ")} (${e.reason})`;
  return `${e.displayName} → — (${e.reason})`;
};

export function summarize(plan: Plan, sample = 20): Summary {
  const zero = (): Record<Tier, number> => ({ A: 0, B: 0, C: 0, D: 0 });
  const s: Summary = { total: plan.entries.length, tiers: zero(), byNetwork: {}, reasons: { A: {}, B: {}, C: {}, D: {} }, samples: { A: [], B: [], C: [], D: [] } };
  for (const e of plan.entries) {
    s.tiers[e.tier]++;
    (s.byNetwork[e.network] ??= zero())[e.tier]++;
    s.reasons[e.tier][e.reason] = (s.reasons[e.tier][e.reason] ?? 0) + 1;
    if (s.samples[e.tier].length < sample) s.samples[e.tier].push(arrow(e));
  }
  return s;
}

// ── apply ────────────────────────────────────────────────────────────────────

/** Threads this batch already has an action for (done or undone: never redone by the same plan). */
export function doneThreads(batchId: string): Set<string> {
  return new Set((db.prepare(`SELECT DISTINCT thread_id AS t FROM comms_tidy_actions WHERE batch_id = ?`).all(batchId) as { t: string }[]).map((r) => r.t));
}

/** Entries the apply acts on (D only with ignoreLow). */
export const actionable = (plan: Plan): PlanEntry[] => plan.entries.filter((e) => e.tier !== "D" || plan.options.ignoreLow);

/** The pending entries whose decision a fresh plan no longer agrees with (empty = not stale). */
export function staleEntries(plan: Plan, fresh: Plan): PlanEntry[] {
  const done = doneThreads(plan.batchId);
  const now = new Map(fresh.entries.map((e) => [e.threadId, e]));
  return actionable(plan).filter((e) => {
    if (done.has(e.threadId)) return false;
    const f = now.get(e.threadId);
    return !f || decisionOf(f) !== decisionOf(e);
  });
}

/** Threads whose action of this batch was undone (the same plan never redoes them — make a new plan). */
export function undoneThreads(batchId: string): Set<string> {
  return new Set((db.prepare(`SELECT DISTINCT thread_id AS t FROM comms_tidy_actions WHERE batch_id = ? AND undone_at IS NOT NULL`).all(batchId) as { t: string }[]).map((r) => r.t));
}

export interface ApplyOptions {
  actor: TidyActor;
  /** Pause after every vault read/write burst (rate limit). */
  paceMs: number;
  /** Stop before an entry once this many vault writes (person + thread-note edges) were made this run. */
  maxWrites?: number;
  /** How long the cached people index serves the run before it is listed again (ms). */
  indexTtlMs?: number;
  /** The people listing (tests); default: the people listing, fresh. */
  people?: (vaultId: string) => Promise<Note[]>;
  /** Stop after this many actions (resume with the same plan). */
  limit?: number;
  maxAgeMs?: number;
  /** A fresh plan to check staleness against (default: buildPlan with the plan's options). */
  fresh?: () => Promise<Plan>;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
  log?: (line: string) => void;
  /** Stop after this many vault failures in a row (the rest stays for a resume). */
  maxConsecutiveErrors?: number;
}

export interface ApplyResult {
  batchId: string;
  done: Record<"link" | "create" | "recommend" | "ignore", number>;
  /** messages-with edges written on thread notes (verified), already present, failed. */
  threadLinks: { added: number; existing: number; failed: number };
  skipped: Record<string, number>;
  alreadyDone: number;
  /** Of alreadyDone: entries this batch acted on and that were undone since (never redone by this plan). */
  undoneEarlier: number;
  /** Earlier entries whose failed thread-note edges were retried this run. */
  retried: number;
  writes: number;
  remaining: number;
  stoppedEarly: string | null;
}

export class StalePlanError extends Error {
  constructor(readonly stale: number, readonly why: "changed" | "too_old" | "vault") { super(`stale plan (${why}: ${stale})`); }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run the plan exactly: only its actionable entries, each exactly as decided. */
export async function applyPlan(plan: Plan, o: ApplyOptions): Promise<ApplyResult> {
  const now = o.now ?? Date.now();
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? realSleep;
  if (o.maxAgeMs && now - Date.parse(plan.createdAt) > o.maxAgeMs) throw new StalePlanError(0, "too_old");
  // The staleness plan never lists the thread notes (no forecast: review I6).
  const fresh = await (o.fresh ?? (() => buildPlan(plan.vaultId, plan.options, { now, threadNotes: null, allowNoOwnerPerson: plan.allowNoOwnerPerson === true, ...(o.people ? { people: o.people } : {}) })))();
  if (fresh.vaultId !== plan.vaultId) throw new StalePlanError(0, "vault");
  const stale = staleEntries(plan, fresh);
  const done = doneThreads(plan.batchId);
  // A first run refuses a plan the vault / projection no longer agrees with. A RESUME (this batch
  // already acted) expects its own earlier actions to have changed some decisions (a created person
  // now claims a name a later entry shares): those entries are skipped, never run as planned.
  if (stale.length && done.size === 0) throw new StalePlanError(stale.length, "changed");
  const staleIds = new Set(stale.map((e) => e.threadId));
  const res: ApplyResult = { batchId: plan.batchId, done: { link: 0, create: 0, recommend: 0, ignore: 0 }, threadLinks: { added: 0, existing: 0, failed: 0 }, skipped: {}, alreadyDone: 0, undoneEarlier: 0, retried: 0, writes: 0, remaining: 0, stoppedEarly: null };
  const undone = undoneThreads(plan.batchId);
  const skip = (code: string) => { res.skipped[code] = (res.skipped[code] ?? 0) + 1; };
  const todo = actionable(plan);
  const order: Record<Tier, number> = { A: 0, B: 1, C: 2, D: 3 };
  todo.sort((a, b) => order[a.tier] - order[b.tier]);
  let acted = 0, errorsInRow = 0;
  const maxErrors = o.maxConsecutiveErrors ?? 5;
  // One people index for the run (review I6): listed once, kept current with every person this run
  // writes, listed again after indexTtlMs. Each write still re-reads its target note (CAS).
  let cached: { at: number; idx: IdentityIndex } | null = null;
  const ttl = o.indexTtlMs ?? 120_000;
  const listPeople = o.people ?? ((v: string) => peopleListing(v, true));
  const index = async (): Promise<IdentityIndex> => {
    if (!cached || Date.now() - cached.at > ttl) {
      cached = { at: Date.now(), idx: new IdentityIndex((await listPeople(plan.vaultId)).filter((n) => (n.tags ?? []).includes("person"))) };
      await sleep(o.paceMs);
    }
    return cached.idx;
  };
  const opts = { batchId: plan.batchId, source: BATCH_SOURCE, paceMs: o.paceMs, sleep, index, onPersonWrite: (n: Note) => cached?.idx.add(n) };
  const countLinks = (a: { threadLinks?: { added: number; existing: number; failed: number } } | null) => {
    if (!a?.threadLinks) return;
    res.threadLinks.added += a.threadLinks.added; res.threadLinks.existing += a.threadLinks.existing; res.threadLinks.failed += a.threadLinks.failed;
    res.writes += a.threadLinks.added;
  };
  for (let i = 0; i < todo.length; i++) {
    const e = todo[i]!;
    if (done.has(e.threadId)) {
      res.alreadyDone++;
      if (undone.has(e.threadId)) { res.undoneEarlier++; continue; }
      // A resume retries the thread notes an earlier run could not link (review M5).
      if (e.tier === "A" || e.tier === "B") {
        const row = db.prepare(`SELECT id FROM comms_tidy_actions WHERE batch_id = ? AND thread_id = ? AND undone_at IS NULL AND thread_links LIKE '%"failed":true%'`).get(plan.batchId, e.threadId) as { id: string } | undefined;
        if (row) { countLinks({ threadLinks: (await retryThreadLinks(plan.vaultId, row.id, opts)) ?? undefined }); res.retried++; }
      }
      continue;
    }
    if (staleIds.has(e.threadId)) { skip("changed_since_plan"); continue; }
    const cap = o.limit !== undefined && acted >= o.limit ? "limit" : o.maxWrites !== undefined && res.writes >= o.maxWrites ? "max-writes" : null;
    if (cap) { res.remaining = todo.slice(i).filter((x) => !done.has(x.threadId)).length; res.stoppedEarly = cap; break; }
    try {
      if (e.tier === "A") {
        // Batch A re-checks that this person alone still holds the key (review M6).
        const a = await linkThread(plan.vaultId, e.threadId, e.personId!, o.actor,
          e.reason === "exact-name" ? { ...opts, requireName: e.displayName } : { ...opts, requireHeld: true });
        countLinks(a);
        res.writes++;
        res.done.link++;
        await sleep(o.paceMs);
      } else if (e.tier === "B") {
        countLinks(await createPerson(plan.vaultId, e.threadId, e.name!, o.actor, false, opts));
        res.writes++;
        res.done.create++;
        await sleep(o.paceMs);
      } else if (e.tier === "C") {
        fileQuestion(plan, e, o.actor);
        res.done.recommend++;
      } else {
        ignoreThread(e.threadId, o.actor, Date.now(), opts);
        res.done.ignore++;
      }
      acted++;
      errorsInRow = 0;
    } catch (err) {
      const code = err instanceof TidyError ? err.code : "error";
      skip(code);
      log(`skipped ${e.tier} ${e.threadId}: ${code}`);
      if (code === "source_unavailable" || code === "conflict" || code === "busy" || code === "error") errorsInRow++;
      else errorsInRow = 0;
      if (errorsInRow >= maxErrors) {
        res.remaining = todo.slice(i + 1).filter((x) => !done.has(x.threadId)).length;
        res.stoppedEarly = `${errorsInRow} failures in a row (last: ${code})`;
        break;
      }
      if (code === "source_unavailable" || code === "conflict") await sleep(o.paceMs * 2);
    }
  }
  return res;
}

/** C: one question in Prism's people review queue (no vault write), recorded so it can be withdrawn. */
function fileQuestion(plan: Plan, e: PlanEntry, actor: TidyActor): void {
  const key = e.key!;
  // A question already asked (by anyone) is left exactly as it is (review M3).
  if (candidateStatus(plan.vaultId, e.sourceNoteId!, RELATIONSHIP, key) !== null) throw new TidyError(409, "already_queued");
  const result = enqueueCandidate({
    vaultId: plan.vaultId, sourceNoteId: e.sourceNoteId!, relationship: RELATIONSHIP, key, display: e.displayName,
    candidateIds: e.candidateIds ?? [], reason: e.reason, origin: BATCH_ORIGIN,
  });
  if (result === "full") throw new TidyError(409, "queue_full");
  const row = db.prepare(`SELECT id FROM identity_candidates WHERE vault_identity = ? AND source_note_id = ? AND relationship = ? AND key_kind = ? AND key_hash = ?`)
    .get(vaultIdentity(plan.vaultId), e.sourceNoteId!, RELATIONSHIP, key.kind, keyHash(key.kind, key.value.slice(0, 320))) as { id: string } | undefined;
  recordAction({
    kind: "recommend", thread_id: e.threadId, member_ids: JSON.stringify(e.members), person_id: null, person_name: null,
    before_json: null, after_json: JSON.stringify({ candidateId: row?.id ?? null, created: result === "created", result }),
    after_updated_at: null, recommendation_ids: null, actor: actor.email, batch_id: plan.batchId,
  });
}

// ── undo ─────────────────────────────────────────────────────────────────────

export interface UndoResult { batchId: string; undone: Record<string, number>; refused: Record<string, number>; alreadyUndone: number }

/** Undo every action of a batch, newest first, through the routes' own undo (refuses what was edited since). */
export async function undoBatch(vaultId: string, batchId: string, o: { paceMs: number; sleep?: (ms: number) => Promise<void>; log?: (l: string) => void }): Promise<UndoResult> {
  const sleep = o.sleep ?? realSleep;
  const rows = db.prepare(`SELECT id, kind, undone_at FROM comms_tidy_actions WHERE batch_id = ? ORDER BY at DESC, id DESC`).all(batchId) as { id: string; kind: string; undone_at: number | null }[];
  const res: UndoResult = { batchId, undone: {}, refused: {}, alreadyUndone: 0 };
  for (const r of rows) {
    if (r.undone_at !== null) { res.alreadyUndone++; continue; }
    try {
      await undoAction(vaultId, r.id, { paceMs: o.paceMs, sleep }); // paced inside too (every thread note)
      res.undone[r.kind] = (res.undone[r.kind] ?? 0) + 1;
      if (r.kind === "link" || r.kind === "create") await sleep(o.paceMs);
    } catch (err) {
      const code = err instanceof TidyError ? err.code : "error";
      res.refused[code] = (res.refused[code] ?? 0) + 1;
      o.log?.(`not undone ${r.kind} ${r.id}: ${code}`);
    }
  }
  return res;
}

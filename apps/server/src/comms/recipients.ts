// The To: field of a new message (phase 2b, S3): GET /api/comms/recipients?q=.
//
// Answers from memory and the projection only — never a vault or BlueBubbles call per keystroke:
//   - people: a directory of the vault's person notes (lean listing: names + identity keys + photo)
//     merged with the Mac's Contacts (BlueBubbles, when the connector is active), rebuilt at most
//     every DIRECTORY_TTL_MS in the background (stale-while-revalidate; the first request waits up to
//     FIRST_LOAD_WAIT_MS, then answers `partial: true`);
//   - threads: the indexed search_text LIKE of GET /threads (any folder, any network) + the matched
//     people's own threads.
// Phones on the wire are E.164 only. A Contacts number written without a country code is offered
// only when exactly one existing iMessage/SMS conversation proves its E.164 form (nationalIndex);
// otherwise it is left out (nothing can be sent to it safely). A Contacts card joins a person note
// only on an exact address AND a matching name; otherwise it is its own entry.
import { config } from "../config";
import { resolveVaultEntry } from "../db";
import { vaultClient, type Note } from "../parachute";
import { PERSON_IDENTITY_KEYS } from "../people-metadata";
import { isNonHumanPerson, isTombstone, personKeys } from "../identity";
import { personName } from "../person-name";
import { blueBubblesClient } from "../bluebubbles/config";
import { blueBubblesBook } from "../bluebubbles/service";
import { EMPTY_BOOK, type ContactBook } from "../bluebubbles/contacts";
import type { BbContact } from "../bluebubbles/client";
import { db } from "../db";
import { listThreads, threadsOfPerson } from "./store";
import { foldSearch } from "./search-text";
import { existingThreadFor, existingThreadsByMember, parseHandle, type Handle } from "./conversations";
import type { AvatarRef, Thread } from "./types";
import { createHash } from "node:crypto";

const DIRECTORY_TTL_MS = 10 * 60_000;
const FIRST_LOAD_WAIT_MS = 3_000;
const MAX_EACH = 10;
const MAX_ENTRIES = 20_000;

interface Entry {
  id: string;
  personId?: string;
  name: string;
  folded: string;
  words: string[];
  photo: string | null; // an mxc:// person photo
  phones: string[]; // E.164
  emails: string[]; // lowercased
  /** Addresses as written (Contacts), for the photo lookup. */
  addresses: string[];
  source: "person" | "contact";
}

export interface DirectorySource {
  people(): Promise<Note[] | null>;
  contacts(): Promise<BbContact[]>;
  book(): Promise<ContactBook>;
}

const liveSource: DirectorySource = {
  async people() {
    const entry = resolveVaultEntry(undefined);
    const vault = vaultClient(entry.id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
    return vault.listNotes({ tags: ["person"], includeContent: false, includeMetadata: [...PERSON_IDENTITY_KEYS, "title", "photo", "avatar"] }).catch(() => null);
  },
  async contacts() {
    const c = blueBubblesClient();
    return c ? c.allContacts().catch(() => []) : [];
  },
  book: () => blueBubblesBook().catch(() => EMPTY_BOOK),
};
let source: DirectorySource = liveSource;
let cache: { at: number; built: Built | null; loading: Promise<Built> | null } = { at: 0, built: null, loading: null };
/** Tests: the directory's sources (null restores the live ones) and an empty cache. */
export function setRecipientSourceForTests(s: DirectorySource | null): void {
  source = s ?? liveSource;
  cache = { at: 0, built: null, loading: null };
}

const words = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const contactName = (c: BbContact): string =>
  c.displayName?.trim() || [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean).join(" ");

/**
 * Contacts numbers written WITHOUT a country code (review I2): offered only when exactly ONE phone of
 * an existing iMessage/SMS conversation is that number in full national form (its E.164 digits minus
 * a 1–3 digit country code equal the card's digits exactly — no trunk "0" stripping, no last-10
 * matching). "020 7946 0018" (UK, trunk 0) never matches; "(207) 946-0018" matches +1 207… only when
 * no other country's number with the same national digits is known. Ambiguous → not offered.
 */
function nationalIndex(): Map<string, Set<string>> {
  const rows = db.prepare(`SELECT DISTINCT cm.member_id AS id FROM comms_conversation_members cm
    JOIN comms_conversations c ON c.id = cm.conversation_id
    WHERE cm.member_id LIKE 'tel:+%' AND c.network IN ('imessage', 'sms') LIMIT 50000`).all() as { id: string }[];
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const e164 = r.id.slice(4);
    const d = e164.slice(1);
    if (!/^\d{8,15}$/.test(d)) continue;
    for (let cc = 1; cc <= 3; cc++) {
      const national = d.slice(cc);
      if (national.length < 7) continue;
      const set = out.get(national) ?? new Set<string>();
      set.add(e164);
      out.set(national, set);
    }
  }
  return out;
}

/** The sendable form of a Contacts address: E.164 / lowercased email, or a proven national number. */
function sendableAddress(a: string, national: Map<string, Set<string>>): { kind: "phone" | "email"; value: string } | null {
  const h = parseHandle(a);
  if (h) return h;
  if (a.includes("@") || /^\s*(\+|00)/.test(a)) return null;
  const digits = a.replace(/\D/g, "");
  const hit = digits.length >= 7 ? national.get(digits) : undefined;
  return hit && hit.size === 1 ? { kind: "phone", value: [...hit][0]! } : null;
}

/** Same person by name: equal after folding, or every word of the shorter name starts a word of the
 *  longer ("Zoe A." ~ "Zoë Álvarez"; "Carol" ≁ "Bob Stone"). */
function sameName(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w) => long.some((x) => x.startsWith(w) || w.startsWith(x)));
}

interface Built { entries: Entry[]; peopleOk: boolean }

async function build(): Promise<Built> {
  const [notes, contacts] = await Promise.all([source.people(), source.contacts()]);
  const entries: Entry[] = [];
  const byExact = new Map<string, Entry[]>(); // E.164 / lowercased email → person entries holding it
  for (const n of notes ?? []) {
    if (isTombstone(n) || isNonHumanPerson(n)) continue;
    const name = personName(n);
    if (!name) continue;
    const keys = personKeys(n).strong;
    const phones = [...new Set(keys.filter((k) => k.kind === "phone").map((k) => `+${k.value}`))];
    const emails = [...new Set(keys.filter((k) => k.kind === "email").map((k) => k.value.toLowerCase()))];
    const m = (n.metadata ?? {}) as Record<string, unknown>;
    const photo = [m.photo, m.avatar].find((v): v is string => typeof v === "string" && v.startsWith("mxc://")) ?? null;
    const folded = foldSearch(name);
    const e: Entry = { id: `p_${n.id}`, personId: n.id, name, folded, words: words(folded), photo, phones, emails, addresses: [...phones, ...emails], source: "person" };
    entries.push(e);
    for (const a of e.addresses) byExact.set(a, [...(byExact.get(a) ?? []), e]);
  }
  const national = contacts.length ? nationalIndex() : new Map<string, Set<string>>();
  for (const c of contacts) {
    if (entries.length >= MAX_ENTRIES) break;
    const name = contactName(c);
    const raw = [...(c.phoneNumbers ?? []), ...(c.emails ?? [])].map((a) => (typeof a?.address === "string" ? a.address.trim() : "")).filter(Boolean);
    if (!raw.length) continue;
    const sendable = raw.map((a) => sendableAddress(a, national)).filter((x): x is NonNullable<typeof x> => !!x);
    const phones = [...new Set(sendable.filter((x) => x.kind === "phone").map((x) => x.value))];
    const emails = [...new Set(sendable.filter((x) => x.kind === "email").map((x) => x.value))];
    // Merged into a person ONLY on an exact address (full E.164 / exact email) AND a matching name
    // (review I2): a shared landline never moves Carol's numbers under Bob, and never hides Carol.
    const folded = foldSearch(name);
    const cardWords = words(folded);
    const owner = [...phones, ...emails].flatMap((a) => byExact.get(a) ?? []).find((p) => sameName(p.words, cardWords));
    if (owner) {
      owner.phones = [...new Set([...owner.phones, ...phones])];
      owner.emails = [...new Set([...owner.emails, ...emails])];
      owner.addresses = [...new Set([...owner.addresses, ...raw])];
      continue;
    }
    if (!name || (!phones.length && !emails.length)) continue;
    const id = `c_${createHash("sha256").update(`${name}\n${raw.join("\n")}`).digest("hex").slice(0, 16)}`;
    entries.push({ id, name, folded, words: cardWords, photo: null, phones, emails, addresses: raw, source: "contact" });
  }
  // `notes === null` = the vault listing FAILED (not "no people"): the result is partial (M5).
  return { entries, peopleOk: notes !== null };
}

/** A directory built without the vault's people is kept this long only (then rebuilt). */
const PARTIAL_TTL_MS = 30_000;

/** The directory: fresh, stale while a rebuild runs, or (first use) whatever loads in time. */
async function directory(now = Date.now()): Promise<Built | null> {
  const ttl = cache.built && !cache.built.peopleOk ? PARTIAL_TTL_MS : DIRECTORY_TTL_MS;
  if (!cache.loading && (!cache.built || now - cache.at > ttl)) {
    const p = build();
    cache.loading = p;
    p.then((built) => { cache = { at: Date.now(), built, loading: null }; })
      .catch((e) => {
        console.warn(`[comms] recipient directory build failed (${(e as Error)?.name ?? "error"})`);
        cache = { ...cache, at: Date.now(), loading: null }; // retried after the TTL (stale entries kept)
      });
  }
  if (cache.built) return cache.built;
  const loading = cache.loading;
  if (!loading) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), FIRST_LOAD_WAIT_MS); });
  try {
    return await Promise.race([loading.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 0 = best. null = no match. */
function rank(e: Entry, q: string, qWords: string[], qDigits: string, hasLetter: boolean): number | null {
  if (e.folded.startsWith(q)) return 0;
  if (qWords.length && qWords.every((w) => e.words.some((x) => x.startsWith(w)))) return 1;
  if (q.length >= 2 && e.folded.includes(q)) return 2;
  if (qDigits.length >= 3 && !hasLetter && e.phones.some((p) => p.replace(/\D/g, "").includes(qDigits))) return 3;
  if (hasLetter && q.length >= 2 && e.emails.some((m) => m.includes(q))) return 3;
  return null;
}

const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("") || "?";

export interface RecipientOut {
  id: string;
  personId?: string;
  name: string;
  avatar: AvatarRef | null;
  phones: Array<{ value: string; threadId?: string }>;
  emails: Array<{ value: string; threadId?: string }>;
  source: "person" | "contact";
}
export interface RecipientsResult {
  query: string;
  handle: (Handle & { threadId?: string }) | null;
  people: RecipientOut[];
  threads: Thread[];
  partial: boolean;
}

export async function searchRecipients(rawQ: string, limit: number): Promise<RecipientsResult> {
  const q = foldSearch(rawQ);
  const qWords = words(q);
  const qDigits = rawQ.replace(/\D/g, "");
  const hasLetter = /\p{L}/u.test(q);
  const built = await directory();
  const matched = (built?.entries ?? [])
    .map((e) => ({ e, r: rank(e, q, qWords, qDigits, hasLetter) }))
    .filter((x): x is { e: Entry; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);

  const memberIds = matched.flatMap((e) => [...e.phones.slice(0, MAX_EACH).map((p) => `tel:${p}`), ...e.emails.slice(0, MAX_EACH).map((m) => `mailto:${m}`)]);
  const existing = existingThreadsByMember(memberIds);
  const book = matched.some((e) => !e.photo) ? await source.book() : EMPTY_BOOK;
  const people: RecipientOut[] = matched.map((e) => {
    const bookAvatar = e.photo ? null : e.addresses.map((a) => book.avatarOf(a)).find((a) => !!a) ?? null;
    return {
      id: e.id,
      ...(e.personId ? { personId: e.personId } : {}),
      name: e.name,
      avatar: e.photo ? { mxc: e.photo } : bookAvatar ?? { monogram: initials(e.name) },
      phones: e.phones.slice(0, MAX_EACH).map((value) => ({ value, ...(existing.get(`tel:${value}`) ? { threadId: existing.get(`tel:${value}`)! } : {}) })),
      emails: e.emails.slice(0, MAX_EACH).map((value) => ({ value, ...(existing.get(`mailto:${value}`) ? { threadId: existing.get(`mailto:${value}`)! } : {}) })),
      source: e.source,
    };
  });

  // Threads: title/preview matches (any folder, any network) + the matched people's own threads.
  const seen = new Map<string, Thread>();
  for (const t of listThreads({ q: rawQ, limit }).threads) seen.set(t.id, t);
  for (const e of matched) if (e.personId) for (const t of threadsOfPerson(e.personId, limit)) if (!seen.has(t.id)) seen.set(t.id, t);
  const threads = [...seen.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id)).slice(0, limit);

  const h = parseHandle(rawQ);
  const handle = h ? { ...h, ...(() => { const t = existingThreadFor(h, "imessage"); return t ? { threadId: t } : {}; })() } : null;
  return { query: rawQ, handle, people, threads, partial: !built || !built.peopleOk };
}

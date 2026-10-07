/**
 * A person's conversations, resolved AT READ TIME (Messages → People).
 *
 * The People tab used to depend on stored `messages-with` / `email-from` /
 * `email-to` links. Those are written only by the forward-linking flags
 * (`MATRIX_LINK_*`, `PROTON_LINK_*`, off by default) or the dry-run-by-default
 * backfill job, so on a vault where neither ran the tab was empty although the
 * person notes, the mail and the chat threads were all there.
 *
 * This module answers the same question without any link having been written:
 *   - email notes      → every address in `from` / `to` / `cc`
 *   - chat threads     → every Matrix id in `participantIds`, plus a DM room id a
 *                        person note states (`matrixRoomIds`)
 *   - meeting notes    → `attendeeEmails`
 * each resolved through the conservative `IdentityIndex` — STRONG KEYS ONLY
 * (address, Matrix id / bridged network id). A display name (`participants`,
 * the name part of `From:`) never associates anybody. Stored links between a
 * person and one of those notes are honoured as well.
 *
 * Cost: four LEAN listings per vault (no bodies, a handful of metadata keys),
 * built once and reused for `PEOPLE_CONVERSATIONS_TTL_MS` (60 s); concurrent
 * callers share one build; the build is linear in rows + addresses and yields to
 * the event loop. Nothing here writes to the vault.
 *
 * The index is permission-free. Every answer is filtered per caller by the
 * `view` callback (the person note AND each conversation note).
 */
import { vaultClient, type Note } from "./parachute";
import { IdentityIndex, looksLikeEmail, ownerProfile, type IdentityKey } from "./identity";
import { parseAddressList } from "./worker/proton-parse";
import { ownerConfigFor } from "./people-owner";
import { isPerson } from "./people-directory";
import type { NoteRef } from "./permissions";

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const conversationLimits = {
  ttlMs: num("PEOPLE_CONVERSATIONS_TTL_MS", 60_000),
  maxPeople: num("PEOPLE_CONVERSATIONS_MAX_PEOPLE", 10_000),
  maxEmails: num("PEOPLE_CONVERSATIONS_MAX_EMAILS", 20_000),
  maxThreads: num("PEOPLE_CONVERSATIONS_MAX_THREADS", 10_000),
  maxMeetings: num("PEOPLE_CONVERSATIONS_MAX_MEETINGS", 5_000),
  /** Addresses / member ids read per note (a 2,000-member room is cut here). */
  maxKeysPerNote: 400,
  vaultTimeoutMs: num("PEOPLE_CONVERSATIONS_VAULT_TIMEOUT_MS", 20_000),
};

export type ConversationKind = "email" | "chat" | "meeting";
export interface ConversationItem {
  id: string;
  kind: ConversationKind;
  /** `email`, `meeting`, or the chat network (`telegram`, `whatsapp`, `signal`, `matrix`, …). */
  platform: string;
  title: string;
  /** Epoch ms of the last message (0 = unknown). */
  at: number;
  unread: boolean;
  /** Members of a chat room, when known (a group is not a 1:1 conversation). */
  members?: number;
}
interface IndexedItem extends ConversationItem {
  ref: NoteRef;
}
export interface IndexedPerson {
  id: string;
  name: string;
  ref: NoteRef;
  /** Kinds of strong identity on file (`email`, `matrix`, `telegram`, `phone`, `handle`). */
  identityKinds: string[];
  /** Indices into `items`, unordered. */
  items: number[];
}
export interface ConversationIndex {
  builtAt: number;
  people: Map<string, IndexedPerson>;
  items: IndexedItem[];
  /** tombstone id → canonical person id (the directory's redirect). */
  redirects: Map<string, string>;
  /** A listing hit its cap: older conversations may be missing. */
  limited: boolean;
}

const PERSON_KEYS = [
  "name", "title", "email", "emails", "contact", "contact_emails", "channels", "matrix", "matrixId", "matrixRoomIds",
  "telegram", "signal", "whatsapp", "phone", "aliases", "alias", "type", "status", "merged_into", "mergedInto", "superseded_by",
  "prism_creator", "prism_visibility",
];
const ACCESS_KEYS = ["prism_creator", "prism_visibility"];
const TRASH_TAG = "prism-trashed";

const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
/** `Name <a@b>, c@d` → lower-cased addresses (the Proton ingest's linear RFC 5322 parser; names are dropped). */
function addressList(raw: unknown): Array<{ email: string }> {
  const out: Array<{ email: string }> = [];
  for (const s of strings(raw))
    for (const item of parseAddressList(s.slice(0, 20_000)))
      for (const m of item.members) if (looksLikeEmail(m.addr)) out.push({ email: m.addr.trim().toLowerCase() });
  return out;
}
const refOf = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: typeof n.metadata?.prism_creator === "string" ? n.metadata.prism_creator : null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: n.path ?? null,
});
const leaf = (n: Note): string => (n.path ?? "").split("/").pop() ?? "";
const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
const stamp = (...values: unknown[]): number => {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return 0;
};
const personName = (n: Note): string =>
  (typeof n.metadata?.name === "string" && n.metadata.name.trim()) || leaf(n).replace(/-/g, " ") || "Unnamed person";
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Chat network of a thread: what the ingester stored, else what its bridged member ids say. */
function chatPlatform(n: Note, ids: string[]): string {
  const p = n.metadata?.platform;
  if (typeof p === "string" && p.trim()) return p.trim().toLowerCase();
  for (const id of ids) {
    const local = id.slice(1).split(":")[0] ?? "";
    for (const net of ["telegram", "whatsapp", "signal", "discord", "slack", "instagram", "linkedin", "imessage", "gmessages", "meta", "twitter"])
      if (local.startsWith(`${net}_`)) return net;
  }
  return "matrix";
}

export interface ConversationSource {
  listNotes(opts: { tags?: string[]; limit?: number; includeLinks?: boolean; orderBy?: "updated_at" | "created_at"; includeMetadata?: string[] }): Promise<Note[]>;
}

/** Build the per-vault index from four lean listings. Pure apart from the reads. */
export async function buildConversationIndex(vault: ConversationSource, vaultId: string, now = Date.now()): Promise<ConversationIndex> {
  const L = conversationLimits;
  const [people, emails, threads, meetings] = await Promise.all([
    vault.listNotes({ tags: ["person"], limit: L.maxPeople, includeLinks: true, includeMetadata: PERSON_KEYS }),
    vault.listNotes({ tags: ["email"], limit: L.maxEmails, orderBy: "updated_at", includeMetadata: ["from", "to", "cc", "subject", "lastMessageAt", "date", "isUnread", "account", ...ACCESS_KEYS] }),
    vault.listNotes({ tags: ["message-thread"], limit: L.maxThreads, orderBy: "updated_at", includeMetadata: ["participantIds", "matrixRoomId", "matrix_room_id", "platform", "lastMessageAt", "title", ...ACCESS_KEYS] }),
    vault.listNotes({ tags: ["meeting"], limit: L.maxMeetings, orderBy: "updated_at", includeMetadata: ["attendeeEmails", "title", "start", "date", "event_status", ...ACCESS_KEYS] }),
  ]);
  const limited = emails.length >= L.maxEmails || threads.length >= L.maxThreads || meetings.length >= L.maxMeetings;

  const persons = people.filter(isPerson);
  const idx = new IdentityIndex(persons);
  const owner = ownerProfile(idx, ownerConfigFor(vaultId));
  const out: ConversationIndex = { builtAt: now, people: new Map(), items: [], redirects: new Map(), limited };
  for (const n of idx.live()) {
    const kinds = new Set(idx.keysFor(n.id).strong.filter((k) => !(k.kind === "matrix" && k.value.startsWith("!"))).map((k) => k.kind as string));
    out.people.set(n.id, { id: n.id, name: personName(n), ref: refOf(n), identityKinds: [...kinds].sort(), items: [] });
  }
  for (const n of idx.tombstones()) {
    const canonical = idx.canonicalOf(n);
    if (canonical && canonical.id !== n.id && out.people.has(canonical.id)) out.redirects.set(n.id, canonical.id);
  }

  const itemAt = new Map<string, number>();
  const seen = new Set<string>();
  const attach = (personId: string | undefined, item: number): void => {
    if (!personId || personId === owner.person?.id) return;
    const p = out.people.get(personId);
    const key = `${personId}\u0000${item}`;
    if (!p || seen.has(key)) return;
    seen.add(key);
    p.items.push(item);
  };
  /** Exactly one live person on a strong key, else nobody (ambiguous keys never associate). */
  const byKey = (q: { email?: string; matrixId?: string }): string | undefined => {
    const m = idx.match(q);
    return m.status === "linked" ? m.person.id : undefined;
  };
  const push = (n: Note, item: Omit<ConversationItem, "id">): number => {
    const at = out.items.push({ id: n.id, ...item, ref: refOf(n) }) - 1;
    itemAt.set(n.id, at);
    return at;
  };
  const live = (n: Note): boolean => !(n.tags ?? []).includes(TRASH_TAG);
  let work = 0;
  const tick = async (): Promise<void> => {
    if (++work % 400 === 0) await yieldLoop();
  };

  for (const n of emails) {
    await tick();
    if (!live(n)) continue;
    const md = n.metadata ?? {};
    const account = typeof md.account === "string" ? md.account.trim().toLowerCase() : "";
    const item = push(n, {
      kind: "email", platform: "email",
      title: clip((typeof md.subject === "string" && md.subject.trim()) || n.displayTitle || leaf(n) || "(no subject)"),
      at: stamp(md.lastMessageAt, md.date, n.updatedAt), unread: md.isUnread === true,
    });
    const addrs = [...addressList(md.from), ...addressList(md.to), ...addressList(md.cc)].slice(0, L.maxKeysPerNote);
    for (const a of addrs) {
      if (a.email === account || owner.emails.has(a.email)) continue;
      attach(byKey({ email: a.email }), item);
    }
  }
  for (const n of threads) {
    await tick();
    if (!live(n)) continue;
    const md = n.metadata ?? {};
    const ids = strings(md.participantIds).map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith("@") && s.includes(":"));
    const item = push(n, {
      kind: "chat", platform: chatPlatform(n, ids),
      title: clip((typeof md.title === "string" && md.title.trim()) || n.displayTitle || leaf(n).replace(/-/g, " ") || "Conversation"),
      at: stamp(md.lastMessageAt, n.updatedAt), unread: false,
      ...(ids.length ? { members: ids.length } : {}),
    });
    for (const id of ids.slice(0, L.maxKeysPerNote)) {
      if (owner.matrixIds.has(id)) continue;
      attach(byKey({ matrixId: id }), item);
    }
    // A DM room id written on the person note (`matrixRoomIds`) is a strong key too.
    const room = strings(md.matrixRoomId ?? md.matrix_room_id)[0]?.trim().toLowerCase();
    if (room?.startsWith("!")) {
      const key: IdentityKey = { kind: "matrix", value: room };
      const claim = idx.claimants(key);
      if (claim.length === 1 && !idx.claimedBy(key).length) attach(claim[0]!.id, item);
    }
  }
  for (const n of meetings) {
    await tick();
    if (!live(n) || (n.tags ?? []).includes("calendar-archived") || n.metadata?.event_status === "cancelled") continue;
    const md = n.metadata ?? {};
    const addrs = strings(md.attendeeEmails).slice(0, L.maxKeysPerNote).map((e) => e.trim().toLowerCase());
    if (!addrs.length) {
      itemAt.set(n.id, -1);
      continue;
    }
    const item = push(n, {
      kind: "meeting", platform: "meeting",
      title: clip((typeof md.title === "string" && md.title.trim()) || n.displayTitle || leaf(n) || "Meeting"),
      at: stamp(md.start, md.date, n.updatedAt), unread: false,
    });
    for (const e of addrs) if (!owner.emails.has(e)) attach(byKey({ email: e }), item);
  }
  // Stored links, where somebody wrote them (either direction; a stub's links belong to its canonical).
  for (const n of persons) {
    if (!n.links?.length) continue;
    await tick();
    const target = out.people.has(n.id) ? n.id : out.redirects.get(n.id);
    if (!target) continue;
    for (const l of n.links) {
      const other = l.sourceId === n.id ? l.targetId : l.targetId === n.id ? l.sourceId : null;
      const item = other ? itemAt.get(other) : undefined;
      if (item !== undefined && item >= 0) attach(target, item);
    }
  }
  return out;
}

// ── per-vault cache ──────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; index: ConversationIndex }>();
const building = new Map<string, Promise<ConversationIndex>>();
let source: ((vaultId: string) => ConversationSource) | null = null;
/** Tests: a fake source, and a clean cache. */
export function setConversationSourceForTests(value: typeof source): void {
  source = value;
  resetConversationIndex();
}
export function resetConversationIndex(vaultId?: string): void {
  if (vaultId) cache.delete(vaultId);
  else cache.clear();
}

export async function conversationIndex(vaultId: string): Promise<ConversationIndex> {
  const hit = cache.get(vaultId);
  if (hit && Date.now() - hit.at < conversationLimits.ttlMs) return hit.index;
  const running = building.get(vaultId);
  if (running) return running;
  const job = (async () => {
    const vault = source ? source(vaultId) : vaultClient(vaultId, { timeoutMs: conversationLimits.vaultTimeoutMs });
    const index = await buildConversationIndex(vault, vaultId);
    cache.set(vaultId, { at: Date.now(), index });
    // A handful of vaults at most; never an unbounded map.
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return index;
  })().finally(() => building.delete(vaultId));
  building.set(vaultId, job);
  return job;
}

// ── answers (always through the caller's `view`) ─────────────────────────────

export interface PersonConversationRow {
  id: string;
  name: string;
  platforms: string[];
  lastMessageAt: number;
  count: number;
  unread: number;
  hasIdentity: boolean;
}
type View = (ref: NoteRef) => boolean;
const wire = ({ ref: _ref, ...item }: IndexedItem): ConversationItem => item;

function rowFor(index: ConversationIndex, p: IndexedPerson, view: View): PersonConversationRow {
  const platforms = new Map<string, number>();
  let last = 0, count = 0, unread = 0;
  for (const i of p.items) {
    const item = index.items[i]!;
    if (!view(item.ref)) continue;
    count++;
    if (item.unread) unread++;
    if (item.at > last) last = item.at;
    platforms.set(item.platform, Math.max(platforms.get(item.platform) ?? 0, item.at));
  }
  return {
    id: p.id, name: p.name, count, unread, lastMessageAt: last, hasIdentity: p.identityKinds.length > 0,
    platforms: [...platforms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
  };
}

/**
 * People with conversations, most recent first. With a query, people matching it
 * who have NO conversation are listed after them (so "why is X not here" has an answer).
 */
export function listPeopleWithConversations(index: ConversationIndex, view: View, opts: { query?: string; limit?: number } = {}) {
  const q = (opts.query ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const withThreads: PersonConversationRow[] = [];
  const without: PersonConversationRow[] = [];
  let noIdentity = 0;
  for (const p of index.people.values()) {
    if (!view(p.ref)) continue;
    const matches = !q || p.name.toLowerCase().includes(q);
    const row = p.items.length ? rowFor(index, p, view) : null;
    if (row?.count) {
      if (matches) withThreads.push(row);
      continue;
    }
    if (!p.identityKinds.length) noIdentity++;
    if (q && matches) without.push({ id: p.id, name: p.name, platforms: [], lastMessageAt: 0, count: 0, unread: 0, hasIdentity: p.identityKinds.length > 0 });
  }
  withThreads.sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  without.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const people = [...withThreads, ...without.slice(0, 25)];
  return {
    people: people.slice(0, limit),
    total: withThreads.length,
    /** Viewable people with no conversation and no email / handle on file. */
    withoutIdentity: noIdentity,
    truncated: people.length > limit,
    limited: index.limited,
  };
}

/** One person's merged timeline, newest first. `null` = no such (viewable, live) person. */
export function personTimeline(index: ConversationIndex, id: string, view: View, opts: { before?: number; limit?: number } = {}) {
  const canonical = index.people.has(id) ? id : index.redirects.get(id);
  const p = canonical ? index.people.get(canonical) : undefined;
  if (!p || !view(p.ref)) return null;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const all = p.items.map((i) => index.items[i]!).filter((item) => view(item.ref));
  all.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const rest = opts.before !== undefined ? all.filter((item) => item.at < opts.before!) : all;
  const page = rest.slice(0, limit);
  const platforms = [...new Set(all.map((item) => item.platform))];
  return {
    person: { id: p.id, name: p.name, hasIdentity: p.identityKinds.length > 0, identityKinds: p.identityKinds, count: all.length, platforms },
    items: page.map(wire),
    next: rest.length > limit ? page.at(-1)!.at : null,
    limited: index.limited,
    ...(canonical !== id ? { mergedFrom: id } : {}),
  };
}

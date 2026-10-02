/**
 * Deterministic identity index over `person` notes — the pure core of the
 * "identity + linking" layer (worker/people.ts delegates to it; the backfill
 * job, the forward linkers, the review queue and the merge tool all read it).
 *
 * WHAT IT FIXES (live-vault audit, 2026-10-02):
 *   - TOMBSTONES. A merged person keeps a stub note (`merged-stub` / `superseded`
 *     tag, `metadata.merged_into` / `superseded_by`, `status:
 *     merged_into_canonical`) that still carried the email → two claimants →
 *     "ambiguous" → never linked. A tombstone no longer claims anything: its keys
 *     and names are attributed to the note it was merged into (followed through a
 *     chain, cycle-safe); a tombstone whose target can't be found is ignored.
 *   - `aliases`, `telegram`, `phone` were never indexed; bridge puppets
 *     (`@telegram_<id>:host`, `@whatsapp_<number>:host`, `@twitter_<id>:host`, …)
 *     were only matchable by the full Matrix id.
 *   - Three slug rules create person paths (the server's `rustSanitizePath`, the
 *     agent repo's ASCII-fold slugify, a skill writing `vault/people/{Full Name}`).
 *     `slugKey` folds all three to one key.
 *
 * RESOLUTION IS CONSERVATIVE (`IdentityIndex.match`):
 *   1. STRONG keys (email, Matrix id, Telegram id/handle, international phone,
 *      bridge handle): exactly ONE live person across every supplied key →
 *      linked. More than one → review (`ambiguous-key`), never a pick. A key held
 *      only by a non-human note or an unresolvable tombstone is CLAIMED: nothing
 *      links and nothing may be created for it.
 *   2. A NAME is weak evidence — a display name is free text its sender controls.
 *      A unique full-name / alias match is a REVIEW item (`name-only`) unless the
 *      caller passes `allowName` (the backfill job does, and only for meeting
 *      attendee lists and task assignee strings). Even then: ≥2 tokens, exactly
 *      one live person answers to it, no generic name ("Unknown", "Guest", …),
 *      and no unknown strong key of a kind that person already has on file
 *      (`name-key-mismatch`).
 *   3. Single-token and shared names with a candidate → review. No candidate →
 *      `none`. This layer never creates people.
 */
import type { Note } from "./parachute";

export type KeyKind = "email" | "matrix" | "telegram" | "phone" | "handle";
export interface IdentityKey {
  kind: KeyKind;
  /** Normalized (lowercased, canonical form). */
  value: string;
}
export type NameKey = { kind: "name"; value: string };
/** What a link was decided on (the job reports `wouldLink` per kind). */
export type Evidence = "email" | "mxid" | "telegram" | "phone" | "handle" | "alias" | "full-name" | "path";
const EVIDENCE_OF: Record<KeyKind, Evidence> = { email: "email", matrix: "mxid", telegram: "telegram", phone: "phone", handle: "handle" };

const keyId = (k: IdentityKey | NameKey): string => `${k.kind}\u0000${k.value}`;

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}
/** Like `strings`, but a number counts (a Telegram id stored as a JSON number). */
function scalars(v: unknown): string[] {
  const one = (x: unknown): string[] => (typeof x === "string" ? [x] : typeof x === "number" && Number.isFinite(x) ? [String(x)] : []);
  return Array.isArray(v) ? v.flatMap(one) : one(v);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ── normalizers ──────────────────────────────────────────────────────────────

/**
 * One key for every slug rule in use: NFKD, combining marks dropped, lowercase,
 * every run of non-alphanumerics → one `-`, trimmed. "J. Smith", "j--smith"
 * (rustSanitizePath), "j-smith" (ASCII slugify) and "J Smith" all → "j-smith".
 */
export function slugKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export const normalizeEmailKey = (e: string): string => e.trim().toLowerCase();

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const looksLikeEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/**
 * A phone KEY needs a country code: `+…` or `00…`, then 7–15 digits. A local
 * number ("303 555 0100") is NOT a key — it would collide across countries and
 * could never equal a bridge puppet's international number anyway.
 */
export function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (!/^(\+|00)[\d\s().-]+$/.test(t)) return null;
  let d = t.replace(/\D+/g, "");
  if (t.startsWith("00")) d = d.slice(2);
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/**
 * The mautrix bridges this deployment runs (worker/matrix.ts `detectPlatform`):
 * a puppet is `@<network>_<remote id>:host`. ONLY these prefixes with an
 * id-shaped remote part parse as puppets — `@pat_smith:matrix.org` is a person.
 */
const PUPPET_NETWORKS = new Set(["telegram", "whatsapp", "signal", "discord", "instagram", "messenger", "facebook", "twitter"]);
const PUPPET_RE = /^@([a-z]+)_(lid-)?([a-z0-9-]+):/;
const REMOTE_ID_RE = /^(\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Keys carried by a Matrix id: the id itself, plus — for a bridge puppet — the
 * remote identity it stands for, so a person who only has `telegram: 123456` on
 * file is found from `@telegram_123456:host`.
 *   telegram_<n> → telegram:<n> · whatsapp_<digits> / signal_<digits> → phone ·
 *   whatsapp_lid-<n> → handle whatsapp-lid:<n> · the other known networks →
 *   handle <network>:<id>.
 */
export function matrixKeys(mxid: string): IdentityKey[] {
  const v = mxid.trim().toLowerCase();
  if (!v.startsWith("@") || !v.includes(":")) return [];
  const out: IdentityKey[] = [{ kind: "matrix", value: v }];
  const m = PUPPET_RE.exec(v);
  if (!m || !PUPPET_NETWORKS.has(m[1]!) || !REMOTE_ID_RE.test(m[3]!)) return out;
  const net = m[1]!, lid = !!m[2], id = m[3]!;
  if (lid) out.push({ kind: "handle", value: `${net}-lid:${id}` });
  else if (net === "telegram") out.push({ kind: "telegram", value: id });
  else if ((net === "whatsapp" || net === "signal") && /^\d{7,15}$/.test(id)) out.push({ kind: "phone", value: id });
  else out.push({ kind: "handle", value: `${net === "facebook" ? "messenger" : net}:${id}` });
  return out;
}

/** Is this Matrix id a bridge puppet (so its "kind" is the remote network)? */
export const isPuppet = (mxid: string): boolean => matrixKeys(mxid).length > 1;

/**
 * A `telegram` field: a puppet mxid, `telegram_<id>`, a numeric id (string or
 * number), an `@handle` or a t.me link. A bare word ("none", "yes", a first
 * name) is NOT a handle.
 */
export function telegramKeys(raw: string): IdentityKey[] {
  const v = raw.trim().toLowerCase();
  if (!v) return [];
  if (v.startsWith("@") && v.includes(":")) return matrixKeys(v);
  const m = /^@?telegram_(\d{4,})$/.exec(v);
  if (m) return [{ kind: "telegram", value: m[1]! }];
  if (/^\d{5,}$/.test(v)) return [{ kind: "telegram", value: v }];
  const h = /^(?:https?:\/\/t\.me\/|@)([a-z][a-z0-9_]{3,31})$/.exec(v);
  return h ? [{ kind: "telegram", value: `@${h[1]}` }] : [];
}

/** Finer than KeyKind: which network a key belongs to ("handle:twitter", "matrix", …). */
export function fineKind(k: IdentityKey): string {
  return k.kind === "handle" ? `handle:${k.value.split(":")[0]}` : k.kind;
}

/** Remove a bridge suffix (" (WhatsApp)") and reduce a Matrix id to its localpart. */
export function cleanName(name: string): string {
  let n = name.trim().replace(/^\[\[|\]\]$/g, "");
  const idx = n.lastIndexOf(" (");
  if (idx > 0 && n.endsWith(")")) n = n.slice(0, idx);
  if (n.startsWith("@") && n.includes(":")) n = (n.split(":")[0] ?? n).replace(/^@+/, "");
  return n.trim();
}

/** Tokens of a display name that carry a letter (so "J. Smith" has two). */
export const nameTokens = (name: string): string[] => slugKey(cleanName(name)).split("-").filter((t) => /\p{L}/u.test(t));

/**
 * Names that are placeholders, roles or bridge artefacts — never a person's
 * identity, as a query or as a note's name. Compared after `slugKey`.
 */
export const GENERIC_NAMES = new Set(
  [
    "Deleted Account", "Deleted User", "Unknown", "Unknown User", "Unknown Contact", "Guest", "Guest User", "Admin", "Administrator", "Support",
    "Team", "The Team", "User", "Anonymous", "Member", "Owner", "Moderator", "System", "Notetaker", "Note Taker", "Assistant", "Everyone", "All",
    "Staff", "Help", "Help Desk", "Info", "Sales", "Contact", "Office", "None", "N/A", "NA", "TBD", "Unassigned", "Nobody", "No One", "Me", "You",
    "Test", "Test User", "Bot", "Customer Service", "Customer Support", "Service", "Notifications", "No Reply", "Noreply", "Mailer Daemon",
  ].map(slugKey),
);
export const isGenericName = (name: string): boolean => GENERIC_NAMES.has(slugKey(cleanName(name)));

// ── note classification ──────────────────────────────────────────────────────

const TOMBSTONE_TAGS = new Set(["merged-stub", "superseded"]);
const NON_HUMAN_TAGS = new Set(["non-human", "bot", "organization"]);

/** `[[vault/people/X|label]]`, a bare path, a name or a note id → the bare reference. */
export function refTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  const m = /^\[\[([^\]]*)\]\]$/.exec(v);
  if (m) v = m[1]!;
  v = (v.split("|")[0] ?? "").trim();
  return v || null;
}

/** Where a tombstone says it went (null = it doesn't say). */
export function mergedIntoRef(n: Note): string | null {
  const md = n.metadata ?? {};
  return refTarget(md.merged_into) ?? refTarget(md.mergedInto) ?? refTarget(md.superseded_by);
}

/** A person note that was merged away (the owner's agent-repo convention). */
export function isTombstone(n: Note): boolean {
  if ((n.tags ?? []).some((t) => TOMBSTONE_TAGS.has(t))) return true;
  const md = n.metadata ?? {};
  return md.status === "merged_into_canonical" || mergedIntoRef(n) !== null;
}

/** Tagged `person` but not a human (a bot, an organization mis-tagged as one). */
export function isNonHumanPerson(n: Note): boolean {
  if ((n.tags ?? []).some((t) => NON_HUMAN_TAGS.has(t))) return true;
  const type = n.metadata?.type;
  return type === "organization" || type === "bot";
}

function headingOf(n: Note): string | null {
  if (typeof n.displayTitle === "string" && n.displayTitle) return n.displayTitle;
  const first = (n.content ?? "").split("\n")[0] ?? "";
  return first.startsWith("# ") && first.length > 2 ? first.slice(2) : null;
}

/** `aliases` is a CSV/semicolon string on most notes and an array on some. */
export function aliasList(v: unknown): string[] {
  return strings(v)
    .flatMap((s) => s.split(/[,;\n|]/))
    .map((s) => cleanName(s))
    .filter(Boolean);
}

export interface PersonKeys {
  strong: IdentityKey[];
  /** slugKeys of the note's OWN name: `metadata.name`, the path leaf, the heading. */
  names: string[];
  /** slugKeys from `aliases` (never `metadata.title` — that holds job titles). */
  aliases: string[];
}

/** Every identity a person note states, from every field shape seen in the vault. */
export function personKeys(n: Note): PersonKeys {
  const md = n.metadata ?? {};
  const ch = obj(md.channels);
  const strong = new Map<string, IdentityKey>();
  const add = (k: IdentityKey) => strong.set(keyId(k), k);

  for (const e of [...strings(md.email), ...strings(md.emails), ...strings(md.contact_emails), ...strings(ch.email), ...strings(md.contact)].flatMap((s) => s.split(/[,;\s]+/))) {
    if (looksLikeEmail(e)) add({ kind: "email", value: normalizeEmailKey(e) });
  }
  const mids = [...strings(md.matrix), ...strings(md.matrixId), ...strings(md.matrixRoomIds)];
  for (const [k, v] of Object.entries(ch)) if (k !== "email" && k !== "phone") mids.push(...strings(v));
  for (const m of mids) {
    const v = m.trim().toLowerCase();
    if (v.startsWith("@") && v.includes(":")) for (const k of matrixKeys(v)) add(k);
    // Room ids were indexed by the legacy linker too (a DM room stored on the person).
    else if (v.startsWith("!")) add({ kind: "matrix", value: v });
  }
  for (const t of [...scalars(md.telegram), ...scalars(ch.telegram)]) for (const k of telegramKeys(t)) add(k);
  // `contact` counts only when the whole string is phone-shaped (it is usually an address or prose).
  for (const p of [...strings(md.phone), ...strings(ch.phone), ...strings(md.contact)]) {
    const d = normalizePhone(p);
    if (d) add({ kind: "phone", value: d });
  }

  const slugs = (raw: string[]): string[] => {
    const out = new Set<string>();
    for (const r of raw) {
      if (r.includes("@") && !r.includes(" ")) continue; // an address used as a name is not a name
      const k = slugKey(cleanName(r));
      if (k && !GENERIC_NAMES.has(k)) out.add(k);
    }
    return [...out];
  };
  const own = [...strings(md.name)];
  if (n.path) own.push(n.path.split("/").pop() ?? "");
  const t = headingOf(n);
  if (t) own.push(t);
  const names = slugs(own);
  const aliases = slugs([...aliasList(md.aliases), ...aliasList(md.alias)]).filter((a) => !names.includes(a));
  return { strong: [...strong.values()], names, aliases };
}

// ── the index ────────────────────────────────────────────────────────────────

export interface IdentityQuery {
  name?: string | null;
  email?: string | null;
  matrixId?: string | null;
  telegram?: string | null;
  phone?: string | null;
  /** A `[[wikilink]]` / path / id that names the person note directly. */
  ref?: string | null;
}

export type ReviewReason = "ambiguous-key" | "ambiguous-name" | "single-token-name" | "name-key-mismatch" | "name-only" | "tombstone-unresolved";

export type Match =
  | { status: "linked"; person: Note; evidence: Evidence[] }
  | { status: "review"; reason: ReviewReason; candidates: Note[]; key: IdentityKey | NameKey }
  /** `claimed`: a non-human note or an unresolvable tombstone holds the key. */
  | { status: "none"; claimed?: boolean };

const byId = (a: Note, b: Note) => a.id.localeCompare(b.id);

export class IdentityIndex {
  private notes = new Map<string, Note>();
  private byPath = new Map<string, Note>();
  private byExactName = new Map<string, Map<string, Note>>();
  private strong = new Map<string, Map<string, Note>>();
  /** Keys held by notes that are neither live people nor redirectable. */
  private claimed = new Map<string, Note[]>();
  private names = new Map<string, Map<string, { person: Note; alias: boolean }>>();
  private kindsOf = new Map<string, Set<string>>();
  private keysOf = new Map<string, PersonKeys>();

  constructor(notes: Note[] = []) {
    for (const n of notes) this.register(n);
    for (const n of notes) this.index(n);
  }

  private register(n: Note): void {
    this.notes.set(n.id, n);
    if (n.path) this.byPath.set(n.path.toLowerCase(), n);
    for (const nm of [...strings(n.metadata?.name), n.path?.split("/").pop() ?? ""]) {
      const k = nm.trim().toLowerCase();
      if (!k) continue;
      const b = this.byExactName.get(k) ?? new Map<string, Note>();
      b.set(n.id, n);
      this.byExactName.set(k, b);
    }
  }

  /** Add one note after construction (a person created mid-pass). */
  add(n: Note): void {
    this.register(n);
    this.index(n);
  }

  /** id, path, `vault/people/<ref>`, or the exact name of ONE other live person. */
  private lookupRef(ref: string, from?: Note): Note | null {
    const direct = this.notes.get(ref) ?? this.byPath.get(ref.toLowerCase()) ?? this.byPath.get(`vault/people/${ref}`.toLowerCase());
    if (direct) return direct;
    const named = [...(this.byExactName.get(ref.trim().toLowerCase())?.values() ?? [])].filter((n) => n.id !== from?.id && !isTombstone(n));
    return named.length === 1 ? named[0]! : null;
  }

  /**
   * The live person a note stands for: itself, or — for a tombstone — the end of
   * its `merged_into` chain. null when the chain is broken, loops, or ends on a
   * non-human.
   */
  canonicalOf(n: Note): Note | null {
    const seen = new Set<string>();
    let cur: Note = n;
    while (isTombstone(cur)) {
      if (seen.has(cur.id) || seen.size > 16) return null;
      seen.add(cur.id);
      const ref = mergedIntoRef(cur);
      const next = ref ? this.lookupRef(ref, cur) : null;
      if (!next) return null;
      cur = next;
    }
    return isNonHumanPerson(cur) ? null : cur;
  }

  private index(n: Note): void {
    const owner = this.canonicalOf(n);
    const keys = personKeys(n);
    if (!owner) {
      // Not a person anyone may link to — but its keys are spoken for.
      for (const k of keys.strong) this.claimed.set(keyId(k), [...(this.claimed.get(keyId(k)) ?? []), n]);
      return;
    }
    const inherited = owner.id !== n.id;
    const kinds = this.kindsOf.get(owner.id) ?? new Set<string>();
    for (const k of keys.strong) {
      const b = this.strong.get(keyId(k)) ?? new Map<string, Note>();
      b.set(owner.id, owner);
      this.strong.set(keyId(k), b);
      kinds.add(fineKind(k));
    }
    const name = (slug: string, alias: boolean) => {
      const b = this.names.get(slug) ?? new Map<string, { person: Note; alias: boolean }>();
      const prev = b.get(owner.id);
      b.set(owner.id, { person: owner, alias: prev ? prev.alias && alias : alias });
      this.names.set(slug, b);
    };
    // A stub's own name is, for its canonical person, an alias.
    for (const nm of keys.names) name(nm, inherited);
    for (const nm of keys.aliases) name(nm, true);
    this.kindsOf.set(owner.id, kinds);
    const prev = this.keysOf.get(owner.id) ?? { strong: [], names: [], aliases: [] };
    this.keysOf.set(owner.id, {
      strong: [...prev.strong, ...keys.strong],
      names: [...new Set([...prev.names, ...(inherited ? [] : keys.names)])],
      aliases: [...new Set([...prev.aliases, ...keys.aliases, ...(inherited ? keys.names : [])])],
    });
  }

  get(idOrPath: string): Note | null {
    return this.lookupRef(idOrPath);
  }

  /** Every registered note, tombstones included. */
  all(): Note[] {
    return [...this.notes.values()];
  }

  /** Live human people (each tombstone folded into its canonical). */
  live(): Note[] {
    return this.all().filter((n) => !isTombstone(n) && !isNonHumanPerson(n));
  }

  tombstones(): Note[] {
    return this.all().filter(isTombstone);
  }

  /** All keys attributed to a live person, including those inherited from stubs. */
  keysFor(personId: string): PersonKeys {
    return this.keysOf.get(personId) ?? { strong: [], names: [], aliases: [] };
  }

  claimants(k: IdentityKey): Note[] {
    return [...(this.strong.get(keyId(k))?.values() ?? [])].sort(byId);
  }

  /** Non-human notes / unresolvable tombstones holding this key. */
  claimedBy(k: IdentityKey): Note[] {
    return this.claimed.get(keyId(k)) ?? [];
  }

  named(name: string): Note[] {
    const k = slugKey(cleanName(name));
    return k ? [...(this.names.get(k)?.values() ?? [])].map((x) => x.person).sort(byId) : [];
  }

  /** Strong keys a query supplies (normalized, de-duplicated, in a stable order). */
  static queryKeys(q: IdentityQuery): IdentityKey[] {
    const out = new Map<string, IdentityKey>();
    const add = (k: IdentityKey) => out.set(keyId(k), k);
    const email = q.email && looksLikeEmail(q.email) ? q.email : q.name && looksLikeEmail(q.name) ? q.name : null;
    if (email) add({ kind: "email", value: normalizeEmailKey(email) });
    if (q.matrixId) for (const k of matrixKeys(q.matrixId)) add(k);
    if (q.telegram) for (const k of telegramKeys(q.telegram)) add(k);
    if (q.phone) {
      const d = normalizePhone(q.phone);
      if (d) add({ kind: "phone", value: d });
    }
    return [...out.values()];
  }

  /** The conservative resolver (see the file header). */
  match(q: IdentityQuery, opts: { allowName?: boolean } = {}): Match {
    if (q.ref) {
      const target = this.lookupRef(refTarget(q.ref) ?? q.ref);
      const person = target ? this.canonicalOf(target) : null;
      if (person) return { status: "linked", person, evidence: ["path"] };
    }
    const keys = IdentityIndex.queryKeys(q);
    const puppet = q.matrixId ? isPuppet(q.matrixId) : false;
    const hits = new Map<string, Note>();
    const evidence: Evidence[] = [];
    let claimed = false;
    for (const k of keys) {
      const c = this.claimants(k);
      // A puppet is reported as the network identity it carries, not as "mxid".
      const ev = k.kind === "matrix" && puppet ? null : EVIDENCE_OF[k.kind];
      if (c.length && ev && !evidence.includes(ev)) evidence.push(ev);
      for (const p of c) hits.set(p.id, p);
      if (this.claimedBy(k).length) claimed = true;
    }
    if (hits.size > 1 || (hits.size === 1 && claimed)) {
      const key = keys.find((k) => this.claimants(k).length > 0) ?? keys[0]!;
      return { status: "review", reason: "ambiguous-key", candidates: [...hits.values()].sort(byId), key };
    }
    if (hits.size === 1) return { status: "linked", person: [...hits.values()][0]!, evidence: evidence.length ? evidence : ["mxid"] };
    if (claimed) return { status: "none", claimed: true };

    const raw = q.name && !looksLikeEmail(q.name) ? cleanName(q.name) : "";
    const slug = raw ? slugKey(raw) : "";
    if (!slug || GENERIC_NAMES.has(slug)) return { status: "none" };
    const bucket = this.names.get(slug);
    const candidates = [...(bucket?.values() ?? [])].map((x) => x.person).sort(byId);
    if (!candidates.length) return { status: "none" };
    const queueKey: IdentityKey | NameKey = keys[0] ?? { kind: "name", value: slug };
    if (nameTokens(raw).length < 2) return { status: "review", reason: "single-token-name", candidates, key: queueKey };
    if (candidates.length > 1) return { status: "review", reason: "ambiguous-name", candidates, key: queueKey };
    const person = candidates[0]!;
    // An unknown strong key rode along: only accept the name when the person has
    // nothing of that kind on file to contradict it (a puppet counts as its network).
    const kinds = this.kindsOf.get(person.id) ?? new Set<string>();
    const primary = keys.filter((k) => !(k.kind === "matrix" && puppet));
    if (primary.some((k) => kinds.has(fineKind(k)))) return { status: "review", reason: "name-key-mismatch", candidates, key: queueKey };
    if (!opts.allowName) return { status: "review", reason: "name-only", candidates, key: queueKey };
    return { status: "linked", person, evidence: [bucket!.get(person.id)!.alias ? "alias" : "full-name"] };
  }
}

// ── the owner ────────────────────────────────────────────────────────────────

export interface OwnerConfig {
  /** OWNER_EMAIL + PEOPLE_OWNER_EMAILS. */
  emails: string[];
  /** PEOPLE_OWNER_PERSON: the owner's person note, by path or id ("" = infer). */
  person?: string;
  /** PEOPLE_OWNER_ALIASES: extra names that mean the owner. */
  aliases?: string[];
  /** The Matrix sync user, when known. */
  matrixId?: string | null;
}

export interface OwnerProfile {
  /** The owner's own person note, when it can be told apart. */
  person: Note | null;
  emails: Set<string>;
  /** slugKeys of every name that means the owner (single-token ones included). */
  names: Set<string>;
  matrixIds: Set<string>;
}

/**
 * Who "me" is, from CONFIGURATION and the owner's own person note — never a
 * hardcoded name. The note is PEOPLE_OWNER_PERSON, else the single live person
 * claiming one of the owner's addresses. Its names and aliases (plus
 * PEOPLE_OWNER_ALIASES) are what a task's `assigned: "<first name>"` is matched
 * against, and its addresses are what email/thread linking refuses to self-link.
 */
export function ownerProfile(idx: IdentityIndex, cfg: OwnerConfig): OwnerProfile {
  const emails = new Set(cfg.emails.map(normalizeEmailKey).filter(Boolean));
  let person: Note | null = null;
  if (cfg.person) {
    const n = idx.get(cfg.person);
    person = n ? idx.canonicalOf(n) : null;
  } else {
    const claim = new Map<string, Note>();
    for (const e of emails) for (const p of idx.claimants({ kind: "email", value: e })) claim.set(p.id, p);
    if (claim.size === 1) person = [...claim.values()][0]!;
  }
  const names = new Set<string>();
  const matrixIds = new Set<string>();
  if (cfg.matrixId) matrixIds.add(cfg.matrixId.trim().toLowerCase());
  for (const a of cfg.aliases ?? []) {
    if (looksLikeEmail(a)) emails.add(normalizeEmailKey(a));
    else if (slugKey(a)) names.add(slugKey(a));
  }
  if (person) {
    const keys = idx.keysFor(person.id);
    for (const n of [...keys.names, ...keys.aliases]) names.add(n);
    for (const k of keys.strong) {
      if (k.kind === "email") emails.add(k.value);
      if (k.kind === "matrix") matrixIds.add(k.value);
    }
  }
  return { person, emails, names, matrixIds };
}

/** Does this query name the owner (by address, Matrix id, or an owner name)? */
export function isOwnerQuery(owner: OwnerProfile, q: IdentityQuery): boolean {
  const email = q.email && looksLikeEmail(q.email) ? q.email : q.name && looksLikeEmail(q.name) ? q.name : null;
  if (email && owner.emails.has(normalizeEmailKey(email))) return true;
  if (q.matrixId && owner.matrixIds.has(q.matrixId.trim().toLowerCase())) return true;
  if (q.ref && owner.person) {
    const r = refTarget(q.ref) ?? q.ref;
    if (r === owner.person.id || r.toLowerCase() === (owner.person.path ?? "").toLowerCase()) return true;
  }
  // A name alone means the owner only when no strong key says otherwise.
  if (!email && !q.matrixId && q.name) {
    const k = slugKey(cleanName(q.name));
    if (k && owner.names.has(k)) return true;
  }
  return false;
}

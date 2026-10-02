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
 *   1. STRONG keys (email, Matrix id, Telegram id/handle, phone, bridge handle):
 *      exactly ONE live person across every supplied key → linked. More than one
 *      → review (`ambiguous-key`), never a pick.
 *   2. NAME rule, only when no strong key hit: the cleaned name must have ≥2
 *      tokens and equal (slug-folded) a name / alias / path leaf of exactly ONE
 *      live person — so no other live person shares it. If a strong key WAS
 *      supplied but nobody claims it, the name match is accepted only when that
 *      person has no key of the same kind on file (a person with a known email
 *      receiving mail from an unknown address is a review, `name-key-mismatch`).
 *   3. Single-token names, shared names and everything else with at least one
 *      candidate → review. No candidate at all → `none` (nothing to review; this
 *      layer never creates people).
 */
import type { Note } from "./parachute";

export type KeyKind = "email" | "matrix" | "telegram" | "phone" | "handle";
export interface IdentityKey {
  kind: KeyKind;
  /** Normalized (lowercased, canonical form). */
  value: string;
}
export type NameKey = { kind: "name"; value: string };
export type Evidence = KeyKind | "name" | "path" | "owner-alias";

const keyId = (k: IdentityKey | NameKey): string => `${k.kind}\u0000${k.value}`;

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
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
 * Digits only (a leading `+` / `00` international prefix dropped), 7–15 digits.
 * No country inference: "+1 (303) 555-0100" and "303 555 0100" are DIFFERENT
 * keys — guessing a country code would merge strangers.
 */
export function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (!t || /[a-z@]/i.test(t.replace(/\b(ext|x)\.?\s*\d+$/i, ""))) return null;
  let d = t.replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/** Networks whose mautrix puppet localpart is `<network>_<id>`. */
const PUPPET_RE = /^@([a-z][a-z0-9]*)_(lid-)?([a-z0-9._=-]+):/i;
const PUPPET_BOT_RE = /^@[a-z0-9]*bot:/i;

/**
 * Keys carried by a Matrix id: the id itself, plus — for a mautrix bridge
 * puppet — the remote identity it stands for, so a person who only has
 * `telegram: "123"` on file is found from `@telegram_123:host`.
 *   telegram_<n> → telegram:<n> · whatsapp_<digits> / signal_<digits> /
 *   gmessages_<digits> → phone · whatsapp_lid-<n> → handle whatsapp-lid:<n> ·
 *   any other `<network>_<id>` (twitter, instagram, messenger/meta/facebook,
 *   discord, linkedin, slack, signal uuid, …) → handle <network>:<id>.
 */
export function matrixKeys(mxid: string): IdentityKey[] {
  const v = mxid.trim().toLowerCase();
  if (!v.startsWith("@") || !v.includes(":")) return [];
  const out: IdentityKey[] = [{ kind: "matrix", value: v }];
  const m = PUPPET_RE.exec(v);
  if (!m || PUPPET_BOT_RE.test(v)) return out;
  const net = m[1]!, lid = !!m[2], id = m[3]!;
  if (net === "telegram" && /^\d+$/.test(id)) out.push({ kind: "telegram", value: id });
  else if (lid) out.push({ kind: "handle", value: `${net}-lid:${id}` });
  else if ((net === "whatsapp" || net === "signal" || net === "gmessages") && /^\d{7,15}$/.test(id)) out.push({ kind: "phone", value: id });
  else out.push({ kind: "handle", value: `${net === "meta" || net === "facebook" ? "messenger" : net}:${id}` });
  return out;
}

/** A `telegram` field: puppet mxid, `telegram_<id>`, a numeric id, or an @handle. */
export function telegramKeys(raw: string): IdentityKey[] {
  const v = raw.trim().toLowerCase();
  if (!v) return [];
  if (v.startsWith("@") && v.includes(":")) return matrixKeys(v);
  const m = /^@?telegram_(\d+)$/.exec(v);
  if (m) return [{ kind: "telegram", value: m[1]! }];
  if (/^\d{4,}$/.test(v)) return [{ kind: "telegram", value: v }];
  const h = /^(?:https?:\/\/t\.me\/|@)?([a-z][a-z0-9_]{3,31})$/.exec(v);
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

// ── note classification ──────────────────────────────────────────────────────

const TOMBSTONE_TAGS = new Set(["merged-stub", "superseded"]);
const NON_HUMAN_TAGS = new Set(["non-human", "bot", "organization"]);

/** `[[vault/people/X|label]]`, a bare path or a note id → the bare reference. */
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
  return refTarget(md.merged_into) ?? refTarget(md.superseded_by) ?? refTarget(md.mergedInto);
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

function titleOf(n: Note): string | null {
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
  /** slugKeys of every name this note answers to (name, title, path leaf, aliases). */
  names: string[];
}

/** Every identity a person note states, from every field shape seen in the vault. */
export function personKeys(n: Note): PersonKeys {
  const md = n.metadata ?? {};
  const ch = obj(md.channels);
  const strong = new Map<string, IdentityKey>();
  const add = (k: IdentityKey) => strong.set(keyId(k), k);

  for (const e of [...strings(md.email), ...strings(md.emails), ...strings(md.contact_emails), ...strings(ch.email)].flatMap((s) => s.split(/[,;\s]+/))) {
    if (looksLikeEmail(e)) add({ kind: "email", value: normalizeEmailKey(e) });
  }
  for (const c of strings(md.contact).flatMap((s) => s.split(/[,;\s]+/))) if (looksLikeEmail(c)) add({ kind: "email", value: normalizeEmailKey(c) });

  const mids = [...strings(md.matrix), ...strings(md.matrixId), ...strings(md.matrixRoomIds)];
  for (const [k, v] of Object.entries(ch)) if (k !== "email" && k !== "phone") mids.push(...strings(v));
  for (const m of mids) {
    const v = m.trim().toLowerCase();
    if (v.startsWith("@") && v.includes(":")) for (const k of matrixKeys(v)) add(k);
    // Room ids were indexed by the legacy linker too (a DM room stored on the person).
    else if (v.startsWith("!")) add({ kind: "matrix", value: v });
  }
  for (const t of [...strings(md.telegram), ...strings(ch.telegram)]) for (const k of telegramKeys(t)) add(k);
  for (const p of [...strings(md.phone), ...strings(ch.phone), ...strings(md.contact)]) {
    const d = normalizePhone(p);
    if (d) add({ kind: "phone", value: d });
  }

  const names = new Set<string>();
  const raw = [...strings(md.name), ...strings(md.title), ...aliasList(md.aliases), ...aliasList(md.alias)];
  if (n.path) raw.push(n.path.split("/").pop() ?? "");
  const t = titleOf(n);
  if (t) raw.push(t);
  for (const r of raw) {
    if (r.includes("@") && !r.includes(" ")) continue; // an address used as a name is not a name
    const k = slugKey(cleanName(r));
    if (k) names.add(k);
  }
  return { strong: [...strong.values()], names: [...names] };
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

export type ReviewReason = "ambiguous-key" | "ambiguous-name" | "single-token-name" | "name-key-mismatch";

export type Match =
  | { status: "linked"; person: Note; evidence: Evidence[] }
  | { status: "review"; reason: ReviewReason; candidates: Note[]; key: IdentityKey | NameKey }
  | { status: "none" };

const byId = (a: Note, b: Note) => a.id.localeCompare(b.id);

export class IdentityIndex {
  private notes = new Map<string, Note>();
  private byPath = new Map<string, Note>();
  private strong = new Map<string, Map<string, Note>>();
  private names = new Map<string, Map<string, Note>>();
  private kindsOf = new Map<string, Set<string>>();
  private keysOf = new Map<string, PersonKeys>();

  constructor(notes: Note[] = []) {
    for (const n of notes) this.register(n);
    for (const n of notes) this.index(n);
  }

  private register(n: Note): void {
    this.notes.set(n.id, n);
    if (n.path) this.byPath.set(n.path.toLowerCase(), n);
  }

  /** Add one note after construction (a person created mid-pass). */
  add(n: Note): void {
    this.register(n);
    this.index(n);
  }

  private lookupRef(ref: string): Note | null {
    return this.notes.get(ref) ?? this.byPath.get(ref.toLowerCase()) ?? this.byPath.get(`vault/people/${ref}`.toLowerCase()) ?? null;
  }

  /**
   * The live person a note stands for: itself, or — for a tombstone — the end of
   * its `merged_into` chain. null when the chain is broken, loops, or ends on a
   * non-human / another dead end.
   */
  canonicalOf(n: Note): Note | null {
    const seen = new Set<string>();
    let cur: Note = n;
    while (isTombstone(cur)) {
      if (seen.has(cur.id) || seen.size > 16) return null;
      seen.add(cur.id);
      const ref = mergedIntoRef(cur);
      const next = ref ? this.lookupRef(ref) : null;
      if (!next) return null;
      cur = next;
    }
    return isNonHumanPerson(cur) ? null : cur;
  }

  private index(n: Note): void {
    const owner = this.canonicalOf(n);
    if (!owner) return;
    const keys = personKeys(n);
    const put = (map: Map<string, Map<string, Note>>, k: string) => {
      const b = map.get(k) ?? new Map<string, Note>();
      b.set(owner.id, owner);
      map.set(k, b);
    };
    const kinds = this.kindsOf.get(owner.id) ?? new Set<string>();
    for (const k of keys.strong) {
      put(this.strong, keyId(k));
      kinds.add(fineKind(k));
    }
    for (const nm of keys.names) put(this.names, nm);
    this.kindsOf.set(owner.id, kinds);
    const prev = this.keysOf.get(owner.id);
    this.keysOf.set(owner.id, prev ? { strong: [...prev.strong, ...keys.strong], names: [...new Set([...prev.names, ...keys.names])] } : keys);
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
    return this.keysOf.get(personId) ?? { strong: [], names: [] };
  }

  claimants(k: IdentityKey): Note[] {
    return [...(this.strong.get(keyId(k))?.values() ?? [])].sort(byId);
  }

  named(name: string): Note[] {
    const k = slugKey(cleanName(name));
    return k ? [...(this.names.get(k)?.values() ?? [])].sort(byId) : [];
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
  match(q: IdentityQuery): Match {
    if (q.ref) {
      const target = this.lookupRef(refTarget(q.ref) ?? q.ref);
      const person = target ? this.canonicalOf(target) : null;
      if (person) return { status: "linked", person, evidence: ["path"] };
    }
    const keys = IdentityIndex.queryKeys(q);
    const hits = new Map<string, Note>();
    const evidence: Evidence[] = [];
    for (const k of keys) {
      const c = this.claimants(k);
      if (c.length && !evidence.includes(k.kind)) evidence.push(k.kind);
      for (const p of c) hits.set(p.id, p);
    }
    if (hits.size === 1) return { status: "linked", person: [...hits.values()][0]!, evidence };
    if (hits.size > 1) {
      const key = keys.find((k) => this.claimants(k).length > 0) ?? keys[0]!;
      return { status: "review", reason: "ambiguous-key", candidates: [...hits.values()].sort(byId), key };
    }

    const raw = q.name && !looksLikeEmail(q.name) ? cleanName(q.name) : "";
    const slug = raw ? slugKey(raw) : "";
    if (!slug) return { status: "none" };
    const candidates = this.named(raw);
    if (!candidates.length) return { status: "none" };
    const queueKey: IdentityKey | NameKey = keys[0] ?? { kind: "name", value: slug };
    if (nameTokens(raw).length < 2) return { status: "review", reason: "single-token-name", candidates, key: queueKey };
    if (candidates.length > 1) return { status: "review", reason: "ambiguous-name", candidates, key: queueKey };
    const person = candidates[0]!;
    // An unknown strong key rode along: only accept the name when the person has
    // nothing of that kind on file to contradict it.
    const kinds = this.kindsOf.get(person.id) ?? new Set<string>();
    // A bridge puppet counts as its remote network, not as a native Matrix id.
    const puppet = q.matrixId ? matrixKeys(q.matrixId).length > 1 : false;
    const primary = keys.filter((k) => !(k.kind === "matrix" && puppet));
    if (primary.some((k) => kinds.has(fineKind(k)))) return { status: "review", reason: "name-key-mismatch", candidates, key: queueKey };
    return { status: "linked", person, evidence: ["name"] };
  }
}

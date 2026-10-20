/**
 * Person linking for server ingesters — the port of the desktop's
 * `services/person_linker.rs`, shared by the Gmail ingester (worker/gmail.ts)
 * and, behind MATRIX_LINK_PEOPLE, the Matrix ingester (worker/matrix.ts).
 *
 * WHY THIS IS NOT A LINE-BY-LINE PORT (Architecture v2 WP0.6/WP1.2): the desktop
 * looked people up with up to four full-text searches per sender (name, email,
 * matrix id, then a path double-check) over a 10–20 hit window. The searches
 * missed people who plainly existed — a name the FTS tokenizer mangles, an email
 * stored under `channels.email` or `email` but not the one it checked, a
 * `channels.matrix` id it never looked at — so it POSTed a person note whose path
 * already existed and ate a 409 (≈200 per 20k vault requests, the "create→409
 * storm"). Here the lookup is an in-memory index built ONCE per pass from every
 * `person`-tagged note (no cap), keyed by:
 *   - normalized email (lowercased) from `email`, `emails`, `contact`, `channels.email`;
 *   - Matrix user id (lowercased) from `matrix`, `matrixId`, `matrixRoomIds`, `channels.*`;
 *   - normalized name from `metadata.name`, the path leaf, and the title line;
 *   - the exact person path the desktop would create (`vault/people/<slug>`).
 * (since the identity layer, src/identity.ts, a merged tombstone redirects to
 * its canonical person and a non-human claimant blocks without linking — see
 * the PeopleIndex doc comment and test/people-parity.test.ts).
 * Exact external identities are verified only when every claimant agrees.
 * Name/path matches are review candidates, never automatic aliases. A true
 * miss is created with `if_exists: "ignore"`; a returned existing note must
 * independently prove its external identity before it can be linked.
 *
 * The skip rules (too-short names, phone-number-ish ids, bare addresses,
 * automated/role mailboxes) are the desktop's, byte-for-byte.
 */
import type { IfExists, Note } from "../parachute";
import { IdentityIndex, nameTokens, slugKey, type IdentityKey, type NameKey } from "../identity";

/** The vault surface person linking needs (tests inject a fake). */
export interface PeopleVault {
  listNotes(opts: { tags?: string[] }): Promise<Note[]>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }>;
}

// ── pure helpers (ports of person_linker.rs / email_sync.rs) ────────────────

const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Rust `sanitize_path` (email_sync.rs + person_linker.rs share it): keep Unicode
 * alphanumerics, `-`, `_` and space; every other char → `-`; trim; spaces → `-`;
 * lowercase. Must stay identical — it decides the path of notes the desktop
 * already created, which is what lets the server converge on them.
 */
export function rustSanitizePath(name: string): string {
  return Array.from(name)
    .map((c) => (/^[\p{Alphabetic}\p{N}]$/u.test(c) || c === "-" || c === "_" || c === " " ? c : "-"))
    .join("")
    .trim()
    .replace(/ /g, "-")
    .toLowerCase();
}

/** Remove bridge suffixes (" (WhatsApp)") and a Matrix id used as a name. */
export function cleanDisplayName(name: string): string {
  let n = name.trim();
  const idx = n.lastIndexOf(" (");
  if (idx >= 0) n = n.slice(0, idx);
  if (n.startsWith("@") && n.includes(":")) n = (n.split(":")[0] ?? n).replace(/^@+/, "");
  return n.trim();
}

/** Lowercase, `_`/`-` → space, collapse whitespace. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

/** Automated / role addresses never become person notes (person_linker.rs). */
export function isNonhumanEmail(s: string): boolean {
  const t = s.trim().toLowerCase();
  const local = t.split("@")[0] ?? t;
  const SUBSTR = ["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "notification", "mailer-daemon", "postmaster", "bounce", "automated"];
  if (SUBSTR.some((n) => local.includes(n))) return true;
  const ROLES = ["support", "billing", "hello", "info", "admin", "team", "help", "sales", "contact", "notifications", "newsletter", "news", "updates", "alerts", "noreply"];
  return ROLES.includes(local);
}

/** Why a name/email pair must NOT produce a person note (null = allowed). */
export function creationRefusal(name: string, email?: string | null): string | null {
  const clean = cleanDisplayName(name);
  // Rust measures `len()` in BYTES; keep that so the same inputs are refused.
  if (!clean || utf8Len(clean) < 3) return "name too short";
  const digits = Array.from(clean).filter((c) => c >= "0" && c <= "9").length;
  if (digits / utf8Len(clean) > 0.5) return "name looks like a phone number or id";
  if (clean.includes("@") && !clean.includes(" ")) return "name is an email address";
  if ((email && isNonhumanEmail(email)) || isNonhumanEmail(name)) return "automated/role address";
  return null;
}

// ── the per-pass index ───────────────────────────────────────────────────────

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function titleOf(n: Note): string | null {
  if (typeof n.displayTitle === "string" && n.displayTitle) return n.displayTitle;
  const first = (n.content ?? "").split("\n")[0] ?? "";
  return first.startsWith("# ") && first.length > 2 ? first.slice(2) : null;
}

export interface FindOrCreateResult {
  id: string;
  created: boolean;
}

export interface PersonLookup { name?: string | null; email?: string | null; matrixId?: string | null; telegram?: string | null; phone?: string | null }
export type PersonResolution =
  | { status: "verified"; person: Note; evidence: Array<"email" | "matrix"> }
  /** `claimed`: the key is held only by a non-human note / an unresolvable tombstone — nobody to link, nobody to create. */
  | { status: "ambiguous" | "candidates"; candidates: Note[]; claimed?: boolean }
  | { status: "missing" };

/** What a caller with a review queue is told about an identity that was not linked. */
export interface PersonReview {
  reason: "ambiguous-key" | "ambiguous-name" | "single-token-name" | "name-only";
  key: IdentityKey | NameKey;
  display: string | null;
  /** Live people it might be (never empty). */
  candidates: Note[];
}

/**
 * The per-pass people lookup every ingester shares, so its default behaviour is
 * pinned against the pre-identity-layer index (test/people-parity.test.ts): it
 * never creates a person where that index linked or skipped.
 *
 * Keys are claimed exactly as before (whole-string addresses, Matrix ids, the
 * note's name / path leaf / heading). What changed:
 *   - a TOMBSTONE claimant (`merged-stub` / `superseded` / `merged_into`) is
 *     redirected to the person it was merged into — so a stub and its canonical
 *     no longer make an address "ambiguous";
 *   - a claimant that is a NON-HUMAN note (bot / organization / non-human) or a
 *     tombstone that points nowhere still OWNS the key, but is nobody to link
 *     to: the result is `ambiguous` + `claimed` — not linked, and never
 *     re-created as a new person;
 *   - only when nobody claims the key the old way, the identity layer's extra
 *     keys are tried (addresses inside a multi-value string, `contact_emails`,
 *     bridge-puppet ids) — an existing person is linked instead of duplicated.
 * Name matches stay review `candidates`, never a link. With a `review` sink
 * (PEOPLE_QUEUE_ON_INGEST) alias and slug-variant matches count as candidates
 * too — reported instead of silently creating a duplicate.
 */
export class PeopleIndex {
  readonly identity: IdentityIndex;
  private byEmail = new Map<string, Map<string, Note>>();
  private byMatrix = new Map<string, Map<string, Note>>();
  private byName = new Map<string, Map<string, Note>>();
  private byPath = new Map<string, Map<string, Note>>();
  /** Person notes this index created (tests + pass logging). */
  created = 0;

  constructor(notes: Note[] = []) {
    this.identity = new IdentityIndex(notes);
    for (const n of notes) this.claim(n);
  }

  /** Build from every person-tagged note in the vault — one call, no cap. */
  static async load(vault: Pick<PeopleVault, "listNotes">): Promise<PeopleIndex> {
    return new PeopleIndex(await vault.listNotes({ tags: ["person"] }));
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Retain every claimant: insertion order never chooses a canonical person. */
  add(n: Note): void {
    this.identity.add(n);
    this.claim(n);
  }

  private claim(n: Note): void {
    const set = (map: Map<string, Map<string, Note>>, key: string) => {
      const bucket = map.get(key) ?? new Map<string, Note>();
      bucket.set(n.id, n);
      map.set(key, bucket);
    };
    const md = (n.metadata ?? {}) as Record<string, unknown>;
    const ch = (md.channels && typeof md.channels === "object" ? md.channels : {}) as Record<string, unknown>;
    for (const e of [...strings(md.email), ...strings(md.emails), ...strings(md.contact), ...strings(ch.email)]) {
      if (e.includes("@")) set(this.byEmail, normalizeEmail(e));
    }
    const mids = [...strings(md.matrix), ...strings(md.matrixId), ...strings(md.matrixRoomIds)];
    for (const [k, v] of Object.entries(ch)) if (k !== "email") mids.push(...strings(v));
    for (const m of mids) if (m.startsWith("@") || m.startsWith("!")) set(this.byMatrix, m.trim().toLowerCase());
    const names = [...strings(md.name)];
    if (n.path) names.push(n.path.split("/").pop() ?? "");
    const t = titleOf(n);
    if (t) names.push(t);
    for (const nm of names) {
      const k = normalizeName(nm);
      if (k) set(this.byName, k);
    }
    set(this.byPath, (n.path ?? `#${n.id}`).toLowerCase());
  }

  /** Raw claimants → the live people they stand for, + whether a dead end claims too. */
  private settle(raw: Iterable<Note>): { live: Map<string, Note>; claimed: boolean } {
    const live = new Map<string, Note>();
    let claimed = false;
    for (const n of raw) {
      const person = this.identity.canonicalOf(n);
      if (person) live.set(person.id, person);
      else claimed = true;
    }
    return { live, claimed };
  }

  /** Exact external identity is evidence. A name/path supplies candidates only. */
  resolve(q: PersonLookup, opts: { extendedNames?: boolean } = {}): PersonResolution {
    const ordered = (notes: Iterable<Note>) => [...notes].sort((a, b) => a.id.localeCompare(b.id));
    const raw = new Map<string, Note>();
    const evidence: Array<"email" | "matrix"> = [];
    const take = (bucket: Iterable<Note> | undefined, kind: "email" | "matrix") => {
      const list = [...(bucket ?? [])];
      if (list.length && !evidence.includes(kind)) evidence.push(kind);
      for (const n of list) raw.set(n.id, n);
    };
    if (q.email) take(this.byEmail.get(normalizeEmail(q.email))?.values(), "email");
    if (q.matrixId) take(this.byMatrix.get(q.matrixId.trim().toLowerCase())?.values(), "matrix");
    let claimed = false;
    if (!raw.size) {
      // Nobody claims it the old way: the identity layer's extra keys (never a regression path).
      for (const k of IdentityIndex.queryKeys(q)) {
        take(this.identity.claimants(k), k.kind === "email" ? "email" : "matrix");
        if (this.identity.claimedBy(k).length) claimed = true;
      }
    }
    if (raw.size || claimed) {
      const s = this.settle(raw.values());
      claimed ||= s.claimed;
      if (s.live.size === 1 && !claimed) return { status: "verified", person: [...s.live.values()][0]!, evidence };
      return { status: "ambiguous", candidates: ordered(s.live.values()), ...(s.live.size === 0 ? { claimed: true } : {}) };
    }
    if (q.name) {
      const clean = cleanDisplayName(q.name);
      const found = new Map<string, Note>(this.byName.get(normalizeName(clean)) ?? []);
      for (const [id, person] of this.byPath.get(`vault/people/${rustSanitizePath(clean)}`.toLowerCase()) ?? []) found.set(id, person);
      if (opts.extendedNames) for (const person of this.identity.named(clean)) found.set(person.id, person);
      if (found.size) return { status: "candidates", candidates: ordered(this.settle(found.values()).live.values()) };
    }
    return { status: "missing" };
  }

  find(q: PersonLookup): Note | null {
    const resolution = this.resolve(q);
    return resolution.status === "verified" ? resolution.person : null;
  }

  /**
   * Find, or create when truly missing. Returns null when the name/email is one
   * the desktop refuses to make a person from (see `creationRefusal`), or when
   * `allowCreate` is false and nobody matches (group-chat rosters).
   */
  async findOrCreate(
    vault: Pick<PeopleVault, "createNote">,
    name: string,
    opts: {
      email?: string | null;
      matrixId?: string | null;
      platform?: string | null;
      allowCreate?: boolean;
      /** A review sink (PEOPLE_QUEUE_ON_INGEST): told about every miss that has a live candidate. */
      review?: (r: PersonReview) => void;
    } = {},
  ): Promise<FindOrCreateResult | null> {
    const clean = cleanDisplayName(name);
    const resolution = this.resolve({ name: clean, email: opts.email, matrixId: opts.matrixId }, { extendedNames: !!opts.review });
    if (resolution.status === "verified") return { id: resolution.person.id, created: false };
    // Do not silently merge aliases or create duplicates to work around a
    // collision. Callers can inspect resolve() to build an authorized review projection.
    if (resolution.status !== "missing") {
      if (opts.review && resolution.candidates.length) {
        const key = IdentityIndex.queryKeys({ email: opts.email, matrixId: opts.matrixId })[0] ?? ({ kind: "name", value: slugKey(clean) } as NameKey);
        const reason =
          resolution.status === "ambiguous" ? "ambiguous-key" : nameTokens(clean).length < 2 ? "single-token-name" : resolution.candidates.length > 1 ? "ambiguous-name" : "name-only";
        try {
          opts.review({ reason, key, display: clean || null, candidates: resolution.candidates });
        } catch {
          /* a review sink never breaks ingest */
        }
      }
      return null;
    }
    if (creationRefusal(name, opts.email) || opts.allowCreate === false) return null;
    const path = `vault/people/${rustSanitizePath(clean)}`;

    const channels: Record<string, unknown> = {};
    if (opts.email) channels.email = [opts.email];
    if (opts.matrixId) {
      channels.matrix = opts.matrixId;
      if (opts.platform) channels[opts.platform] = opts.matrixId;
    }
    const metadata: Record<string, unknown> = { type: "person", name: clean, channels };
    // The schema's canonical field too, so the next lookup (ours or anyone's) hits.
    if (opts.email) metadata.email = opts.email;
    const note = await vault.createNote({
      content: `# ${clean}\n\nAuto-created by Prism sync.`,
      path,
      metadata,
      tags: ["person"],
      ifExists: "ignore", // a path we could not see (or a lost race) returns the existing note — never a 409
    });
    // if_exists may return an unrelated note at the same path. Never invent
    // external aliases on that returned record just to make this pass link it.
    if (note.existed) {
      if (!note.tags?.includes("person")) return null;
      this.add(note);
      const match = this.resolve({ email: opts.email, matrixId: opts.matrixId });
      return match.status === "verified" ? { id: match.person.id, created: false } : null;
    }
    this.add(note);
    this.created++;
    return { id: note.id, created: true };
  }
}

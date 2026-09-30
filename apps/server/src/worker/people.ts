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
 * A miss is created with `if_exists: "ignore"` (so even a lost race returns the
 * existing note instead of a 409) and immediately added to the index, so a
 * sender with ten messages in one pass is created once.
 *
 * The skip rules (too-short names, phone-number-ish ids, bare addresses,
 * automated/role mailboxes) are the desktop's, byte-for-byte.
 */
import type { IfExists, Note } from "../parachute";

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

export class PeopleIndex {
  private byEmail = new Map<string, Note>();
  private byMatrix = new Map<string, Note>();
  private byName = new Map<string, Note>();
  private byPath = new Map<string, Note>();
  /** Person notes this index created (tests + pass logging). */
  created = 0;

  constructor(notes: Note[] = []) {
    for (const n of notes) this.add(n);
  }

  /** Build from every person-tagged note in the vault — one call, no cap. */
  static async load(vault: Pick<PeopleVault, "listNotes">): Promise<PeopleIndex> {
    return new PeopleIndex(await vault.listNotes({ tags: ["person"] }));
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Index one person note. First writer wins, so lookups are deterministic. */
  add(n: Note): void {
    const set = <K>(m: Map<K, Note>, k: K) => {
      if (!m.has(k)) m.set(k, n);
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

  /** Exact lookup: email, then Matrix id, then normalized name. */
  find(q: { name?: string | null; email?: string | null; matrixId?: string | null }): Note | null {
    if (q.email) {
      const hit = this.byEmail.get(normalizeEmail(q.email));
      if (hit) return hit;
    }
    if (q.matrixId) {
      const hit = this.byMatrix.get(q.matrixId.trim().toLowerCase());
      if (hit) return hit;
    }
    if (q.name) {
      const k = normalizeName(cleanDisplayName(q.name));
      const hit = k ? this.byName.get(k) : undefined;
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Find, or create when truly missing. Returns null when the name/email is one
   * the desktop refuses to make a person from (see `creationRefusal`), or when
   * `allowCreate` is false and nobody matches (group-chat rosters).
   */
  async findOrCreate(
    vault: Pick<PeopleVault, "createNote">,
    name: string,
    opts: { email?: string | null; matrixId?: string | null; platform?: string | null; allowCreate?: boolean } = {},
  ): Promise<FindOrCreateResult | null> {
    if (creationRefusal(name, opts.email)) return null;
    const clean = cleanDisplayName(name);
    const found = this.find({ name: clean, email: opts.email, matrixId: opts.matrixId });
    if (found) return { id: found.id, created: false };
    const path = `vault/people/${rustSanitizePath(clean)}`;
    const atPath = this.byPath.get(path.toLowerCase());
    if (atPath) return { id: atPath.id, created: false };
    if (opts.allowCreate === false) return null;

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
    // Index what we asked for as well as what came back: an `existed` note
    // keeps its own metadata, but this pass must still resolve this sender to it.
    this.add(note);
    this.add({ ...note, metadata });
    if (note.existed) return { id: note.id, created: false };
    this.created++;
    return { id: note.id, created: true };
  }
}

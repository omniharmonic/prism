/**
 * Governance integrity (WP0.3) — an HMAC over every governance note the
 * governance service writes, verified on every read.
 *
 * THE PROBLEM. Governance state lives in `governance-*` vault notes and the
 * grants bridge compiles it into real content grants. The vault itself cannot
 * tell a note the governance service wrote from one written straight to the
 * vault by anyone else holding a write token (the owner's desktop, a member
 * agent with a whole-vault MCP token, a member with a grant on a `governance-*`
 * tag). Without this module a forged `governance-membership` note IS a grant, and
 * a forged `governance-vote` IS an approval.
 *
 * THE FIX. When `GOVERNANCE_SIGNING_SECRET` is set, every governance note written
 * through the service carries `metadata.gov_sig`:
 *
 *   gov_sig = "v1." + hex(HMAC-SHA256(secret, DOMAIN "\n" canonical({tag, id, fields})))
 *
 *   - `tag`    the governance type the note is being read AS (so a membership
 *              note re-tagged `governance-role` does not verify as a role);
 *   - `id`     the vault note id (so a byte-for-byte COPY of a valid note, which
 *              gets a fresh id, does not verify — no duplicated votes);
 *   - `fields` the note's AUTHORITY PROJECTION (below): every metadata value the
 *              parsers read, coerced through the same helpers the parsers use
 *              (`governance-fields.ts`), plus — for revisions only — a hash of the
 *              content, because a revision's content IS the thing that gets
 *              published.
 *
 * Canonical form is JSON with recursively sorted keys; arrays keep their order.
 * Because every parser is a pure function of the coerced values the projection
 * covers, two notes with equal projections parse identically — so any change
 * that could alter a parsed governance structure breaks the signature.
 *
 * Excluded on purpose: note content for config/role/policy/membership/proposal/
 * vote/audit (derived prose — `writeConstitutionProse` rewrites the config body
 * after every mutation, and nothing reads content as authority for those
 * types), timestamps the vault maintains (`createdAt`/`updatedAt`), `path`, and
 * any metadata key no parser reads.
 *
 * LEDGER (anti-replay). A signature only proves "the server wrote this exact
 * state of this note at some point". Vault note history (0.7.9 `/restore`) lets
 * any vault-token holder put back an EARLIER signed state — re-opening an
 * applied proposal, restoring a role's wider caps — or recreate a deleted note
 * with its old id + sig. So the server also records each note's CURRENT sig in
 * SQLite (`governance_sig_ledger`, db.ts): every signed write upserts it, every
 * governance delete writes a tombstone. A note is trusted only if its sig is
 * cryptographically valid AND equals the ledger's current sig for (vault, id).
 * No row → untrusted (no trust-on-first-use); tombstone → untrusted.
 *
 * VERIFICATION. With a secret, a note whose `gov_sig` is missing, wrong, or not
 * the ledger's current one is EXCLUDED from governance state and logged once per
 * note id. With no secret the
 * module is inert — reads trust every note and writes add nothing — exactly the
 * pre-WP0.3 behaviour, plus one startup warning.
 *
 * Why a dedicated secret instead of deriving one from SESSION_SECRET: turning
 * verification on hides every unsigned governance note, so it must be an explicit
 * operator act paired with the sign-existing migration — never a side effect of
 * upgrading. See docs/governance.md "Governance integrity".
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { Note } from "./parachute";
import { getLedgerSig, setLedgerSig } from "./db";
import { GOV_TAGS, isGovTag, bool, num, str, strArr, type GovTag, type Meta } from "./governance-fields";

export const GOV_SIG_FIELD = "gov_sig";
const SIG_PREFIX = "v1.";
const DOMAIN = "prism-governance-note/v1";
/** Below this many characters a configured secret is flagged as weak at startup. */
export const MIN_SECRET_LENGTH = 32;

// ── secret (config-backed, with a test seam) ──────────────────────────────────

let secretOverride: string | null | undefined;

/** Test seam: force a secret (string), force integrity OFF (null), or restore
 *  the configured value (undefined). Also resets the warn-once memory. */
export function setGovernanceSigningSecret(secret: string | null | undefined): void {
  secretOverride = secret;
  warnedIds.clear();
}

export function governanceSigningSecret(): string {
  if (secretOverride !== undefined) return secretOverride ?? "";
  return config.governanceSigningSecret;
}

export const governanceIntegrityEnabled = (): boolean => governanceSigningSecret() !== "";

/** The registry vault id governance lives in (governance is primary-vault only;
 *  matches `reconcileGovernanceGrants("primary", …)`). Ledger rows are keyed by it. */
export const GOVERNANCE_VAULT_ID = "primary";

// ── canonical form ────────────────────────────────────────────────────────────

function canon(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canon(x);
    }
    return out;
  }
  return v;
}

/** Stable JSON: recursively sorted keys, no whitespace, undefined → dropped/null. */
export const canonicalJson = (v: unknown): string => JSON.stringify(canon(v));

export const contentDigest = (content: string | null | undefined): string =>
  createHash("sha256").update((content ?? "").trimEnd(), "utf8").digest("hex");

// ── the authority projection, per note type ───────────────────────────────────
// Every key read by the matching parser in governance-store.ts, through the SAME
// coercer and default. Vocabulary filtering (unknown powers/caps, enum fallbacks)
// is deliberately NOT applied here: the signature covers the raw coerced value,
// so a vocabulary change can never make an old signature cover new authority.

export function authorityProjection(
  tag: GovTag,
  metadata: Meta,
  content: string | null | undefined,
): Record<string, unknown> {
  const m = metadata;
  switch (tag) {
    case GOV_TAGS.config:
      return {
        enabled: bool(m, "enabled", false),
        bootstrap_owner: str(m, "bootstrap_owner"),
        amend_policy: str(m, "amend_policy"),
        default_threshold_n: num(m, "default_threshold_n", 1),
        default_eligible_role: str(m, "default_eligible_role"),
      };
    case GOV_TAGS.role:
      return {
        name: str(m, "name"),
        powers: strArr(m, "powers"),
        scope_type: str(m, "scope_type", "global"),
        scope: str(m, "scope"),
        capabilities: strArr(m, "capabilities"),
        assigns: strArr(m, "assigns"),
      };
    case GOV_TAGS.membership:
      return {
        subject: str(m, "subject"),
        role: str(m, "role"),
        granted_by: str(m, "granted_by"),
        expires_at: str(m, "expires_at"),
      };
    case GOV_TAGS.policy:
      return {
        action: str(m, "action"),
        scope_type: str(m, "scope_type", "global"),
        scope: str(m, "scope"),
        threshold_n: num(m, "threshold_n", 1),
        quorum: num(m, "quorum", 0),
        distinct_required: bool(m, "distinct_required", true),
        eligible_role: str(m, "eligible_role"),
        window_seconds: num(m, "window_seconds", 0),
        auto_publish: bool(m, "auto_publish", false),
      };
    case GOV_TAGS.proposal: {
      // The payload IS the change a proposal will effect — covered verbatim (a
      // string stays a string; anything else is canonicalized as JSON).
      const raw = m?.payload;
      return {
        action: str(m, "action"),
        target: str(m, "target"),
        state: str(m, "state", "open"),
        opened_by: str(m, "opened_by"),
        opened_at: str(m, "opened_at"),
        payload: typeof raw === "string" ? raw : canon(raw ?? null),
      };
    }
    case GOV_TAGS.vote:
      return {
        proposal: str(m, "proposal"),
        voter: str(m, "voter"),
        vote: str(m, "vote", "approve"),
        at: str(m, "at"),
        reason: str(m, "reason"),
      };
    case GOV_TAGS.audit:
      return {
        action: str(m, "action"),
        actor: str(m, "actor"),
        before: str(m, "before"),
        after: str(m, "after"),
        at: str(m, "at"),
      };
    case GOV_TAGS.revision:
      return {
        note: str(m, "note"),
        parent: str(m, "parent"),
        proposal: str(m, "proposal"),
        author: str(m, "author"),
        origin: str(m, "origin", "proposal"),
        published: bool(m, "published", false),
        at: str(m, "at"),
        payload: str(m, "payload"),
        // A revision's CONTENT is the snapshot `publishRevision`/`rollbackNote`
        // write live — it is authority, so it is covered (as a digest).
        content_sha256: contentDigest(content),
      };
  }
}

/** Does this tag's projection depend on note content? (Only revisions.) */
export const projectionUsesContent = (tag: GovTag): boolean => tag === GOV_TAGS.revision;

// ── sign / verify ─────────────────────────────────────────────────────────────

function computeSig(
  secret: string,
  tag: GovTag,
  id: string,
  metadata: Meta,
  content: string | null | undefined,
): string {
  const input = `${DOMAIN}\n${canonicalJson({ tag, id, fields: authorityProjection(tag, metadata, content) })}`;
  return SIG_PREFIX + createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/** The signature for a note (explicit secret — used by the migration script). */
export function signGovernanceNote(
  tag: GovTag,
  id: string,
  metadata: Meta,
  content: string | null | undefined,
  secret = governanceSigningSecret(),
): string {
  if (!secret) throw new Error("governance signing secret is not configured");
  return computeSig(secret, tag, id, metadata, content);
}

/** `metadata` plus a fresh `gov_sig` (or `metadata` untouched when integrity is off). */
export function withGovSig(
  tag: GovTag,
  id: string,
  metadata: Record<string, unknown>,
  content: string | null | undefined,
  secret = governanceSigningSecret(),
): Record<string, unknown> {
  if (!secret) return metadata;
  return { ...metadata, [GOV_SIG_FIELD]: computeSig(secret, tag, id, metadata, content) };
}

export type SigStatus = "valid" | "missing" | "invalid";

/** Pure check against an explicit secret — no logging. */
export function govSigStatus(
  tag: GovTag,
  note: Pick<Note, "id" | "metadata" | "content">,
  secret = governanceSigningSecret(),
): SigStatus {
  const sig = note.metadata?.[GOV_SIG_FIELD];
  if (typeof sig !== "string" || sig === "") return "missing";
  const expected = computeSig(secret, tag, note.id, note.metadata, note.content);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b) ? "valid" : "invalid";
}

const warnedIds = new Set<string>();

/**
 * Should this governance note be trusted as `tag`? Always true when integrity is
 * off (back-compat). Otherwise the signature must verify; a failure is logged
 * LOUDLY, once per note id — id and type only, never content.
 */
export type TrustStatus = SigStatus | "unledgered" | "tombstoned" | "stale";

/**
 * Cryptographic check + ledger check. `unledgered` = the server has no record of
 * ever writing this note; `tombstoned` = governance deleted it (this is a
 * recreation); `stale` = a real signature, but not the CURRENT one (a replay of
 * an older state).
 */
export function govTrustStatus(
  tag: GovTag,
  note: Pick<Note, "id" | "metadata" | "content">,
  secret = governanceSigningSecret(),
  vaultId = GOVERNANCE_VAULT_ID,
): TrustStatus {
  const status = govSigStatus(tag, note, secret);
  if (status !== "valid") return status;
  const ledger = getLedgerSig(vaultId, note.id);
  if (ledger === undefined) return "unledgered";
  if (ledger === null) return "tombstoned";
  return ledger === note.metadata?.[GOV_SIG_FIELD] ? "valid" : "stale";
}

const REASON: Record<Exclude<TrustStatus, "valid">, string> = {
  missing: `missing ${GOV_SIG_FIELD} (written outside the governance service)`,
  invalid: `invalid ${GOV_SIG_FIELD} (altered outside the governance service, or signed with another secret)`,
  unledgered: `valid ${GOV_SIG_FIELD} but no ledger record (the server never recorded writing it)`,
  tombstoned: "note was DELETED through governance — this is a recreation (e.g. a vault restore)",
  stale: `${GOV_SIG_FIELD} is not the current one — an older state was restored (replay)`,
};

export function verifyGovNote(tag: GovTag, note: Pick<Note, "id" | "metadata" | "content">): boolean {
  const secret = governanceSigningSecret();
  if (!secret) return true;
  const status = govTrustStatus(tag, note, secret);
  if (status === "valid") return true;
  if (!warnedIds.has(note.id)) {
    warnedIds.add(note.id);
    console.warn(
      `[governance] INTEGRITY: ignoring ${tag} note ${note.id} — ${REASON[status]}. It confers nothing ` +
        `until re-signed (scripts/governance-sign-existing.ts) or rewritten through governance.`,
    );
  }
  return false;
}

/** Keep only the notes that verify as `tag` (all of them when integrity is off). */
export function verifiedGovNotes<N extends Pick<Note, "id" | "metadata" | "content">>(tag: GovTag, notes: N[]): N[] {
  if (!governanceIntegrityEnabled()) return notes;
  return notes.filter((n) => verifyGovNote(tag, n));
}

/** The governance type a note is being written as (first governance tag). */
export function govTagOf(tags: readonly string[] | null | undefined): GovTag | null {
  for (const t of tags ?? []) if (isGovTag(t)) return t;
  return null;
}

// ── signed writers (the ONLY way the service writes governance notes) ─────────

type CreateVault = {
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown> }): Promise<Note>;
};

/**
 * Create a governance note. With integrity on this is TWO writes: the vault
 * assigns the id on create, and the signature binds the id, so the note is
 * created unsigned and then patched with its `gov_sig`. The window between is
 * fail-closed — an unsigned note is simply ignored by every reader — and a crash
 * inside it leaves an inert note, never a forged one.
 */
export async function createGovNote(
  vault: CreateVault,
  params: { content: string; path?: string; metadata: Record<string, unknown>; tags: string[] },
): Promise<Note> {
  const tag = govTagOf(params.tags);
  if (!tag) throw new Error("createGovNote: no governance tag on the note");
  if (!governanceIntegrityEnabled()) return vault.createNote(params);
  const { [GOV_SIG_FIELD]: _drop, ...clean } = params.metadata;
  const created = await vault.createNote({ ...params, metadata: clean });
  // Sign what the vault actually stored (content may be normalized on write).
  const content = typeof created.content === "string" ? created.content : params.content;
  const metadata = withGovSig(tag, created.id, clean, content);
  const updated = await vault.updateNote(created.id, { metadata });
  setLedgerSig(GOVERNANCE_VAULT_ID, created.id, metadata[GOV_SIG_FIELD] as string);
  return updated;
}

/**
 * Update a governance note in place and re-sign it. `current` is the note as
 * read (it must itself verify — the service never launders an unverified note
 * into a signed one). The metadata written is `current.metadata` merged with the
 * patch, so the stored authority fields are exactly the signed ones whether the
 * vault's PATCH merges or replaces metadata.
 */
export async function updateGovNote(
  vault: Pick<CreateVault, "updateNote">,
  tag: GovTag,
  current: Pick<Note, "id" | "metadata" | "content">,
  patch: { content?: string; metadata?: Record<string, unknown> },
): Promise<Note> {
  if (!governanceIntegrityEnabled()) return vault.updateNote(current.id, patch);
  if (!verifyGovNote(tag, current)) {
    throw new Error(`refusing to re-sign ${tag} note ${current.id}: its current ${GOV_SIG_FIELD} does not verify`);
  }
  // A content-only write to a type whose signature ignores content (the
  // constitution prose) leaves the signature valid — pass it straight through.
  if (patch.metadata === undefined && !projectionUsesContent(tag)) return vault.updateNote(current.id, patch);
  const { [GOV_SIG_FIELD]: _drop, ...merged } = { ...(current.metadata ?? {}), ...(patch.metadata ?? {}) };
  const content = patch.content ?? current.content;
  const metadata = withGovSig(tag, current.id, merged, content);
  const updated = await vault.updateNote(current.id, { ...patch, metadata });
  // The new state is now the ONLY trusted one — every earlier signed state of
  // this note (still sitting in vault history) stops verifying.
  setLedgerSig(GOVERNANCE_VAULT_ID, current.id, metadata[GOV_SIG_FIELD] as string);
  return updated;
}

/**
 * Delete a governance note and TOMBSTONE it in the ledger, so a later vault
 * restore that recreates it (same id, same valid sig) is refused. Tombstones are
 * written even with integrity off: a note deleted in an off-period must not come
 * back trusted if integrity is re-enabled.
 */
export async function deleteGovNote(vault: { deleteNote(id: string): Promise<void> }, id: string): Promise<void> {
  await vault.deleteNote(id);
  setLedgerSig(GOVERNANCE_VAULT_ID, id, null);
}

// ── startup ───────────────────────────────────────────────────────────────────

/** One-time startup report. Returns the message it logged (or null). */
export function reportGovernanceIntegrity(log: (msg: string) => void = console.warn): string | null {
  const secret = governanceSigningSecret();
  let msg: string | null = null;
  if (!secret) {
    msg =
      "[governance] integrity is OFF — GOVERNANCE_SIGNING_SECRET is not set, so governance-* notes are " +
      "trusted as read and anyone with a vault write token can forge memberships or votes. " +
      "Set the secret and run scripts/governance-sign-existing.ts (docs/governance.md).";
  } else if (secret.length < MIN_SECRET_LENGTH) {
    msg = `[governance] GOVERNANCE_SIGNING_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — use \`openssl rand -base64 48\`.`;
  }
  if (msg) log(msg);
  return msg;
}

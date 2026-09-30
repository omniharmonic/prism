/**
 * The sign-existing migration core (WP0.3) — used by
 * `scripts/governance-sign-existing.ts`, kept here so it is unit-testable against
 * the fake vault.
 *
 * Turning on GOVERNANCE_SIGNING_SECRET hides every governance note that lacks a
 * valid `gov_sig` recorded as CURRENT in the signature ledger
 * (`governance_sig_ledger`), which on an existing commons is ALL of them. This
 * walks every `governance-*` note in a vault and plans (dry run) or applies:
 *
 *   sign             no gov_sig yet → sign the note + record it in the ledger
 *   resign           a gov_sig that does not verify under this secret (older
 *                    secret, or edited outside governance) → re-sign + record
 *   ledger           a valid gov_sig the ledger has no row for (e.g. a restored
 *                    or fresh prism-server.db) → record it; the note is untouched
 *   skip-valid       valid AND the ledger's current sig — idempotency: a second
 *                    run writes nothing
 *   skip-tombstoned  the ledger says governance DELETED this note; it exists again
 *                    only because something recreated it (a vault restore). Never
 *                    blessed — delete it from the vault.
 *   skip-mismatch    valid, but the ledger holds a DIFFERENT current sig: this is
 *                    an older state put back (replay), or a write that crashed
 *                    between vault and ledger. Blessed only with acceptMismatch.
 *   skip-ambiguous   carries MORE than one governance tag; it can only ever verify
 *                    as one type, so a human must decide (and fix the tags) first
 *
 * TRUST NOTE: signing/recording is a statement that the owner accepts the note
 * as legitimate governance state. Anything forged BEFORE the migration gets
 * blessed with it — which is why the CLI prints the roster for review and is
 * dry-run by default.
 */
import type { Note } from "./parachute";
import { GOV_TAG_LIST, type GovTag, str } from "./governance-fields";
import { GOV_SIG_FIELD, GOVERNANCE_VAULT_ID, govSigStatus, withGovSig } from "./governance-integrity";
import { getLedgerSig, setLedgerSig } from "./db";

export interface MigrationVault {
  listNotes(opts: { tags?: string[]; includeContent?: boolean }): Promise<Note[]>;
  updateNote(id: string, params: { metadata?: Record<string, unknown> }): Promise<Note>;
}

export type SignAction =
  | "sign"
  | "resign"
  | "ledger"
  | "skip-valid"
  | "skip-tombstoned"
  | "skip-mismatch"
  | "skip-ambiguous";

export interface SignPlanItem {
  id: string;
  tag: GovTag;
  tags: GovTag[];
  action: SignAction;
  /** A one-line, content-free description for operator review (e.g. subject → role). */
  summary: string;
}

export interface SignResult {
  plan: SignPlanItem[];
  /** Notes whose vault metadata was (re)signed. */
  written: string[];
  /** Ledger rows written (or, on a dry run, that WOULD be written). */
  ledgerRows: number;
  /** Pending items after an --apply re-plan; must be 0. On a dry run: pending now. */
  remaining: number;
}

export interface SignOptions {
  secret: string;
  apply: boolean;
  /** Registry vault id the ledger rows are keyed by (governance runs on "primary"). */
  vaultId?: string;
  /** Record valid-but-mismatched notes too (after a human confirmed them). */
  acceptMismatch?: boolean;
}

function summarize(tag: GovTag, m: Note["metadata"]): string {
  switch (tag) {
    case "governance-membership":
      return `${str(m, "subject")} → ${str(m, "role")}${str(m, "expires_at") ? ` (until ${str(m, "expires_at")})` : ""}`;
    case "governance-vote":
      return `${str(m, "voter")} ${str(m, "vote", "approve")} on ${str(m, "proposal")}`;
    case "governance-role":
      return `role ${str(m, "name")}`;
    case "governance-policy":
      return `policy ${str(m, "action")} (${str(m, "scope_type", "global")}${str(m, "scope") ? `:${str(m, "scope")}` : ""})`;
    case "governance-proposal":
      return `proposal ${str(m, "action")} → ${str(m, "target")} [${str(m, "state", "open")}]`;
    case "governance-config":
      return `config enabled=${String(m?.enabled ?? false)}`;
    case "governance-revision":
      return `revision of ${str(m, "note") || "(staged)"} [${str(m, "origin", "proposal")}]`;
    case "governance-audit":
      return `audit ${str(m, "action")}`;
  }
}

/** Read every governance note once (with content — revisions sign over it). */
async function collect(vault: MigrationVault): Promise<Map<string, { note: Note; tags: GovTag[] }>> {
  const byId = new Map<string, { note: Note; tags: GovTag[] }>();
  for (const tag of GOV_TAG_LIST) {
    for (const note of await vault.listNotes({ tags: [tag], includeContent: true })) {
      const entry = byId.get(note.id) ?? { note, tags: [] };
      if (!entry.tags.includes(tag)) entry.tags.push(tag);
      byId.set(note.id, entry);
    }
  }
  return byId;
}

export async function planGovernanceSigning(
  vault: MigrationVault,
  opts: { secret: string; vaultId?: string; acceptMismatch?: boolean },
): Promise<{ plan: SignPlanItem[]; notes: Map<string, Note> }> {
  if (!opts.secret) throw new Error("a signing secret is required");
  const vaultId = opts.vaultId ?? GOVERNANCE_VAULT_ID;
  const byId = await collect(vault);
  const plan: SignPlanItem[] = [];
  const notes = new Map<string, Note>();
  for (const { note, tags } of byId.values()) {
    notes.set(note.id, note);
    const tag = tags[0]!;
    const summary = summarize(tag, note.metadata);
    if (tags.length > 1) {
      plan.push({ id: note.id, tag, tags, action: "skip-ambiguous", summary: `tagged ${tags.join(" + ")}` });
      continue;
    }
    const ledger = getLedgerSig(vaultId, note.id);
    let action: SignAction;
    if (ledger === null) {
      action = "skip-tombstoned";
    } else {
      const status = govSigStatus(tag, note, opts.secret);
      if (status === "missing") action = "sign";
      else if (status === "invalid") action = "resign";
      else if (ledger === undefined) action = "ledger";
      else if (ledger === note.metadata?.[GOV_SIG_FIELD]) action = "skip-valid";
      else action = opts.acceptMismatch ? "ledger" : "skip-mismatch";
    }
    // A (re)sign over a note the ledger already had a sig for means the note was
    // changed outside governance — or an older, unsigned state was put back.
    // Rotation also lands here. Flag it for the human reading the roster.
    const flagged =
      (action === "sign" || action === "resign") && typeof ledger === "string" ? `${summary}  [CHANGED since last signed — review]` : summary;
    plan.push({ id: note.id, tag, tags, action, summary: flagged });
  }
  plan.sort((a, b) => (a.tag === b.tag ? a.id.localeCompare(b.id) : a.tag.localeCompare(b.tag)));
  return { plan, notes };
}

const PENDING: ReadonlySet<SignAction> = new Set(["sign", "resign", "ledger"]);
const pending = (p: SignPlanItem[]) => p.filter((i) => PENDING.has(i.action));

/** Dry run (default) or apply. Idempotent: an applied vault re-plans to zero pending. */
export async function signExistingGovernance(vault: MigrationVault, opts: SignOptions): Promise<SignResult> {
  const vaultId = opts.vaultId ?? GOVERNANCE_VAULT_ID;
  const { plan, notes } = await planGovernanceSigning(vault, opts);
  const todo = pending(plan);
  const written: string[] = [];
  if (!opts.apply) return { plan, written, ledgerRows: todo.length, remaining: todo.length };

  let ledgerRows = 0;
  for (const item of todo) {
    const note = notes.get(item.id)!;
    if (item.action === "ledger") {
      setLedgerSig(vaultId, item.id, note.metadata![GOV_SIG_FIELD] as string);
    } else {
      const { [GOV_SIG_FIELD]: _old, ...meta } = note.metadata ?? {};
      const metadata = withGovSig(item.tag, item.id, meta, note.content, opts.secret);
      await vault.updateNote(item.id, { metadata });
      setLedgerSig(vaultId, item.id, metadata[GOV_SIG_FIELD] as string);
      written.push(item.id);
    }
    ledgerRows++;
  }
  const after = await planGovernanceSigning(vault, { ...opts, acceptMismatch: false });
  return { plan, written, ledgerRows, remaining: pending(after.plan).length };
}

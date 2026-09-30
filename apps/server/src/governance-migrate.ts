/**
 * The sign-existing migration core (WP0.3) — used by
 * `scripts/governance-sign-existing.ts`, kept here so it is unit-testable against
 * the fake vault.
 *
 * Turning on GOVERNANCE_SIGNING_SECRET hides every governance note that lacks a
 * valid `gov_sig`, which on an existing commons is ALL of them. This walks every
 * `governance-*` note in a vault and plans (dry run) or applies a signature:
 *
 *   sign            no gov_sig yet
 *   resign          a gov_sig that does not verify under this secret (older
 *                   secret, or the note was edited outside governance)
 *   skip-valid      already verifies — idempotency: a second run writes nothing
 *   skip-ambiguous  carries MORE than one governance tag; it can only ever verify
 *                   as one type, so a human must decide (and fix the tags) first
 *
 * TRUST NOTE: signing is a statement that the owner accepts the note as
 * legitimate governance state. Anything forged BEFORE the migration gets blessed
 * with it — which is why the CLI prints the membership/vote roster for review and
 * is dry-run by default.
 */
import type { Note } from "./parachute";
import { GOV_TAG_LIST, type GovTag, str } from "./governance-fields";
import { GOV_SIG_FIELD, govSigStatus, withGovSig } from "./governance-integrity";

export interface MigrationVault {
  listNotes(opts: { tags?: string[]; includeContent?: boolean }): Promise<Note[]>;
  updateNote(id: string, params: { metadata?: Record<string, unknown> }): Promise<Note>;
}

export type SignAction = "sign" | "resign" | "skip-valid" | "skip-ambiguous";

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
  written: string[];
  /** Pending (sign/resign) items after an --apply re-plan; must be empty. */
  remaining: number;
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
  secret: string,
): Promise<{ plan: SignPlanItem[]; notes: Map<string, Note> }> {
  if (!secret) throw new Error("a signing secret is required");
  const byId = await collect(vault);
  const plan: SignPlanItem[] = [];
  const notes = new Map<string, Note>();
  for (const { note, tags } of byId.values()) {
    notes.set(note.id, note);
    const tag = tags[0]!;
    if (tags.length > 1) {
      plan.push({ id: note.id, tag, tags, action: "skip-ambiguous", summary: `tagged ${tags.join(" + ")}` });
      continue;
    }
    const status = govSigStatus(tag, note, secret);
    const action: SignAction = status === "valid" ? "skip-valid" : status === "missing" ? "sign" : "resign";
    plan.push({ id: note.id, tag, tags, action, summary: summarize(tag, note.metadata) });
  }
  plan.sort((a, b) => (a.tag === b.tag ? a.id.localeCompare(b.id) : a.tag.localeCompare(b.tag)));
  return { plan, notes };
}

const pending = (p: SignPlanItem[]) => p.filter((i) => i.action === "sign" || i.action === "resign");

/** Dry run (default) or apply. Idempotent: an applied vault re-plans to zero pending. */
export async function signExistingGovernance(
  vault: MigrationVault,
  opts: { secret: string; apply: boolean },
): Promise<SignResult> {
  const { plan, notes } = await planGovernanceSigning(vault, opts.secret);
  const written: string[] = [];
  if (!opts.apply) return { plan, written, remaining: pending(plan).length };

  for (const item of pending(plan)) {
    const note = notes.get(item.id)!;
    const { [GOV_SIG_FIELD]: _old, ...meta } = note.metadata ?? {};
    await vault.updateNote(item.id, { metadata: withGovSig(item.tag, item.id, meta, note.content, opts.secret) });
    written.push(item.id);
  }
  const after = await planGovernanceSigning(vault, opts.secret);
  return { plan, written, remaining: pending(after.plan).length };
}

/**
 * The constitution in plain language — a PURE, dependency-free renderer shared by
 * the server (which writes the prose into the `governance-config` note so the
 * constitution is legible in the vault itself) and the governance UI (which shows
 * every policy as the sentence it means, never as a row of fields).
 *
 * Why one module for both: a commons whose rules are only readable as JSON is a
 * commons only its author understands. Ostrom's design principles start with
 * rules the members can actually state; so the sentence is the artifact, and the
 * form fields in the UI are just slots inside it.
 *
 * Structural typing on purpose: the server's `Policy`/`Role`/`GovernanceState`
 * satisfy these interfaces without importing anything from apps/server, and the
 * web client's `api.ts` types satisfy them too. No React, no DOM, no I/O.
 */

// ── the shapes this module reads (structurally satisfied by both sides) ───────

export interface ProsePolicy {
  id?: string;
  action: string;
  scopeType: "global" | "tag" | "note";
  scope: string;
  thresholdN: number;
  quorum: number;
  distinctRequired: boolean;
  eligibleRole: string;
  windowSeconds: number;
  autoPublish: boolean;
}

export interface ProseRole {
  id?: string;
  name: string;
  powers: string[];
  scopeType: "global" | "tag";
  scope: string;
  capabilities?: string[];
  assigns?: string[];
}

export interface ProseMembership {
  subject: string;
  role: string;
  expiresAt?: string | null;
}

export interface ProseConfig {
  enabled: boolean;
  bootstrapOwner: string;
  amendPolicy: string;
  defaultThresholdN: number;
  defaultEligibleRole: string;
}

export interface ProseState {
  config: ProseConfig;
  roles: ProseRole[];
  policies: ProsePolicy[];
  memberships?: ProseMembership[];
}

// ── vocabulary (the words the UI and the note both use) ──────────────────────

/** Content capabilities → the words a member would use for them. */
export const CAP_LABELS: Record<string, string> = {
  view: "read",
  comment: "comment",
  suggest: "suggest",
  edit: "edit existing notes",
  create: "add new notes",
  organize: "move & retag",
  delete: "delete",
  share: "share with others",
};

/** Governance powers → plain words. `amend_governance` is the constitutional one. */
export const POWER_LABELS: Record<string, string> = {
  publish: "publish",
  assign_roles: "staff other roles",
  manage_policy: "manage policy",
  invite: "invite",
  revoke: "revoke",
  amend_governance: "amend the constitution",
};

/** How the role editor groups the checkboxes. Order is the display order. */
export const CAP_GROUPS: ReadonlyArray<{ id: string; label: string; caps: readonly string[] }> = [
  { id: "content", label: "Content", caps: ["view", "comment", "suggest", "edit", "create", "organize", "delete"] },
  { id: "sharing", label: "Sharing", caps: ["share"] },
];

/** The governance powers, in the order the editor shows them. */
export const POWER_ORDER: readonly string[] = [
  "publish",
  "assign_roles",
  "manage_policy",
  "invite",
  "revoke",
  "amend_governance",
];

/** The actions a policy can govern, with the label the builder shows. */
export const ACTION_LABELS: Record<string, string> = {
  edit_note: "Edits to existing notes",
  new_entry: "New entries",
  amend_governance: "Amendments to the constitution",
};

/** Voting windows offered in the builder (seconds; 0 = no deadline). */
export const WINDOW_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: "no deadline" },
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 72 * 3600, label: "72 hours" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
  { seconds: 30 * 24 * 3600, label: "30 days" },
];

export const capLabel = (c: string): string => CAP_LABELS[c] ?? c;
export const powerLabel = (p: string): string => POWER_LABELS[p] ?? p.replace(/_/g, " ");

// ── small language helpers ───────────────────────────────────────────────────

/** "a, b and c" — an English list, no Oxford comma (matches the UI's voice). */
export function listWords(items: string[]): string {
  const xs = items.filter(Boolean);
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0] as string;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Title-case a role name and pluralize it: "gardener" → "Gardeners". */
export function pluralRole(name: string): string {
  const n = (name ?? "").trim();
  if (!n) return "the default role";
  const titled = n.charAt(0).toUpperCase() + n.slice(1);
  if (/s$/i.test(titled)) return titled;
  return `${titled}s`;
}

/** Seconds → "7 days" / "24 hours" / "90 seconds". */
export function humanWindow(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "";
  const named = WINDOW_CHOICES.find((w) => w.seconds === s);
  if (named && named.seconds > 0) return named.label;
  if (s % 86400 === 0) {
    const d = s / 86400;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  if (s % 3600 === 0) {
    const h = s / 3600;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${s} seconds`;
}

/** The subject of a policy sentence: what kind of change, over what slice. */
function subjectPhrase(policy: ProsePolicy): string {
  if (policy.action === "amend_governance") return "Amendments to the constitution";
  const where =
    policy.scopeType === "tag" && policy.scope
      ? `notes tagged #${policy.scope}`
      : policy.scopeType === "note" && policy.scope
        ? "this note"
        : "";
  if (policy.action === "edit_note") return where ? `Edits to ${where}` : "Edits anywhere";
  if (policy.action === "new_entry") return where ? `New entries in ${where}` : "New entries anywhere";
  const verb = policy.action.replace(/_/g, " ");
  return where ? `${verb} in ${where}` : `${verb} anywhere`;
}

// ── the two renderers ────────────────────────────────────────────────────────

/**
 * One policy as one sentence:
 *
 *   "Edits to notes tagged #medicine need 2 approvals from Gardeners within
 *    7 days, then go live immediately."
 *
 * `roleName` overrides the display name of the eligible role (the caller has
 * already resolved an empty `eligibleRole` against the config default).
 */
export function renderPolicySentence(policy: ProsePolicy, opts: { roleName?: string } = {}): string {
  const n = Math.max(1, Math.floor(policy.thresholdN || 1));
  const role = pluralRole(opts.roleName ?? policy.eligibleRole);
  const parts: string[] = [`${subjectPhrase(policy)} need ${n} ${n === 1 ? "approval" : "approvals"} from ${role}`];
  const window = humanWindow(policy.windowSeconds);
  if (window) parts.push(` within ${window}`);
  if (policy.quorum > 0) {
    parts.push(`, with at least ${policy.quorum} eligible ${policy.quorum === 1 ? "voter" : "voters"} taking part`);
  }
  if (!policy.distinctRequired && n > 1) parts.push(" (one person may supply more than one)");
  parts.push(policy.autoPublish ? ", then go live immediately." : ", then await publish by a publisher.");
  return parts.join("");
}

/** One role as one sentence — what its holders may touch, and what they may do. */
export function renderRoleSentence(role: ProseRole): string {
  const who = pluralRole(role.name);
  const scoped = role.scopeType === "tag" && role.scope ? ` within #${role.scope}` : " across the whole commons";
  const caps = (role.capabilities ?? []).map(capLabel);
  const powers = (role.powers ?? []).map(powerLabel);
  const assigns = (role.assigns ?? []).map(pluralRole);

  const clauses: string[] = [];
  clauses.push(caps.length ? `can ${listWords(caps)}${scoped}` : `carry no content access${scoped}`);
  if (powers.length) clauses.push(`may ${listWords(powers)}`);
  if (assigns.length) clauses.push(`staff ${listWords(assigns)}`);
  return `${who} ${listWords(clauses)}.`;
}

/** The policy that governs amendments, resolved the way the engine resolves it. */
function amendSentence(state: ProseState): string {
  const named = state.policies.find((p) => p.id && p.id === state.config.amendPolicy);
  const policy: ProsePolicy = named ?? {
    action: "amend_governance",
    scopeType: "global",
    scope: "",
    thresholdN: Math.max(1, state.config.defaultThresholdN || 1),
    quorum: 0,
    distinctRequired: true,
    eligibleRole: state.config.defaultEligibleRole,
    windowSeconds: 0,
    autoPublish: false,
  };
  return renderPolicySentence(policy, { roleName: policy.eligibleRole || state.config.defaultEligibleRole });
}

/**
 * The whole constitution as a readable markdown page — the body the server
 * writes into the `governance-config` note after every change.
 *
 * Deliberately CONTAINS NO EMAILS. The roster is queryable by any member through
 * /api/governance/memberships; the prose is the shareable artifact, and a
 * shareable artifact should not carry a membership list of addresses.
 */
export function renderConstitution(state: ProseState): string {
  const { config, roles, policies } = state;
  const memberships = state.memberships ?? [];
  const out: string[] = [];

  out.push("# Governance Constitution", "");
  out.push(
    config.enabled
      ? "**Ratified and locked.** Every change — including turning governance off — now requires an approved amendment."
      : "**Draft — not yet ratified.** The bootstrap owner may still configure this directly; nothing here affects access until it is enabled.",
  );
  out.push("");
  out.push(amendSentence(state));
  out.push("");

  out.push("## Roles", "");
  if (roles.length === 0) {
    out.push("_No roles defined yet._", "");
  } else {
    for (const r of roles) {
      const held = memberships.filter((m) => m.role === r.id || m.role === r.name).length;
      out.push(`### ${r.name}`, "");
      out.push(renderRoleSentence(r));
      out.push(`Held by ${held} ${held === 1 ? "member" : "members"}.`, "");
    }
  }

  out.push("## Policies", "");
  if (policies.length === 0) {
    out.push("_No policies defined yet — changes fall back to the constitutional default._", "");
  } else {
    for (const p of policies) {
      out.push(`- ${renderPolicySentence(p, { roleName: p.eligibleRole || config.defaultEligibleRole })}`);
    }
    out.push("");
  }

  out.push("## Membership", "");
  if (memberships.length === 0) {
    out.push("_Nobody holds a role yet._", "");
  } else {
    const counts = new Map<string, number>();
    for (const m of memberships) {
      const role = roles.find((r) => r.id === m.role || r.name === m.role);
      const key = role?.name ?? m.role;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [name, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`- ${pluralRole(name)} — ${count} ${count === 1 ? "member" : "members"}`);
    }
    out.push("");
  }

  out.push("---", "");
  out.push("_Generated from the governance notes. Edits to this page are overwritten on the next change._");
  return out.join("\n");
}

/**
 * Which policy actually governs an action in a context — mirrored from the
 * engine's `selectPolicy` so the UI can warn about overlap without a round trip.
 * note (3) > tag (2) > global (1); ties go to the STRICTER threshold. Returns
 * the winner and every other candidate it beat.
 */
export function resolvePolicyConflict(
  policies: ProsePolicy[],
  action: string,
  ctx: { noteId?: string; tags?: string[] } = {},
): { winner: ProsePolicy | null; shadowed: ProsePolicy[] } {
  const rank = (p: ProsePolicy): number => {
    if (p.action !== action) return 0;
    if (p.scopeType === "note") return p.scope && p.scope === ctx.noteId ? 3 : 0;
    if (p.scopeType === "tag") return p.scope && (ctx.tags ?? []).includes(p.scope) ? 2 : 0;
    return 1;
  };
  const candidates = policies.filter((p) => rank(p) > 0);
  let winner: ProsePolicy | null = null;
  let best = 0;
  for (const p of candidates) {
    const r = rank(p);
    if (r > best || (r === best && winner !== null && p.thresholdN > winner.thresholdN)) {
      winner = p;
      best = r;
    }
  }
  return { winner, shadowed: candidates.filter((p) => p !== winner) };
}

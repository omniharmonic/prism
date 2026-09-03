/**
 * Thin typed client for the commons-governance gateway (/api/governance).
 * Same-origin, session-cookie authed (credentials: "include") — the browser
 * holds no token, exactly like the rest of the web shell. Dependency-free
 * `fetch` on purpose: the governance surface mounts both inside the app shell
 * (Network → Governance) and standalone at /governance, where no query client,
 * VaultClient or provider tree exists.
 */
export interface GovConfig {
  enabled: boolean;
  bootstrapOwner: string;
  amendPolicy: string;
  defaultThresholdN: number;
  defaultEligibleRole: string;
}
export interface Role {
  id: string;
  name: string;
  powers: string[];
  scopeType: "global" | "tag";
  scope: string;
  /** Content capabilities every active holder receives (P2). */
  capabilities: string[];
  /** Role names this role's holders may staff without an amendment. */
  assigns: string[];
}
export interface Policy {
  id: string;
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
export interface Proposal {
  id: string;
  action: string;
  target: string;
  state: "open" | "approved" | "rejected" | "applied" | "withdrawn";
  openedBy: string;
  openedAt: string;
}
export interface Membership {
  subject: string;
  role: string;
  grantedBy?: string;
  expiresAt?: string | null;
}
export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  before: string;
  after: string;
  at: string;
}
export interface GovState {
  enabled: boolean;
  locked: boolean;
  config: GovConfig;
  roles: Role[];
  policies: Policy[];
  myPowers: string[];
  isBootstrapOwner: boolean;
}

/** A cast vote, as the proposal detail returns it. */
export interface Vote {
  proposal: string;
  voter: string;
  vote: "approve" | "reject";
  at: string;
  reason?: string;
}

/** The engine's verdict on a proposal — drives the progress bar. */
export interface Evaluation {
  policy: Policy;
  satisfied: boolean;
  approvals: number;
  needed: number;
  quorumMet: boolean;
  participation: number;
  eligibleApprovers: string[];
}

export interface ProposalDetail {
  proposal: Proposal;
  votes: Vote[];
  evaluation: Evaluation;
  /** The proposed change itself — a GovChange for amendments, a ContentPayload
   *  for edit_note/new_entry. Untyped on purpose: the panel narrows it. */
  payload?: unknown;
}

/** One effective content grant, as GET /me reports it. */
export interface MyGrant {
  resource_type: string;
  resource: string;
  level: string;
  caps: string[];
  /** "governance:<roleId>" when the constitution granted it, else "direct". */
  source: string;
  expiresAt: number | null;
}

export interface MyAccess {
  subject: string;
  workspaceRole: string;
  powers: string[];
  memberships: Membership[];
  grants: MyGrant[];
}

export interface Revision {
  id: string;
  note: string;
  parent: string;
  proposal: string;
  author: string;
  origin: "proposal" | "rollback" | "publish";
  published: boolean;
  at: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  error?: string;
}

const BASE = "/api/governance";

async function request<T = unknown>(url: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const err = !res.ok
    ? ((data as { detail?: string } | null)?.detail ??
      (data as { error?: string } | null)?.error ??
      `HTTP ${res.status}`)
    : undefined;
  return { status: res.status, ok: res.ok, data: data as T, error: err };
}

const call = <T = unknown>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> =>
  request<T>(BASE + path, method, body);

/** The payload shape a role write accepts (POST /roles, PATCH /roles/:ref). */
export type RoleInput = Partial<Omit<Role, "id">>;
/** The payload shape a policy write accepts. */
export type PolicyInput = Partial<Omit<Policy, "id">>;

export const govApi = {
  state: () => call<GovState>("/state"),
  me: () => call<MyAccess>("/me"),
  memberships: () => call<{ memberships: Membership[] }>("/memberships"),
  audit: () => call<{ audit: AuditEntry[] }>("/audit"),
  proposals: () => call<{ proposals: Proposal[] }>("/proposals"),
  proposal: (id: string) => call<ProposalDetail>(`/proposals/${encodeURIComponent(id)}`),

  // ── constitution writes (pre-lock direct; post-lock these 403 requires_proposal)
  addRole: (b: RoleInput) => call<{ note?: { id: string } }>("/roles", "POST", b),
  updateRole: (ref: string, b: RoleInput) => call(`/roles/${encodeURIComponent(ref)}`, "PATCH", b),
  removeRole: (ref: string) => call(`/roles/${encodeURIComponent(ref)}`, "DELETE"),
  addPolicy: (b: PolicyInput) => call<{ note?: { id: string } }>("/policies", "POST", b),
  updatePolicy: (ref: string, b: PolicyInput) => call(`/policies/${encodeURIComponent(ref)}`, "PATCH", b),
  removePolicy: (ref: string) => call(`/policies/${encodeURIComponent(ref)}`, "DELETE"),
  addMembership: (b: { subject: string; role: string; expiresAt?: string }) => call("/memberships", "POST", b),
  removeMembership: (b: { subject: string; role: string }) => call("/memberships", "DELETE", b),
  setConfig: (b: Partial<GovConfig>) => call<{ ok: boolean }>("/config", "POST", b),

  // ── proposals
  openProposal: (b: { action: string; target: string; payload: string }) =>
    call<{ id: string }>("/proposals", "POST", b),
  proposeContent: (b: {
    action: "edit_note" | "new_entry";
    target?: string;
    content?: string;
    tags?: string[];
    path?: string;
  }) => call<{ id: string }>("/content/propose", "POST", b),
  vote: (id: string, vote: "approve" | "reject", reason?: string) =>
    call(`/proposals/${encodeURIComponent(id)}/vote`, "POST", { vote, reason }),
  apply: (id: string) => call<{ published?: boolean }>(`/proposals/${encodeURIComponent(id)}/apply`, "POST"),
  publish: (id: string) => call(`/proposals/${encodeURIComponent(id)}/publish`, "POST"),
  withdraw: (id: string) => call(`/proposals/${encodeURIComponent(id)}/withdraw`, "POST"),

  // ── revisions / fork
  revisions: (noteId: string) => call<{ revisions: Revision[] }>(`/notes/${encodeURIComponent(noteId)}/revisions`),
  rollback: (noteId: string, revision: string) =>
    call(`/notes/${encodeURIComponent(noteId)}/rollback`, "POST", { revision }),
  fork: (noteId: string) => call<{ id: string; forkedFrom: string }>("/fork", "POST", { noteId }),
  proposeMerge: (forkId: string) =>
    call<{ proposalId: string; target: string }>(`/forks/${encodeURIComponent(forkId)}/propose-merge`, "POST"),

  // ── neighbours the panel reads for context (NOT under /api/governance) ───────
  /** Vault tags for the scope pickers. Filtered server-side to what you may see. */
  tags: () => request<Array<{ tag: string; count: number }>>("/api/tags"),
  /** The target note of an edit_note proposal, for the diff. 403 for non-owners. */
  note: (id: string) => request<{ id: string; content: string }>(`/api/notes/${encodeURIComponent(id)}`),
  /** Known account emails, for the member datalist. 403s for non-admins — the
   *  caller falls back to a plain text input, silently. */
  users: () => request<Array<{ email: string; name: string | null }>>("/acl/users"),
};

/**
 * Thin typed client for the commons-governance gateway (/api/governance).
 * Same-origin, session-cookie authed (credentials: "include") — the browser
 * holds no token, exactly like the rest of the web shell.
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

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  error?: string;
}

const BASE = "/api/governance";

async function call<T = unknown>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(BASE + path, {
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
    ? (data as { detail?: string; error?: string } | null)?.detail ??
      (data as { error?: string } | null)?.error ??
      `HTTP ${res.status}`
    : undefined;
  return { status: res.status, ok: res.ok, data: data as T, error: err };
}

export const govApi = {
  state: () => call<GovState>("/state"),
  memberships: () => call<{ memberships: Membership[] }>("/memberships"),
  audit: () => call<{ audit: AuditEntry[] }>("/audit"),
  proposals: () => call<{ proposals: Proposal[] }>("/proposals"),
  addRole: (b: Partial<Role>) => call("/roles", "POST", b),
  addPolicy: (b: Partial<Policy>) => call("/policies", "POST", b),
  addMembership: (b: { subject: string; role: string; expiresAt?: string }) => call("/memberships", "POST", b),
  setConfig: (b: Partial<GovConfig>) => call("/config", "POST", b),
  openProposal: (b: { action: string; target: string; payload: string }) => call<{ id: string }>("/proposals", "POST", b),
  proposeContent: (b: { action: "edit_note" | "new_entry"; target?: string; content?: string; tags?: string[]; path?: string }) =>
    call<{ id: string }>("/content/propose", "POST", b),
  vote: (id: string, vote: "approve" | "reject", reason?: string) =>
    call(`/proposals/${encodeURIComponent(id)}/vote`, "POST", { vote, reason }),
  apply: (id: string) => call<{ published?: boolean }>(`/proposals/${encodeURIComponent(id)}/apply`, "POST"),
  publish: (id: string) => call(`/proposals/${encodeURIComponent(id)}/publish`, "POST"),
  withdraw: (id: string) => call(`/proposals/${encodeURIComponent(id)}/withdraw`, "POST"),
  revisions: (noteId: string) => call<{ revisions: Revision[] }>(`/notes/${encodeURIComponent(noteId)}/revisions`),
  rollback: (noteId: string, revision: string) =>
    call(`/notes/${encodeURIComponent(noteId)}/rollback`, "POST", { revision }),
  fork: (noteId: string) => call<{ id: string; forkedFrom: string }>("/fork", "POST", { noteId }),
  proposeMerge: (forkId: string) =>
    call<{ proposalId: string; target: string }>(`/forks/${encodeURIComponent(forkId)}/propose-merge`, "POST"),
};

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

/**
 * The approval gate (integration-contract.md § 6). INVARIANT: the model can only
 * PROPOSE; an outward action happens only after a human decision from a signed-in
 * session or device, bound to the exact payload the person saw (its digest).
 *
 *  - Propose: Hermes' `omni-bridge` plugin posts `{kind, payload}` to the loopback
 *    hook (service token). The payload is validated per kind, canonicalised and
 *    hashed; it is stored IN FULL (the app shows it untruncated). Nothing is sent.
 *  - Edit: a human replaces the payload → a NEW approval (new digest); the old one
 *    becomes `revised`.
 *  - Decide: `send` needs the current digest (a stale screen is refused), a human
 *    origin and an Idempotency-Key; the approval is CLAIMED (`approved`) atomically,
 *    so two taps can never execute twice. Execution goes ONLY through Prism's existing
 *    guarded executors (live actions, behind ACTIONS_*_ENABLED) — this module has no
 *    sender of its own. A disabled executor leaves the approval `pending` and answers
 *    `executor_disabled`.
 *
 * KIND `command` is different in one way: it is not a draft to send but ONE TOOL CALL of
 * a Hermes turn that the `omni-bridge` plugin paused (a shell command that would reach the
 * network, a write outside the workspace, a scheduled job…). Nothing here executes it.
 * `send` = "Approve once": the approval becomes `approved`, the plugin — which is holding
 * that exact call and polls the hook — lets it run, then reports how it ended (`sent` =
 * it ran, `failed` = it ran and failed). Deny, expiry and the end of the turn all leave
 * the call un-run. It cannot be edited: the person approves the call as written or not at all.
 */
import { createHash } from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { newId } from "./store";
import { omniConfig } from "./config";
import { protonSendConfigured } from "./proton-send";

export const APPROVAL_KINDS = ["email", "email-reply", "message", "calendar-invite", "tweet", "wallet-proposal", "command"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type ApprovalStatus = "pending" | "approved" | "sent" | "failed" | "unknown" | "expired" | "cancelled" | "revised";

export class ApprovalInputError extends Error {}

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_COMMAND_INPUT_BYTES = 64 * 1024;
const MAX_SUMMARY = 300;

/** Stable JSON: object keys sorted at every depth (the digest must not depend on key order). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
/** The digest the app must echo back: SHA-256 (hex) of `{"kind":…,"payload":…}` canonical JSON. */
export const approvalDigest = (kind: string, payload: unknown): string =>
  createHash("sha256").update(canonicalJson({ kind, payload }), "utf8").digest("hex");

const str = (v: unknown, field: string, max: number, required = true): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ApprovalInputError(`${field}: required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ApprovalInputError(`${field}: must be a string`);
  if (v.length > max) throw new ApprovalInputError(`${field}: too long`);
  return v;
};
const strList = (v: unknown, field: string, max: number, required = false): string[] | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new ApprovalInputError(`${field}: required`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length > 320) || v.length > max) throw new ApprovalInputError(`${field}: a list of at most ${max} strings`);
  if (required && v.length === 0) throw new ApprovalInputError(`${field}: at least one entry`);
  return v as string[];
};
const pick = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Shape check per kind (the executor validates again, strictly, at send time). Only the
 * listed fields survive — an extra key the app never displayed cannot ride along.
 */
export function validatePayload(kind: unknown, raw: unknown): { kind: ApprovalKind; payload: Record<string, unknown> } {
  if (typeof kind !== "string" || !(APPROVAL_KINDS as readonly string[]).includes(kind)) throw new ApprovalInputError(`kind: one of ${APPROVAL_KINDS.join(", ")}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApprovalInputError("payload: an object is required");
  const b = raw as Record<string, unknown>;
  let payload: Record<string, unknown>;
  switch (kind as ApprovalKind) {
    case "email":
      payload = pick({ to: strList(b.to, "to", 20, true), cc: strList(b.cc, "cc", 20), subject: str(b.subject, "subject", 998), body: str(b.body, "body", 200_000) });
      break;
    case "email-reply":
      payload = pick({ noteId: str(b.noteId, "noteId", 200), expectTo: strList(b.expectTo, "expectTo", 20, true), cc: strList(b.cc, "cc", 20), body: str(b.body, "body", 200_000) });
      break;
    case "message":
      payload = pick({ roomId: str(b.roomId, "roomId", 255), body: str(b.body, "body", 60_000) });
      break;
    case "calendar-invite":
      payload = pick({
        title: str(b.title, "title", 1024),
        start: str(b.start, "start", 64),
        end: str(b.end, "end", 64),
        attendees: strList(b.attendees, "attendees", 50),
        location: str(b.location, "location", 1024, false),
        description: str(b.description, "description", 8192, false),
      });
      break;
    case "tweet":
      payload = pick({ text: str(b.text, "text", 4000) });
      break;
    case "wallet-proposal":
      payload = pick({
        to: str(b.to, "to", 100),
        amount: str(b.amount, "amount", 64),
        token: str(b.token, "token", 32, false),
        chain: str(b.chain, "chain", 32),
        purpose: str(b.purpose, "purpose", 1000),
      });
      break;
    case "command": {
      // One paused tool call, exactly as it would run. A shell command carries `command`
      // (+ where); any other tool its whole `input`. Neither is ever shortened: what is
      // approved is what the digest covers.
      const input = b.input;
      if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) throw new ApprovalInputError("input: an object");
      if (input !== undefined && Buffer.byteLength(canonicalJson(input), "utf8") > MAX_COMMAND_INPUT_BYTES) throw new ApprovalInputError("input: too large to review");
      const command = str(b.command, "command", 100_000, false);
      if (command === undefined && input === undefined) throw new ApprovalInputError("command or input: required");
      const origin = str(b.origin, "origin", 20, false);
      if (origin !== undefined && !["subagent", "cron"].includes(origin)) throw new ApprovalInputError("origin: subagent | cron");
      payload = pick({
        tool: str(b.tool, "tool", 200),
        command,
        cwd: str(b.cwd, "cwd", 2000, false),
        input: input as Record<string, unknown> | undefined,
        reason: str(b.reason, "reason", 1000),
        rule: str(b.rule, "rule", 100),
        title: str(b.title, "title", 300, false),
        origin,
      });
      break;
    }
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) throw new ApprovalInputError("payload: too large");
  return { kind: kind as ApprovalKind, payload };
}

export interface Approval {
  id: string;
  threadId: string | null;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  digest: string;
  summary: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedVia: string | null;
  result: Record<string, unknown> | null;
  supersededBy: string | null;
  revises: string | null;
}
type Raw = {
  id: string; owner_email: string; thread_id: string | null; kind: string; payload_hash: string; payload: string; summary: string | null;
  status: string; created_at: number; expires_at: number; decided_at: number | null; decided_via: string | null; decided_device: string | null;
  idem_key: string | null; result: string | null; superseded_by: string | null; revises: string | null;
};
const toApproval = (r: Raw): Approval => ({
  id: r.id, threadId: r.thread_id, kind: r.kind as ApprovalKind, payload: JSON.parse(r.payload) as Record<string, unknown>, digest: r.payload_hash,
  summary: r.summary, status: r.status as ApprovalStatus, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at,
  decidedVia: r.decided_via, result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null, supersededBy: r.superseded_by, revises: r.revises,
});

const q = {
  ins: db.prepare(
    "INSERT INTO omni_approvals (id, owner_email, thread_id, kind, payload_hash, payload, summary, status, created_at, expires_at, revises) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
  ),
  get: db.prepare("SELECT * FROM omni_approvals WHERE id = ? AND owner_email = ?"),
  list: db.prepare("SELECT * FROM omni_approvals WHERE owner_email = ? ORDER BY created_at DESC LIMIT ?"),
  listStatus: db.prepare("SELECT * FROM omni_approvals WHERE owner_email = ? AND status = ? ORDER BY created_at DESC LIMIT ?"),
  byThread: db.prepare("SELECT * FROM omni_approvals WHERE thread_id = ? ORDER BY created_at DESC LIMIT 50"),
  expire: db.prepare("UPDATE omni_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?"),
  claim: db.prepare(
    "UPDATE omni_approvals SET status = 'approved', decided_at = ?, decided_via = ?, decided_device = ?, idem_key = ? WHERE id = ? AND status = 'pending' AND payload_hash = ? AND expires_at > ?",
  ),
  unclaim: db.prepare("UPDATE omni_approvals SET status = 'pending', decided_at = NULL, decided_via = NULL, decided_device = NULL, idem_key = NULL WHERE id = ? AND status = 'approved'"),
  finish: db.prepare("UPDATE omni_approvals SET status = ?, result = ? WHERE id = ? AND status = 'approved'"),
  close: db.prepare("UPDATE omni_approvals SET status = ?, decided_at = ?, decided_via = ?, decided_device = ?, idem_key = ?, superseded_by = ? WHERE id = ? AND status = 'pending'"),
  pendingCommands: db.prepare("SELECT * FROM omni_approvals WHERE thread_id = ? AND kind = 'command' AND status = 'pending' AND created_at >= ?"),
  staleCommands: db.prepare("UPDATE omni_approvals SET status = 'unknown', result = ? WHERE kind = 'command' AND status = 'approved' AND decided_at <= ?"),
};

export function createApproval(o: { owner: string; threadId: string | null; kind: ApprovalKind; payload: Record<string, unknown>; summary?: string | null; ttlMs: number; revises?: string | null }): Approval {
  const id = newId("apr");
  const now = Date.now();
  const summary = typeof o.summary === "string" ? o.summary.replace(/[\r\n]+/g, " ").slice(0, MAX_SUMMARY) : null;
  q.ins.run(id, o.owner, o.threadId, o.kind, approvalDigest(o.kind, o.payload), JSON.stringify(o.payload), summary, now, now + o.ttlMs, o.revises ?? null);
  return getApproval(o.owner, id)!;
}
/** Expire overdue pending approvals (lazy: called before every read/decision). An approved
 *  command whose call never reported back (Hermes died mid-call) becomes `unknown`. */
export const expireApprovals = (): number => {
  q.staleCommands.run(JSON.stringify({ error: "no_report", executor: "hermes-turn" }), Date.now() - COMMAND_REPORT_MS);
  return q.expire.run(Date.now(), Date.now()).changes;
};
/** How long an approved command may run before the lack of a report means "unknown". */
const COMMAND_REPORT_MS = 2 * 60 * 60_000;
/** The command approvals a turn left pending (asked since `sinceMs`, not by a cron job). */
export function pendingTurnCommands(threadId: string, sinceMs: number): Approval[] {
  return (q.pendingCommands.all(threadId, sinceMs) as Raw[]).map(toApproval).filter((a) => a.payload.origin !== "cron");
}
export function getApproval(owner: string, id: string): Approval | null {
  const r = q.get.get(id, owner) as Raw | undefined;
  return r ? toApproval(r) : null;
}
export function rawIdemKey(owner: string, id: string): string | null {
  return ((q.get.get(id, owner) as Raw | undefined)?.idem_key) ?? null;
}
export function listApprovals(owner: string, status: ApprovalStatus | null, limit = 100): Approval[] {
  const rows = (status ? q.listStatus.all(owner, status, limit) : q.list.all(owner, limit)) as Raw[];
  return rows.map(toApproval);
}
export const threadApprovals = (threadId: string): Approval[] => (q.byThread.all(threadId) as Raw[]).map(toApproval);
/** Claim for execution: only a pending, unexpired approval whose digest matches. */
export const claimApproval = (id: string, digest: string, via: string, device: string | null, key: string): boolean =>
  q.claim.run(Date.now(), via, device, key, id, digest, Date.now()).changes > 0;
/** Put a claimed approval back (the executor provably did nothing — e.g. disabled). */
export const unclaimApproval = (id: string): void => void q.unclaim.run(id);
export const finishApproval = (id: string, status: "sent" | "failed" | "unknown", result: Record<string, unknown>): void =>
  void q.finish.run(status, JSON.stringify(result), id);
export const closeApproval = (id: string, status: "cancelled" | "revised", via: string, device: string | null, key: string | null, supersededBy: string | null = null): boolean =>
  q.close.run(status, Date.now(), via, device, key, supersededBy, id).changes > 0;

/** The wire shape (the full payload: the app must show it untruncated). */
export function approvalView(a: Approval): Record<string, unknown> {
  return {
    id: a.id,
    threadId: a.threadId,
    kind: a.kind,
    payload: a.payload,
    digest: a.digest,
    summary: a.summary,
    status: a.status,
    createdAt: new Date(a.createdAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
    decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
    decidedVia: a.decidedVia,
    result: a.result,
    supersededBy: a.supersededBy,
    revises: a.revises,
    executor: executorFor(a.kind),
  };
}

// ── executors ───────────────────────────────────────────────────────────────

/** Which existing guarded executor runs a kind, and whether it is switched on. */
export function executorFor(kind: ApprovalKind): { name: string; available: boolean; enabled: boolean } {
  const e = executorOf(kind);
  // OMNI_EXECUTORS=off wins over every family flag: nothing Omni proposes can be sent. A
  // `command` is not a send (Hermes runs its own paused call); it has its own switch.
  return omniConfig.executorsOff() && kind !== "command" ? { ...e, enabled: false } : e;
}
function executorOf(kind: ApprovalKind): { name: string; available: boolean; enabled: boolean } {
  switch (kind) {
    case "command":
      // Not a sender: Hermes itself runs the call it paused. OMNI_COMMAND_APPROVALS=off
      // makes every such call un-approvable (it then never runs).
      return { name: "hermes-turn", available: true, enabled: !omniConfig.commandApprovalsOff() };
    case "email":
    case "email-reply":
      return omniConfig.emailExecutor() === "proton-send"
        ? { name: "proton-send", available: true, enabled: protonSendConfigured() }
        : { name: "prism-live-actions:email", available: true, enabled: config.actionsEmailEnabled };
    case "calendar-invite":
      return { name: "prism-live-actions:calendar", available: true, enabled: config.actionsCalendarEnabled };
    case "message":
      return { name: "prism-live-actions:matrix", available: true, enabled: config.actionsMatrixEnabled };
    default:
      // tweet / wallet-proposal: their executors (twitter_post.py, wallet.py propose) live in the
      // agent repo and are not wired to this gateway yet.
      return { name: "none", available: false, enabled: false };
  }
}

/** The live-action route + body for an approval. */
export function liveActionRequest(kind: ApprovalKind, p: Record<string, unknown>): { path: string; body: Record<string, unknown> } | null {
  switch (kind) {
    case "email":
      return { path: "/api/actions/email/send", body: pick({ to: p.to, cc: p.cc, subject: p.subject, body: p.body }) };
    case "email-reply":
      return { path: "/api/actions/email/reply", body: pick({ noteId: p.noteId, expectTo: p.expectTo, cc: p.cc, body: p.body }) };
    case "message":
      return { path: "/api/actions/matrix/send", body: { roomId: p.roomId, body: p.body } };
    case "calendar-invite":
      return { path: "/api/actions/calendar/create", body: pick({ title: p.title, start: p.start, end: p.end, attendees: p.attendees, location: p.location, description: p.description }) };
    default:
      return null;
  }
}

/** Outcome of one execution attempt. `not_sent` = provably nothing left the server. */
export type ExecOutcome =
  | { status: "sent"; detail: Record<string, unknown> }
  | { status: "failed"; detail: Record<string, unknown> }
  | { status: "unknown"; detail: Record<string, unknown> }
  | { status: "disabled"; detail: Record<string, unknown> };

/**
 * Run the approved request through an in-process call to the live-actions route,
 * carrying the deciding person's OWN credential (cookie / device bearer), so every
 * live-action gate applies unchanged: server owner, family flag, validation, HUMAN
 * origin (the credential is a session/device), idempotency (key = the approval id)
 * and the action audit.
 */
export type Executor = (o: { kind: ApprovalKind; payload: Record<string, unknown>; approvalId: string; headers: Record<string, string> }) => Promise<ExecOutcome>;

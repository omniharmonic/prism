/**
 * Transcript ↔ meeting link decisions (manual review + the calendar worker).
 *
 * The journal (transcript-links-store.ts) is the authority; the notes are a
 * projection of it that this module converges:
 *   meeting    metadata.transcriptNoteIds (plural, the union), legacy singular
 *              metadata.transcriptNoteId, typed link `has-transcript` → transcript
 *   transcript metadata.meetingNoteId
 *
 * Automatic and manual decisions for one transcript are serialized by a keyed
 * lock. A decision is journaled in one SQLite transaction and then applied note
 * by note; the vault has no multi-note write, so every step re-authorizes,
 * re-reads, skips when the note is already in the desired state and otherwise
 * PATCHes merge-only keys with `if_updated_at` = the value just read. Anything
 * left undone stays `pending` and is completed by an identical retry (manual) or
 * the worker sweep (automatic). A note is never deleted, and content, tags and
 * unrelated metadata are never written.
 */
import { createHash } from "node:crypto";
import { vaultClient, VaultConflictError, type Note, type NoteLinkInput } from "./parachute";
import {
  acceptDecision,
  findDecision,
  getLinkState,
  isSuppressed,
  journalTranscriptsFor,
  linkScope,
  markDecisionApplied,
  pendingDecisions,
  setDecisionStep,
  type DecisionRow,
  type LinkScope,
} from "./transcript-links-store";

export const HAS_TRANSCRIPT = "has-transcript";
export const WORKER_ACTOR = "worker";

export type LinkErrorCode = "not_found" | "forbidden" | "stale" | "request_reused" | "superseded" | "vault_changed";
export class TranscriptLinkError extends Error {
  constructor(readonly code: LinkErrorCode) {
    super(code);
  }
}

/** The vault surface this module uses. */
export interface LinkVault {
  getNote(id: string, opts?: { includeLinks?: boolean }): Promise<Note>;
  updateNote(
    id: string,
    p: { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; ifUpdatedAt?: string },
  ): Promise<Note>;
}

/** Throws TranscriptLinkError when the CURRENT actor may not do `need` on `note`. */
export type LinkAuthorize = (note: Note, need: "view" | "edit") => void;

let wrapVault: ((v: LinkVault, vaultId: string) => LinkVault) | null = null;
/** Tests only: wrap the vault (fault injection, interleaving). */
export function setTranscriptLinkVaultForTests(wrap: ((v: LinkVault, vaultId: string) => LinkVault) | null): void {
  wrapVault = wrap;
}
const vaultFor = (vaultId: string): LinkVault => {
  const v = vaultClient(vaultId) as LinkVault;
  return wrapVault ? wrapVault(v, vaultId) : v;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x))] : []);
const is404 = (e: unknown): boolean => (e as { status?: number })?.status === 404;
const hasTag = (n: Note, tag: string): boolean => (n.tags ?? []).includes(tag);

/** Typed `has-transcript` partners of a note, in either direction. */
function typedPartners(n: Note): string[] {
  const out: string[] = [];
  for (const l of n.links ?? []) {
    if (l.relationship !== HAS_TRANSCRIPT) continue;
    if (l.sourceId === n.id) out.push(l.targetId);
    else if (l.targetId === n.id) out.push(l.sourceId);
  }
  return out;
}

/** Every transcript id a meeting note itself claims: singular, plural, typed link. */
export function meetingTranscriptIds(meeting: Note): string[] {
  const md = meeting.metadata ?? {};
  const singular = str(md.transcriptNoteId);
  return [...new Set([...(singular ? [singular] : []), ...idList(md.transcriptNoteIds), ...typedPartners(meeting)])];
}

/** The meeting a transcript is linked to: the journal first, then its backpointer. */
export function currentMeetingOf(scope: LinkScope, transcript: Note): string | null {
  return getLinkState(scope, transcript.id)?.meeting_id || str(transcript.metadata?.meetingNoteId);
}

export function decisionRevision(scope: LinkScope, transcriptId: string): number {
  return getLinkState(scope, transcriptId)?.revision ?? 0;
}

export { journalTranscriptsFor, linkScope };
export type { LinkScope };

// ── per-transcript critical section ──────────────────────────────────────────

const locks = new Map<string, Promise<void>>();
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
const lockKey = (s: LinkScope, transcriptId: string) => `${s.vaultId}\n${s.identity}\n${transcriptId}`;

// ── convergence ──────────────────────────────────────────────────────────────

type Patch = { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] } };

interface Ctx {
  scope: LinkScope;
  vault: LinkVault;
  authorize: LinkAuthorize;
}

/** The registry entry must still be the one this decision was journaled under. */
function assertScope(scope: LinkScope): void {
  const now = linkScope(scope.vaultId);
  if (!now || now.identity !== scope.identity) throw new TranscriptLinkError("vault_changed");
}

/**
 * Bring one note to its desired state: authorize → read → plan → CAS write.
 * `plan` returns null when the note already is as desired (nothing is written).
 * One re-read + retry on a CAS conflict; anything else propagates.
 */
async function ensure(ctx: Ctx, noteId: string, plan: (note: Note) => Promise<Patch | null> | Patch | null, missingOk = false): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    assertScope(ctx.scope);
    let note: Note;
    try {
      note = await ctx.vault.getNote(noteId, { includeLinks: true });
    } catch (e) {
      if (missingOk && is404(e)) return;
      throw e;
    }
    ctx.authorize(note, "edit");
    const patch = await plan(note);
    if (!patch) return;
    if (!note.updatedAt) throw new Error("revision_unavailable");
    // Fresh grants + registry identity immediately before the write.
    ctx.authorize(note, "edit");
    assertScope(ctx.scope);
    try {
      await ctx.vault.updateNote(noteId, { ...patch, ifUpdatedAt: note.updatedAt });
      return;
    } catch (e) {
      if (e instanceof VaultConflictError && attempt === 0) continue;
      throw e;
    }
  }
}

/** A meeting's singular pointer is replaceable when it is empty or dangling. */
async function singularReplaceable(ctx: Ctx, meetingId: string, singular: string | null, transcriptId: string): Promise<boolean> {
  if (!singular) return true;
  if (singular === transcriptId) return false;
  const st = getLinkState(ctx.scope, singular);
  if (st && st.meeting_id !== meetingId) return true; // the journal says it is no longer this meeting's
  try {
    await ctx.vault.getNote(singular);
    return false;
  } catch (e) {
    if (is404(e)) return true;
    throw e;
  }
}

function attachPlan(ctx: Ctx, transcriptId: string, stamp: { origin: string; evidence: string[] }) {
  return async (m: Note): Promise<Patch | null> => {
    const md = m.metadata ?? {};
    const singular = str(md.transcriptNoteId);
    const plural = idList(md.transcriptNoteIds);
    const replace = await singularReplaceable(ctx, m.id, singular, transcriptId);
    const want = [...new Set([...(singular && !replace ? [singular] : []), ...plural, transcriptId])];
    const metadata: Record<string, unknown> = {};
    if (JSON.stringify(want) !== JSON.stringify(Array.isArray(md.transcriptNoteIds) ? md.transcriptNoteIds : null)) metadata.transcriptNoteIds = want;
    if (replace) {
      metadata.transcriptNoteId = transcriptId;
      metadata.transcriptLinkOrigin = stamp.origin;
      metadata.transcriptLinkEvidence = stamp.evidence;
    }
    const typed = (m.links ?? []).some((l) => l.relationship === HAS_TRANSCRIPT && l.sourceId === m.id && l.targetId === transcriptId);
    const patch: Patch = {};
    if (Object.keys(metadata).length) patch.metadata = metadata;
    if (!typed) patch.links = { add: [{ target: transcriptId, relationship: HAS_TRANSCRIPT }] };
    return patch.metadata || patch.links ? patch : null;
  };
}

function detachPlan(transcriptId: string) {
  return (m: Note): Patch | null => {
    const md = m.metadata ?? {};
    const singular = str(md.transcriptNoteId);
    const plural = idList(md.transcriptNoteIds);
    const typed = (m.links ?? []).some((l) => l.relationship === HAS_TRANSCRIPT && l.sourceId === m.id && l.targetId === transcriptId);
    const metadata: Record<string, unknown> = {};
    const rest = plural.filter((id) => id !== transcriptId);
    if (plural.includes(transcriptId)) metadata.transcriptNoteIds = rest.length ? rest : null;
    if (singular === transcriptId) {
      // Re-point the legacy pointer at another remaining recording, else clear it.
      const other = rest[0] ?? typedPartners(m).find((id) => id !== transcriptId) ?? null;
      metadata.transcriptNoteId = other;
      metadata.transcriptLinkOrigin = null;
      metadata.transcriptLinkEvidence = null;
    }
    const patch: Patch = {};
    if (Object.keys(metadata).length) patch.metadata = metadata;
    if (typed) patch.links = { remove: [{ target: transcriptId, relationship: HAS_TRANSCRIPT }] };
    return patch.metadata || patch.links ? patch : null;
  };
}

/** Transcript side: point at `meetingId` (or clear), dropping reverse typed links to `leaving`. */
function pointPlan(meetingId: string | null, leaving: string | null) {
  return (t: Note): Patch | null => {
    const back = str(t.metadata?.meetingNoteId);
    const patch: Patch = {};
    if (meetingId) {
      if (back !== meetingId) patch.metadata = { meetingNoteId: meetingId };
    } else if (back && back === leaving) patch.metadata = { meetingNoteId: null };
    if (leaving && (t.links ?? []).some((l) => l.relationship === HAS_TRANSCRIPT && l.sourceId === t.id && l.targetId === leaving))
      patch.links = { remove: [{ target: leaving, relationship: HAS_TRANSCRIPT }] };
    return patch.metadata || patch.links ? patch : null;
  };
}

async function converge(ctx: Ctx, row: DecisionRow): Promise<void> {
  const T = row.transcript_id;
  const M = row.meeting_id;
  const step = (n: number) => setDecisionStep(row.id, n);
  if (row.action === "link") {
    const stamp = {
      origin: row.actor === WORKER_ACTOR ? "calendar-match-v1" : "manual",
      evidence: row.evidence ? (JSON.parse(row.evidence) as string[]) : [],
    };
    await ensure(ctx, M, attachPlan(ctx, T, stamp));
    step(1);
    await ensure(ctx, T, pointPlan(M, row.from_meeting_id));
    step(2);
    if (row.from_meeting_id) await ensure(ctx, row.from_meeting_id, detachPlan(T), true);
    step(3);
  } else {
    await ensure(ctx, T, pointPlan(null, M));
    step(1);
    await ensure(ctx, M, detachPlan(T));
    step(2);
  }
}

type Outcome = { status: "applied" | "pending"; revision: number };

/** Apply a journaled decision; an incomplete write is reported honestly as pending. */
async function drive(ctx: Ctx, row: DecisionRow): Promise<Outcome> {
  try {
    await converge(ctx, row);
  } catch (e) {
    if (e instanceof TranscriptLinkError) throw e; // refused: the row stays pending
    return { status: "pending", revision: row.revision };
  }
  markDecisionApplied(row.id);
  return { status: "applied", revision: row.revision };
}

// ── manual decisions ─────────────────────────────────────────────────────────

export interface ManualDecision {
  vaultId: string;
  meetingId: string;
  transcriptId: string;
  action: "link" | "unlink";
  reason: string;
  meetingUpdatedAt: string;
  transcriptUpdatedAt: string;
  expectedRevision: number;
  requestId: string;
  /** `user:<email>` — derived from the session by the caller, never from the body. */
  actor: string;
  authorize: LinkAuthorize;
  vault?: LinkVault;
}

const bodyHash = (d: ManualDecision): string =>
  createHash("sha256")
    .update(
      JSON.stringify([d.meetingId, d.transcriptId, d.action, d.reason, d.meetingUpdatedAt, d.transcriptUpdatedAt, d.expectedRevision]),
    )
    .digest("hex");

export async function decideTranscriptLink(d: ManualDecision): Promise<Outcome> {
  const scope = linkScope(d.vaultId);
  if (!scope) throw new TranscriptLinkError("vault_changed");
  const ctx: Ctx = { scope, vault: d.vault ?? vaultFor(d.vaultId), authorize: d.authorize };
  return locked(lockKey(scope, d.transcriptId), async () => {
    assertScope(scope);
    const hash = bodyHash(d);
    const prior = findDecision(scope, d.actor, d.requestId);
    if (prior) {
      if (prior.body_hash !== hash) throw new TranscriptLinkError("request_reused");
      if (prior.state === "superseded") throw new TranscriptLinkError("superseded");
      if (prior.state === "applied") return { status: "applied", revision: prior.revision };
      // Pending: reconcile. The client's updatedAt values are stale by now (our own
      // partial writes moved them) and are deliberately NOT compared again; every
      // step re-authorizes the current actor instead.
      return drive(ctx, prior);
    }

    let meeting: Note, transcript: Note;
    try {
      meeting = await ctx.vault.getNote(d.meetingId, { includeLinks: true });
      d.authorize(meeting, "view");
      if (!hasTag(meeting, "meeting")) throw new TranscriptLinkError("not_found");
      transcript = await ctx.vault.getNote(d.transcriptId, { includeLinks: true });
      d.authorize(transcript, "view");
      if (!hasTag(transcript, "transcript")) throw new TranscriptLinkError("not_found");
    } catch (e) {
      if (is404(e)) throw new TranscriptLinkError("not_found");
      throw e;
    }
    d.authorize(meeting, "edit");
    d.authorize(transcript, "edit");

    const current = currentMeetingOf(scope, transcript);
    let from: string | null = null;
    if (d.action === "link" && current && current !== d.meetingId) {
      // A move: the old meeting is written too, so it needs the same access.
      try {
        const old = await ctx.vault.getNote(current);
        d.authorize(old, "view");
        d.authorize(old, "edit");
        from = current;
      } catch (e) {
        if (!is404(e)) throw e; // a dangling backpointer is simply replaced
      }
    }

    if (
      decisionRevision(scope, d.transcriptId) !== d.expectedRevision ||
      meeting.updatedAt !== d.meetingUpdatedAt ||
      transcript.updatedAt !== d.transcriptUpdatedAt
    )
      throw new TranscriptLinkError("stale");
    const claimed = meetingTranscriptIds(meeting).includes(d.transcriptId);
    if (d.action === "unlink" && current !== d.meetingId && !claimed) throw new TranscriptLinkError("stale");

    assertScope(scope);
    // The same request id racing on ANOTHER transcript's lock: the journal's
    // UNIQUE(actor, request_id) is the arbiter.
    if (findDecision(scope, d.actor, d.requestId)) throw new TranscriptLinkError("request_reused");
    const row = acceptDecision(scope, {
      transcriptId: d.transcriptId,
      meetingId: d.meetingId,
      fromMeetingId: from,
      // Unlinking a stale claim on M must not erase a link the transcript has elsewhere.
      desiredMeetingId: d.action === "link" ? d.meetingId : current && current !== d.meetingId ? current : null,
      actor: d.actor,
      requestId: d.requestId,
      bodyHash: hash,
      action: d.action,
      reason: d.reason,
      origin: "manual",
      eventId: str(meeting.metadata?.calendarEventId),
    });
    return drive(ctx, row);
  });
}

// ── the worker's gate ────────────────────────────────────────────────────────

export type AutoLinkOutcome = "applied" | "pending" | "skipped";

export interface TranscriptLinkGate {
  /** The journal's view of a transcript (null = never decided). */
  state(transcriptId: string): { meetingId: string | null; origin: "manual" | "auto" } | null;
  /** A manual unlink forbids re-linking this pair (or the same calendar event). */
  suppressed(transcriptId: string, meetingId: string | null, eventId: string | null): boolean;
  /** Transcripts the journal links to a meeting. */
  linkedTo(meetingId: string): string[];
  autoLink(p: { transcriptId: string; meetingId: string; eventId: string; evidence: string[] }): Promise<AutoLinkOutcome>;
  /** Re-drive automatic decisions a previous pass left pending. */
  sweep(): Promise<{ applied: number; pending: number }>;
}

const workerAuthorize: LinkAuthorize = () => {};

export function transcriptLinkGate(vaultId: string, vault?: LinkVault): TranscriptLinkGate {
  const scopeNow = () => linkScope(vaultId);
  const v = () => vault ?? vaultFor(vaultId);
  return {
    state(transcriptId) {
      const s = scopeNow();
      const st = s ? getLinkState(s, transcriptId) : null;
      return st ? { meetingId: st.meeting_id, origin: st.origin } : null;
    },
    suppressed(transcriptId, meetingId, eventId) {
      const s = scopeNow();
      return s ? isSuppressed(s, transcriptId, meetingId, eventId) : true;
    },
    linkedTo(meetingId) {
      const s = scopeNow();
      return s ? journalTranscriptsFor(s, meetingId) : [];
    },
    async autoLink(p) {
      const scope = scopeNow();
      if (!scope) return "skipped";
      const ctx: Ctx = { scope, vault: v(), authorize: workerAuthorize };
      return locked(lockKey(scope, p.transcriptId), async () => {
        // Re-check every override INSIDE the critical section: a manual decision
        // may have landed while this pass was matching.
        const st = getLinkState(scope, p.transcriptId);
        if (st?.origin === "manual" || st?.meeting_id) return "skipped";
        if (isSuppressed(scope, p.transcriptId, p.meetingId, p.eventId)) return "skipped";
        let transcript: Note;
        try {
          transcript = await ctx.vault.getNote(p.transcriptId);
        } catch {
          return "skipped";
        }
        const back = str(transcript.metadata?.meetingNoteId);
        if (back && back !== p.meetingId) return "skipped"; // never moves a transcript
        const row = acceptDecision(scope, {
          transcriptId: p.transcriptId,
          meetingId: p.meetingId,
          fromMeetingId: null,
          desiredMeetingId: p.meetingId,
          actor: WORKER_ACTOR,
          requestId: `auto:${(st?.revision ?? 0) + 1}:${p.transcriptId}:${p.meetingId}`,
          bodyHash: "",
          action: "link",
          reason: "calendar match",
          evidence: p.evidence,
          origin: "auto",
          eventId: p.eventId,
        });
        return (await drive(ctx, row)).status;
      });
    },
    async sweep() {
      const scope = scopeNow();
      const out = { applied: 0, pending: 0 };
      if (!scope) return out;
      const ctx: Ctx = { scope, vault: v(), authorize: workerAuthorize };
      for (const seen of pendingDecisions(scope, WORKER_ACTOR)) {
        await locked(lockKey(scope, seen.transcript_id), async () => {
          // Re-read under the lock: a manual decision may have superseded it.
          const row = findDecision(scope, WORKER_ACTOR, seen.request_id);
          if (!row || row.state !== "pending") return;
          const r = await drive(ctx, row).catch(() => ({ status: "pending" as const }));
          out[r.status]++;
        });
      }
      return out;
    },
  };
}

/**
 * Calendar/transcript review:
 *   GET  /api/transcripts/events/:meetingId?query=
 *   POST /api/transcripts/events/:meetingId/decisions
 *
 * Signed-in users only (a capability link or anon → 401). Mounted before the
 * owner passthrough, so the SAME grant math applies to everyone: every returned
 * title is view-filtered, a mutation needs edit on every note it writes, and an
 * unviewable note is indistinguishable from a missing one. The decision journal
 * and the note convergence live in ../transcript-links.ts.
 */
import { Hono, type Context } from "hono";
import { resolveActor, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap } from "../permissions";
import { roleFloor } from "../roles";
import { vaultClient, type Note } from "../parachute";
import { consumeRateLimit } from "../middleware/ratelimit";
import { meetingFromNote, score } from "../worker/transcript-match";
import {
  currentMeetingOf,
  fetchNoteById,
  isNoteId,
  leanTranscripts,
  TRANSCRIPT_SCAN,
  decideTranscriptLink,
  decisionRevision,
  journalTranscriptsFor,
  linkScope,
  meetingTranscriptIds,
  TranscriptLinkError,
  type LinkScope,
} from "../transcript-links";

/**
 * Candidate enumeration is bounded; `limited` tells the client when a bound bit.
 * The scan is ONE lean, cached listing of the vault's newest TRANSCRIPT_SCAN
 * transcripts; the matcher itself anchors candidates on the meeting (an exact
 * event id, or a date within a day), so an old meeting still finds its recordings.
 */
const CANDIDATE_CAP = 200;
const QUERY_CAP = 50;
const LINKED_CAP = 100;
const perMinute = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const REASON_MAX = 500;

type UserActor = Extract<Actor, { kind: "user" }>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const hasTag = (n: Note, tag: string): boolean => (n.tags ?? []).includes(tag);
const is404 = (e: unknown): boolean => (e as { status?: number })?.status === 404;

function capsOf(actor: UserActor, note: Note): Set<Cap> {
  return effectiveCaps(
    actor.grants,
    {
      id: note.id,
      tags: note.tags ?? [],
      creator: str(note.metadata?.prism_creator),
      visibility: note.metadata?.prism_visibility === "private" ? "private" : "workspace",
      path: note.path ?? null,
    },
    roleFloor(actor.role),
    actor.email,
  );
}

const titleOf = (n: Note): string =>
  str(n.metadata?.title) ?? str(n.displayTitle) ?? (n.path ? n.path.split("/").pop()! : "") ?? "";
/** Only a real recorded start. A date-only legacy record omits it rather than
 *  inviting the client to render midnight UTC as a local time. */
const startOf = (n: Note): string | undefined => str(n.metadata?.start) ?? undefined;

/** The signed-in user bound to a still-registered vault, or the refusal to send. */
function guard(c: Context, kind: "review" | "decide"): { actor: UserActor; scope: LinkScope } | Response {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
  // Per USER (not per IP): a review is a vault listing, a decision is note writes.
  const max = kind === "review" ? perMinute("TRANSCRIPT_REVIEW_PER_MINUTE", 60) : perMinute("TRANSCRIPT_DECISIONS_PER_MINUTE", 60);
  const retry = consumeRateLimit(`transcripts-${kind}:${actor.email}`, max, 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  const header = c.req.header("x-prism-vault");
  const scope = linkScope(actor.vaultId);
  if ((header && header !== actor.vaultId) || !scope) return c.json({ error: "vault_unavailable" }, 409);
  return { actor, scope };
}

export const transcriptsApi = new Hono();

transcriptsApi.get("/events/:meetingId", async (c) => {
  const g = guard(c, "review");
  if (g instanceof Response) return g;
  const { actor, scope } = g;
  c.header("Cache-Control", "private, no-store");
  const meetingId = c.req.param("meetingId");
  const vc = vaultClient(actor.vaultId);
  try {
    let meeting: Note;
    try {
      // Canonical id only: a path/title alias the vault would resolve is a 404.
      meeting = await fetchNoteById(vc, meetingId, true);
    } catch (e) {
      if (is404(e)) return c.json({ error: "not_found" }, 404);
      throw e;
    }
    const meetingCaps = capsOf(actor, meeting);
    // Unviewable, or not a meeting: indistinguishable from missing.
    if (!meetingCaps.has("view") || !hasTag(meeting, "meeting")) return c.json({ error: "not_found" }, 404);

    const query = (c.req.query("query") ?? "").trim().toLowerCase().slice(0, 200);
    const scanned = await leanTranscripts(scope);
    // View-filter BEFORE anything is scored, counted or titled.
    const visible = scanned.filter((t) => capsOf(actor, t).has("view"));
    const byId = new Map(visible.map((t) => [t.id, t]));
    // A full scan may hide older recordings. Only an actor whose role already
    // sees the whole vault is told; for anyone else `limited` is computed purely
    // from rows they can view, so it never reveals how many transcripts exist.
    let limited = scanned.length >= TRANSCRIPT_SCAN && roleFloor(actor.role) !== null;

    // Backpointer-only recordings are found across the WHOLE scan, not a window.
    const linkedIds = [
      ...new Set([
        ...meetingTranscriptIds(meeting),
        ...journalTranscriptsFor(scope, meeting.id),
        ...visible.filter((t) => currentMeetingOf(scope, t) === meeting.id).map((t) => t.id),
      ]),
    ];
    const linked = [];
    for (const id of linkedIds) {
      let t = byId.get(id);
      if (!t) {
        if (linked.length >= LINKED_CAP) break;
        try {
          t = await fetchNoteById(vc, id); // outside the scan, or not tagged transcript
        } catch (e) {
          if (is404(e)) continue; // dangling id or alias: nothing to show
          throw e;
        }
      }
      const caps = capsOf(actor, t);
      if (!caps.has("view")) continue; // silently dropped
      if (linked.length >= LINKED_CAP) {
        limited = true;
        break;
      }
      linked.push({
        id: t.id,
        title: titleOf(t),
        ...(startOf(t) ? { start: startOf(t) } : {}),
        updatedAt: t.updatedAt ?? "",
        decisionRevision: decisionRevision(scope, t.id),
        canManage: caps.has("edit") && hasTag(t, "transcript"),
      });
    }

    const asMeeting = meetingFromNote(meeting);
    const taken = new Set(linkedIds);
    let scored = visible
      .filter((t) => !taken.has(t.id))
      .flatMap((t) => {
        const s = score(asMeeting, t);
        if (query) {
          if (!`${titleOf(t)}\n${t.path ?? ""}`.toLowerCase().includes(query)) return [];
          return [{ t, score: s?.score ?? 0, evidence: s?.evidence ?? [] }];
        }
        return s && s.score > 0 ? [{ t, score: s.score, evidence: s.evidence }] : [];
      })
      .sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id));
    const cap = query ? QUERY_CAP : CANDIDATE_CAP;
    if (scored.length > cap) {
      limited = true;
      scored = scored.slice(0, cap);
    }
    // Whether the actor may also write the meeting a candidate would be moved FROM.
    // Only a boolean ever leaves here — never that meeting's id or title. Each
    // distinct other meeting is read once, a few at a time.
    const current = new Map(scored.map(({ t }) => [t.id, currentMeetingOf(scope, t)]));
    const others = [...new Set([...current.values()].filter((id): id is string => !!id && id !== meeting.id))];
    const otherEditable = new Map<string, boolean>();
    for (let i = 0; i < others.length; i += 6) {
      await Promise.all(
        others.slice(i, i + 6).map(async (id) => {
          try {
            const caps = capsOf(actor, await fetchNoteById(vc, id));
            otherEditable.set(id, caps.has("view") && caps.has("edit"));
          } catch (e) {
            if (!is404(e)) throw e;
            otherEditable.set(id, true); // dangling backpointer: a link simply replaces it
          }
        }),
      );
    }
    const candidates = scored.map(({ t, score: value, evidence }) => {
      const other = current.get(t.id);
      const linkedElsewhere = !!other && other !== meeting.id;
      return {
        id: t.id,
        title: titleOf(t),
        ...(startOf(t) ? { start: startOf(t) } : {}),
        updatedAt: t.updatedAt ?? "",
        decisionRevision: decisionRevision(scope, t.id),
        canManage: capsOf(actor, t).has("edit") && hasTag(t, "transcript") && (!linkedElsewhere || otherEditable.get(other!) === true),
        score: value,
        evidence,
        linkedElsewhere,
      };
    });

    return c.json({
      meeting: { id: meeting.id, eventId: str(meeting.metadata?.calendarEventId) ?? "", title: titleOf(meeting), updatedAt: meeting.updatedAt ?? "" },
      linked,
      candidates,
      limited,
      canManage: meetingCaps.has("edit"),
    });
  } catch {
    return c.json({ error: "transcripts_unavailable" }, 503);
  }
});

const BODY_KEYS = ["transcriptId", "action", "reason", "meetingUpdatedAt", "transcriptUpdatedAt", "expectedRevision", "requestId"] as const;

interface DecisionBody {
  transcriptId: string;
  action: "link" | "unlink";
  reason: string;
  meetingUpdatedAt: string;
  transcriptUpdatedAt: string;
  expectedRevision: number;
  requestId: string;
}

/** Strict: exactly the contract's keys, each of the contract's type. */
function parseBody(input: unknown): DecisionBody | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const b = input as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((k) => k in b)) return null;
  const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!isNoteId(b.transcriptId) || !short(b.meetingUpdatedAt, 64) || !short(b.transcriptUpdatedAt, 64)) return null;
  if (b.action !== "link" && b.action !== "unlink") return null;
  if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > REASON_MAX) return null;
  if (!Number.isSafeInteger(b.expectedRevision) || (b.expectedRevision as number) < 0) return null;
  if (!short(b.requestId, 200) || !/^[A-Za-z0-9._:-]+$/.test(b.requestId)) return null;
  return {
    transcriptId: b.transcriptId,
    action: b.action,
    reason: b.reason,
    meetingUpdatedAt: b.meetingUpdatedAt,
    transcriptUpdatedAt: b.transcriptUpdatedAt,
    expectedRevision: b.expectedRevision as number,
    requestId: b.requestId,
  };
}

const ERROR_STATUS = {
  not_found: 404,
  forbidden: 403,
  stale: 409,
  superseded: 409,
  vault_changed: 409,
  request_reused: 422,
} as const;

transcriptsApi.post("/events/:meetingId/decisions", async (c) => {
  const g = guard(c, "decide");
  if (g instanceof Response) return g;
  const { actor, scope } = g;
  c.header("Cache-Control", "private, no-store");
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "unsupported_media_type" }, 415);
  const body = parseBody(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "bad_request" }, 400);

  // Latest actor, grants and registry identity — re-resolved before every write.
  const authorize = (note: Note, need: "view" | "edit") => {
    const fresh = resolveActor(c);
    const now = linkScope(actor.vaultId);
    if (!now || now.identity !== scope.identity) throw new TranscriptLinkError("vault_changed");
    if (fresh.kind !== "user" || fresh.email !== actor.email || fresh.vaultId !== actor.vaultId) throw new TranscriptLinkError("not_found");
    const caps = capsOf(fresh, note);
    if (!caps.has("view")) throw new TranscriptLinkError("not_found");
    if (need === "edit" && !caps.has("edit")) throw new TranscriptLinkError("forbidden");
  };

  try {
    const result = await decideTranscriptLink({
      vaultId: actor.vaultId,
      meetingId: c.req.param("meetingId"),
      ...body,
      actor: `user:${actor.email}`,
      authorize,
    });
    return c.json(result);
  } catch (e) {
    if (e instanceof TranscriptLinkError) {
      const error = e.code === "vault_changed" ? "vault_unavailable" : e.code;
      return c.json({ error }, ERROR_STATUS[e.code]);
    }
    return c.json({ error: "transcripts_unavailable" }, 503);
  }
});

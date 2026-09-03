/**
 * Fireflies → vault transcript ingester + self-cleaner (Phase 3). Node port of
 * the desktop's transcript_sync Fireflies path, moved to the SERVER so it runs
 * on the always-on host and — critically — so it can DELETE each transcript from
 * Fireflies once its content is confirmed in the vault, keeping the account under
 * the free-tier daily API-request quota (50/day) AND the stored-minutes quota
 * that otherwise wedges the whole integration.
 *
 * Note shape matches the desktop's Fireflies note verbatim (tags
 * [transcript,fireflies], path vault/_inbox/transcripts/fireflies/<date>-<slug>,
 * metadata {type,source:"fireflies",source_id,…}) and dedupes by source_id, so
 * the desktop + server can briefly overlap during cutover WITHOUT duplicates.
 *
 * Delete policy = "delay one cycle": a NEW transcript is ingested (no delete) on
 * run N; on a later run it's found already-in-vault (an independent re-read of
 * the vault confirms the note persisted) and only THEN deleted from Fireflies.
 * That same rule drains any pre-existing backlog of already-synced transcripts.
 *
 * `fetch` is injectable so the parse/map + loop logic is unit-tested without the
 * live API (see test/fireflies.test.ts). Live path: scripts + the on-demand
 * /api/integrations/fireflies/sync route.
 */
import type { IngestVault } from "./matrix";
import type { Note } from "../parachute";

const ENDPOINT = "https://api.fireflies.ai/graphql";
type FetchLike = typeof fetch;

/** Vault surface this worker needs: the ingest surface plus a single-note read,
 *  used to RE-VERIFY a note immediately before the irreversible delete. */
export interface FirefliesVault extends IngestVault {
  getNote(id: string): Promise<Note>;
}

// ── GraphQL client ───────────────────────────────────────────────────────────

export interface FirefliesTranscript {
  id: string;
  title?: string;
  /** epoch milliseconds (a JSON number in the Fireflies API) */
  date?: number;
  duration?: number;
  transcript_url?: string;
  /** Signed CDN URL of the recording. Present even when Fireflies never produced
   *  a transcript — which is what makes empty sources RECOVERABLE (re-upload it). */
  audio_url?: string | null;
  /** Owner of the meeting. `deleteTranscript` SILENTLY NO-OPS (returning a
   *  success-shaped payload) when the API key's user doesn't own the meeting, so
   *  we must compare these against the key's own email before ever attempting it. */
  host_email?: string | null;
  organizer_email?: string | null;
  meeting_attendees?: Array<{ displayName?: string | null; email?: string | null }> | null;
}

/** Storage the account is consuming. Fireflies STOPS TRANSCRIBING once this
 *  exceeds the plan cap — which is what silently produced empty transcripts, which
 *  then couldn't be ingested, so were never deleted, so the cap was never freed. */
export interface FirefliesUsage {
  minutesConsumed: number;
  numTranscripts: number;
}

/** Who owns this meeting (host wins, else organizer), lowercased. "" if unknown. */
export const ownerOf = (t: FirefliesTranscript): string =>
  (t.host_email || t.organizer_email || "").trim().toLowerCase();

export interface FirefliesDetail {
  summary?: { overview?: string | null } | null;
  sentences?: Array<{ speaker_name?: string | null; text?: string | null }> | null;
}

export class FirefliesError extends Error {
  constructor(
    message: string,
    public status?: number,
    public gqlErrors?: Array<{ message?: string; code?: string }>,
  ) {
    super(message);
    this.name = "FirefliesError";
  }
}

/** Does this error look like a Fireflies rate-limit (429 / "too many requests")?
 *  Mirrors the desktop's `is_rate_limited` so we back off instead of erroring. */
export function isRateLimited(e: unknown): boolean {
  if (e instanceof FirefliesError && e.status === 429) return true;
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("rate limit") ||
    m.includes("ratelimit")
  );
}

export class FirefliesClient {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async graphql<T>(body: { query: string; variables?: Record<string, unknown> }): Promise<T> {
    const r = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new FirefliesError(`fireflies http ${r.status}`, r.status);
    const json = (await r.json()) as {
      data?: T;
      errors?: Array<{ message?: string; code?: string }>;
    };
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message ?? "").filter(Boolean).join("; ");
      throw new FirefliesError(`fireflies graphql: ${msg}`, r.status, json.errors);
    }
    return json.data as T;
  }

  /** The email of the account this API key belongs to. Deletion is only ever
   *  attempted for meetings owned by this address. */
  async currentUserEmail(): Promise<string> {
    const d = await this.graphql<{ user?: { email?: string } }>({ query: "query { user { email } }" });
    return (d?.user?.email ?? "").trim().toLowerCase();
  }

  /** Storage usage. Cheap, and the early-warning signal for the whole deadlock. */
  async usage(): Promise<FirefliesUsage> {
    const d = await this.graphql<{ user?: { minutes_consumed?: number; num_transcripts?: number } }>({
      query: "query { user { minutes_consumed num_transcripts } }",
    });
    return { minutesConsumed: d?.user?.minutes_consumed ?? 0, numTranscripts: d?.user?.num_transcripts ?? 0 };
  }

  /** Hand a recording back to Fireflies for (re)transcription. This is how an
   *  empty transcript is RECOVERED rather than lost: the audio survives even when
   *  the transcript is blank, so we re-upload it and ingest the result. */
  async uploadAudio(url: string, title: string, clientReferenceId?: string): Promise<boolean> {
    const d = await this.graphql<{ uploadAudio?: { success?: boolean } }>({
      query: "mutation($input: AudioUploadInput!) { uploadAudio(input: $input) { success title message } }",
      variables: { input: { url, title, save_video: false, ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}) } },
    });
    return d?.uploadAudio?.success === true;
  }

  /** Recent transcripts, metadata only (no sentences/summary — cheap). */
  async listTranscripts(limit: number): Promise<FirefliesTranscript[]> {
    const d = await this.graphql<{ transcripts?: FirefliesTranscript[] }>({
      query:
        "query Transcripts($limit: Int) { transcripts(limit: $limit) { id title date duration transcript_url audio_url host_email organizer_email meeting_attendees { displayName email } } }",
      variables: { limit },
    });
    return d?.transcripts ?? [];
  }

  /** The heavy body (summary + sentences) for one transcript. */
  async getTranscript(id: string): Promise<FirefliesDetail> {
    const d = await this.graphql<{ transcript?: FirefliesDetail }>({
      query:
        "query Transcript($id: String!) { transcript(id: $id) { summary { overview } sentences { speaker_name text } } }",
      variables: { id },
    });
    return d?.transcript ?? {};
  }

  /** Permanently delete a transcript from Fireflies. Only succeeds for a
   *  transcript the API key's user OWNS (a teammate's needs team-admin) — a
   *  denial surfaces as a FirefliesError the caller treats as non-retryable. */
  async deleteTranscript(id: string): Promise<void> {
    await this.graphql<{ deleteTranscript?: { id?: string } }>({
      query: "mutation DeleteTranscript($id: String!) { deleteTranscript(id: $id) { id } }",
      variables: { id },
    });
  }
}

// ── pure parse/map (unit-tested) ─────────────────────────────────────────────

const titleOf = (t: FirefliesTranscript): string => t.title || "Untitled Meeting";

/** Fireflies `date` is epoch ms; format as UTC YYYY-MM-DD (matches the desktop,
 *  which uses `from_timestamp_millis(...).format("%Y-%m-%d")`). */
export function dateOf(t: FirefliesTranscript): string {
  if (typeof t.date !== "number" || !Number.isFinite(t.date)) return "";
  return new Date(t.date).toISOString().slice(0, 10);
}

export function attendeesOf(t: FirefliesTranscript): string[] {
  return (t.meeting_attendees ?? [])
    .map((a) => a?.displayName || a?.email || "")
    .filter((x): x is string => !!x);
}

/** Speaker-labelled transcript body from the detail sentences. */
export function sentencesToText(detail: FirefliesDetail): string {
  return (detail.sentences ?? [])
    .map((s) => {
      const text = s?.text ?? "";
      if (!text) return null;
      const speaker = s?.speaker_name || "Speaker";
      return `**${speaker}**: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

const sanitizePath = (s: string): string =>
  (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

/** Build the transcript note (matches the desktop's Fireflies note verbatim).
 *  Returns null when there's nothing to ingest (no summary AND no transcript). */
export function firefliesNote(
  t: FirefliesTranscript,
  detail: FirefliesDetail,
): { content: string; path: string; tags: string[]; metadata: Record<string, unknown> } | null {
  const title = titleOf(t);
  const date = dateOf(t);
  const id = t.id;
  const shareUrl = t.transcript_url ?? "";
  const attendees = attendeesOf(t);
  const summary = detail.summary?.overview ?? "";
  const transcript = sentencesToText(detail);

  if (!summary && !transcript) return null;

  let content = `---\ntitle: "${title}"\ndate: ${date}\nsource: fireflies\ntranscript_id: "${id}"\nfireflies_url: "${shareUrl}"\nattendees:\n`;
  for (const a of attendees) content += `  - ${a}\n`;
  content += "---\n\n";
  if (summary) content += `## Summary\n\n${summary}\n\n`;
  if (transcript) content += `## Transcript\n\n${transcript}\n`;

  return {
    content,
    path: `vault/_inbox/transcripts/fireflies/${date}-${sanitizePath(title)}`,
    tags: ["transcript", "fireflies"],
    metadata: {
      type: "transcript",
      source: "fireflies",
      source_id: id,
      synced_at: new Date().toISOString(),
      title,
      date,
      attendees,
      fireflies_url: shareUrl,
      // How many characters of verbatim the SOURCE held when we copied it. The
      // delete gate compares the stored body against this, so a short-but-complete
      // transcript is deletable while a summary-only note (0) never is.
      fireflies_verbatim_chars: transcript.length,
    },
  };
}

// ── the delete safety gate ───────────────────────────────────────────────────
//
// Deleting from Fireflies is IRREVERSIBLE, so a delete is authorized only by
// positive proof that THIS transcript's body is already in the vault. Two holes
// this closes, both of which would silently destroy an un-ingested transcript:
//
//  1. A summary-only note. If a detail fetch ever returns `summary` but empty
//     `sentences`, we'd have written a note with no transcript body — deleting
//     the source then loses the verbatim record forever. So we require a
//     non-trivial `## Transcript` body, not merely "a note exists".
//  2. A cross-source id collision. `source_id` is only unique per source, so we
//     additionally require `metadata.source === "fireflies"` and an exact id match.
//
// Every check fails CLOSED: anything unproven is left on Fireflies, never deleted.

/** Minimum characters of transcript body a note must carry to authorize a delete
 *  when the note doesn't record how big the source was. */
export const MIN_TRANSCRIPT_CHARS = 200;

/** How much of the source's recorded verbatim length the stored body must reach.
 *  Not 1.0: `fireflies_verbatim_chars` on notes written by the older cleanup
 *  agent is a ROUNDED estimate (e.g. 53500 for a 52118-char body), and headers
 *  are trimmed. 0.9 tolerates that while still rejecting real truncation. */
export const VERBATIM_TOLERANCE = 0.9;

/** Length of the `## Transcript` section body, 0 if absent. Trimmed but NOT
 *  whitespace-collapsed, so it matches the source string we wrote verbatim. */
export function transcriptBodyLength(content: string): number {
  const m = content.match(/^##[ \t]+Transcript[ \t]*$/m);
  if (!m || m.index === undefined) return 0;
  return content.slice(m.index + m[0].length).trim().length;
}

/** Normalized title, used to match a recovered transcript back to the empty
 *  recording it came from (Fireflies rewrites punctuation on re-upload). */
export const normTitle = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Is this note the stub we wrote for an empty recording we re-submitted? */
export const isEmptySourceStub = (n: Note | null | undefined): boolean =>
  n?.metadata?.fireflies_status === "empty-source-recovered";

/**
 * Does this vault note PROVE we already copied this exact Fireflies transcript?
 * The sole authority for deleting from Fireflies. Fails closed on every doubt.
 *
 * Body sufficiency is judged against `fireflies_verbatim_chars` — how much
 * verbatim the SOURCE held when we ingested it — rather than a blanket floor.
 * A genuinely short meeting whose few lines we captured in full is deletable; a
 * summary-only note (source had 0 verbatim, so nothing was copied) never is.
 * Legacy notes lacking the field fall back to the absolute floor.
 */
export function isIngestConfirmed(
  note: Note | null | undefined,
  firefliesId: string,
  minChars: number = MIN_TRANSCRIPT_CHARS,
): boolean {
  if (!note || !firefliesId) return false;
  const md = note.metadata ?? {};
  if (md.source !== "fireflies") return false; // never trust another source's id space
  const sid = (md.source_id ?? md.sourceId) as string | undefined;
  if (sid !== firefliesId) return false; // exact id match, no coercion

  const body = transcriptBodyLength(note.content ?? "");
  if (body <= 0) return false; // no transcript section at all
  const expected = Number(md.fireflies_verbatim_chars);
  if (Number.isFinite(expected)) {
    // The source had no verbatim at all → nothing was ever ingested → never delete.
    if (expected <= 0) return false;
    return body >= Math.floor(expected * VERBATIM_TOLERANCE);
  }
  return body >= minChars;
}

// ── ingest + cleanup loop ────────────────────────────────────────────────────

/** A per-day Fireflies API-request budget. The scheduler backs this with a
 *  DB-persisted counter (keyed by UTC date) so a restart can't blow the quota;
 *  tests pass a trivial in-memory one. Every list/detail/delete costs 1. */
export interface FirefliesBudget {
  remaining(): number;
  spend(n: number): void;
}

export interface FirefliesLoopOptions {
  budget: FirefliesBudget;
  /** ids known to be un-deletable (ownership/permission) — skipped without cost.
   *  Persist across runs (module-level in the scheduler) so we don't retry them. */
  skipSet?: Set<string>;
  /** MUST be explicitly true to issue any deleteTranscript. Default false = a
   *  dry run that logs exactly what it WOULD delete and touches nothing. */
  deleteEnabled?: boolean;
  /** The API key's own email. Deletion is refused for meetings owned by anyone
   *  else. Omit and the loop resolves it via `currentUserEmail()` (1 call);
   *  if it still can't be determined, ALL deletes are refused (fail closed). */
  ownerEmail?: string;
  /** Re-submit the audio of a transcript that Fireflies left EMPTY, so it gets
   *  transcribed and can then be ingested. Recovery, never deletion. Once per
   *  recording (a vault stub records the attempt). */
  recoverEmptySources?: boolean;
  maxRecoveriesPerRun?: number; // default 3
  /** Plan's transcription-minutes cap; crossing it is what stops transcription. */
  quotaMinutesCap?: number; // default 400 (free tier)
  listLimit?: number; // default 25
  maxNewPerRun?: number; // default 6
  maxDeletePerRun?: number; // default 9 (< the 10/min deleteTranscript cap)
  throttleMs?: number; // default 1500 between Fireflies API calls
  minTranscriptChars?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: FirefliesEvent) => void;
}

export type FirefliesEvent =
  | { kind: "ingested"; id: string; title: string }
  | { kind: "deleted"; id: string; title: string }
  | { kind: "would-delete"; id: string; title: string } // dry run
  | { kind: "unverified"; id: string; title: string; reason: string } // refused to delete
  | { kind: "not-owner"; id: string; title: string; owner: string } // can never delete
  | { kind: "false-delete"; id: string; title: string } // note said deleted, still live
  | { kind: "recovered"; id: string; title: string } // empty source re-uploaded for transcription
  | { kind: "quota-warning"; minutesConsumed: number; cap: number }
  | { kind: "undeletable"; id: string; title: string; reason: string };

/** A vault stub recording that a Fireflies recording arrived with NO transcript
 *  and we handed its audio back for transcription. Its presence is what stops us
 *  re-uploading the same recording on every run. `fireflies_verbatim_chars: 0`
 *  guarantees the delete gate never authorizes removing the empty original. */
export function emptySourceStub(t: FirefliesTranscript): {
  content: string;
  path: string;
  tags: string[];
  metadata: Record<string, unknown>;
} {
  const title = titleOf(t);
  const date = dateOf(t);
  return {
    content:
      `---\ntitle: "${title}"\ndate: ${date}\nsource: fireflies\ntranscript_id: "${t.id}"\n---\n\n` +
      `## Summary\n\nFireflies held this ${Math.round(t.duration ?? 0)}-minute recording with **no transcript** ` +
      `(most often because the account was over its transcription-minutes cap). Its audio was re-submitted for ` +
      `transcription on ${new Date().toISOString().slice(0, 10)}; the resulting transcript is ingested as its own note.\n`,
    path: `vault/_inbox/transcripts/fireflies/${date}-${sanitizePath(title)}-empty-${t.id.slice(-6).toLowerCase()}`,
    tags: ["transcript", "fireflies", "fireflies-empty-source"],
    metadata: {
      type: "transcript",
      source: "fireflies",
      source_id: t.id,
      synced_at: new Date().toISOString(),
      title,
      date,
      fireflies_url: t.transcript_url ?? "",
      fireflies_status: "empty-source-recovered",
      fireflies_recovery_uploaded_at: new Date().toISOString(),
      fireflies_audio_url: t.audio_url ?? "",
      // Zero verbatim → isIngestConfirmed() can never authorize deleting the original.
      fireflies_verbatim_chars: 0,
    },
  };
}

export interface FirefliesLoopResult {
  created: number;
  deleted: number;
  /** confirmed-in-vault and would have been deleted, but deleteEnabled=false */
  wouldDelete: number;
  /** present on Fireflies + a note exists, but the note does NOT prove the body
   *  was copied → deliberately left on Fireflies. Investigate these. */
  unverified: number;
  /** owned by someone else → deleteTranscript would silently no-op. Never tried. */
  notOwner: number;
  /** the vault claimed "deleted" but the transcript is still live → relabeled. */
  falseDeletes: number;
  /** empty transcripts whose audio we handed back for (re)transcription. */
  recovered: number;
  skipped: number;
}

/**
 * An EMPTY recording carries nothing to ingest, so `isIngestConfirmed` can never
 * clear it. But once we've re-submitted its audio and the resulting transcript is
 * confirmed stored, the original is a zero-content duplicate and may go. This
 * resolves that proof: the stub must name a replacement note, and that note must
 * itself pass the full ingest gate. Any missing link ⇒ false ⇒ keep the original.
 */
export async function isSupersededByConfirmedNote(
  stub: Note | null | undefined,
  vault: Pick<FirefliesVault, "getNote">,
  minChars?: number,
): Promise<boolean> {
  if (!isEmptySourceStub(stub)) return false;
  const replacementId = stub?.metadata?.fireflies_superseded_by_note;
  if (typeof replacementId !== "string" || !replacementId) return false;
  let replacement: Note | null = null;
  try {
    replacement = await vault.getNote(replacementId);
  } catch {
    return false;
  }
  const sid = (replacement?.metadata?.source_id ?? replacement?.metadata?.sourceId) as string | undefined;
  if (!sid) return false;
  return isIngestConfirmed(replacement, sid, minChars);
}

/** Durably record the outcome on the note, so state survives restarts and the
 *  vault stays the honest source of truth about what's really on Fireflies. */
async function markNote(
  vault: FirefliesVault,
  noteId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await vault.updateNote(noteId, { metadata: meta });
  } catch {
    /* bookkeeping is best-effort; never let it block or fake a delete */
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One ingest+cleanup pass:
 *  - list recent transcripts (1 call),
 *  - re-read the vault's transcript source_ids (free),
 *  - for each listed transcript: if its content is already in the vault, DELETE
 *    it from Fireflies (delay-one-cycle cleanup + backlog drain); otherwise
 *    ingest it (no delete this run).
 * Every Fireflies API call is budgeted, throttled, and rate-limit-aware.
 */
export async function ingestAndCleanupFireflies(
  client: Pick<FirefliesClient, "listTranscripts" | "getTranscript" | "deleteTranscript"> &
    Partial<Pick<FirefliesClient, "currentUserEmail" | "usage" | "uploadAudio">>,
  vault: FirefliesVault,
  opts: FirefliesLoopOptions,
): Promise<FirefliesLoopResult> {
  const { budget } = opts;
  const skip = opts.skipSet ?? new Set<string>();
  const deleteEnabled = opts.deleteEnabled === true; // opt-in; anything else = dry run
  const listLimit = opts.listLimit ?? 25;
  const maxNew = opts.maxNewPerRun ?? 6;
  const maxDel = opts.maxDeletePerRun ?? 9;
  const throttleMs = opts.throttleMs ?? 1500;
  const minChars = opts.minTranscriptChars ?? MIN_TRANSCRIPT_CHARS;
  const sleep = opts.sleep ?? realSleep;
  const emit = opts.onEvent ?? (() => {});

  const recoverEmpty = opts.recoverEmptySources === true;
  const maxRecoveries = opts.maxRecoveriesPerRun ?? 3;
  const quotaCap = opts.quotaMinutesCap ?? 400;

  const out: FirefliesLoopResult = { created: 0, deleted: 0, wouldDelete: 0, unverified: 0, notOwner: 0, falseDeletes: 0, recovered: 0, skipped: 0 };
  if (budget.remaining() <= 0) return out;

  // 0) Whose key is this? Deletes are refused for anyone else's meetings, so if
  //    we can't establish identity we simply never delete (fail closed).
  // Resolved even for a dry run, so the dry run reports exactly what a real run
  // would do (otherwise someone else's meeting reads as a "would-delete").
  let ownerEmail = (opts.ownerEmail ?? "").trim().toLowerCase();
  if (!ownerEmail && client.currentUserEmail) {
    budget.spend(1);
    try {
      ownerEmail = await client.currentUserEmail();
    } catch (e) {
      if (isRateLimited(e)) return out;
      ownerEmail = "";
    }
  }

  // 1) list (costs 1). A rate-limit here just ends the run quietly.
  let list: FirefliesTranscript[];
  budget.spend(1);
  try {
    list = await client.listTranscripts(listLimit);
  } catch (e) {
    if (isRateLimited(e)) return out;
    throw e;
  }

  // 2) Candidate vault notes, scoped to source=fireflies. This map only tells us
  //    WHICH note to re-read; it never by itself authorizes a delete. Multiple
  //    notes can share a source_id (known duplicates) — any one that confirms is
  //    sufficient proof the body was copied.
  const existing = await vault.listNotes({ tags: ["transcript"], includeContent: false });
  const candidates = new Map<string, string[]>();
  // Empty recordings we re-submitted but haven't yet matched to their replacement,
  // keyed by normalized title (Fireflies rewrites punctuation on re-upload).
  const awaitingReplacement = new Map<string, Note>();
  for (const n of existing) {
    const md = n.metadata ?? {};
    if (md.source !== "fireflies") continue;
    const sid = (md.source_id ?? md.sourceId) as string | undefined;
    if (!sid) continue;
    const arr = candidates.get(sid);
    if (arr) arr.push(n.id);
    else candidates.set(sid, [n.id]);
    if (isEmptySourceStub(n) && !md.fireflies_superseded_by_note) {
      awaitingReplacement.set(normTitle(String(md.title ?? "")), n);
    }
  }

  // Early warning on the condition that starts the whole deadlock: once storage
  // crosses the plan cap, Fireflies quietly stops transcribing new meetings.
  if (client.usage && budget.remaining() > 0) {
    budget.spend(1);
    try {
      const u = await client.usage();
      if (u.minutesConsumed >= quotaCap * 0.8) {
        emit({ kind: "quota-warning", minutesConsumed: u.minutesConsumed, cap: quotaCap });
      }
    } catch {
      /* usage is advisory; never block the run */
    }
  }

  let newThisRun = 0;
  let delThisRun = 0;
  let recoveredThisRun = 0;

  for (const t of list) {
    if (budget.remaining() <= 0) break;
    const id = t.id;
    const title = t.title || "(untitled)";
    if (!id) {
      out.skipped++;
      continue;
    }

    const noteIds = candidates.get(id);

    if (noteIds?.length) {
      // ── Ingested on a prior run. Re-verify, then (maybe) delete. ──
      if (skip.has(id)) {
        out.skipped++;
        continue;
      }

      // IRONCLAD GATE: independently re-read the note(s) from the vault RIGHT NOW
      // and require positive proof this transcript's body is stored. Parachute
      // reads are free (not Fireflies quota), so we always pay for certainty.
      let confirmed: Note | null = null;
      let claimedDeleted = false;
      for (const noteId of noteIds) {
        let note: Note | null = null;
        try {
          note = await vault.getNote(noteId);
        } catch {
          note = null; // unreadable → unproven → do not delete
        }
        if (note?.metadata?.fireflies_delete_status === "deleted") claimedDeleted = true;
        if (!confirmed && isIngestConfirmed(note, id, minChars)) confirmed = note;
        // An empty recording we already recovered: deletable only once its
        // replacement transcript is itself confirmed stored in the vault.
        if (!confirmed && (await isSupersededByConfirmedNote(note, vault, minChars))) confirmed = note;
      }

      // Self-heal the failure mode that wedged the old pruner: the vault says we
      // deleted this, yet Fireflies is still listing it. The delete never took.
      // Record the truth instead of silently "succeeding" again.
      if (claimedDeleted) {
        out.falseDeletes++;
        emit({ kind: "false-delete", id, title });
        for (const noteId of noteIds) {
          await markNote(vault, noteId, {
            fireflies_delete_status: "blocked",
            fireflies_block_reason: "delete did not take — transcript still listed on Fireflies",
            fireflies_deleted_at: null,
          });
        }
        skip.add(id);
        continue;
      }

      if (!confirmed) {
        // A note exists but does NOT prove the transcript body was copied
        // (summary-only, restructured, empty, or unreadable). Leave it on
        // Fireflies. Never delete on doubt.
        out.unverified++;
        emit({ kind: "unverified", id, title, reason: "no verified transcript body in vault note" });
        continue;
      }

      // OWNERSHIP GATE: deleteTranscript returns a success-shaped payload but
      // silently no-ops for a meeting we don't own. Never attempt it — that's
      // what produced days of false "deleted" bookkeeping. Costs no API call.
      // Evaluated before the dry-run branch so a dry run reports the truth.
      const owner = ownerOf(t);
      if (!ownerEmail || owner !== ownerEmail) {
        out.notOwner++;
        emit({ kind: "not-owner", id, title, owner: owner || "(unknown)" });
        if (deleteEnabled) {
          await markNote(vault, confirmed.id, {
            fireflies_delete_status: "blocked",
            fireflies_block_reason: `not-owner: ${owner || "unknown"} — deleteTranscript silently no-ops for meetings this key doesn't own`,
            fireflies_owner_email: owner || null,
          });
        }
        skip.add(id);
        continue;
      }

      if (!deleteEnabled) {
        out.wouldDelete++;
        emit({ kind: "would-delete", id, title });
        continue; // dry run: no API call, no budget spent
      }

      if (delThisRun >= maxDel) continue; // rate cap — retry next run
      await sleep(throttleMs);
      budget.spend(1);
      try {
        await client.deleteTranscript(id);
        out.deleted++;
        delThisRun++;
        emit({ kind: "deleted", id, title });
        // Provisional: the NEXT run re-lists and, if it's somehow still there,
        // flips this to blocked/false-delete above. Never trust the mutation alone.
        await markNote(vault, confirmed.id, {
          fireflies_delete_status: "deleted",
          fireflies_deleted_at: new Date().toISOString(),
        });
      } catch (e) {
        if (isRateLimited(e)) break; // stop the run, resume next cycle
        skip.add(id);
        out.skipped++;
        emit({ kind: "undeletable", id, title, reason: (e as Error).message });
      }
    } else {
      // ── New transcript → ingest this run; deleted on a later run. ──
      if (newThisRun >= maxNew) continue; // cap — the rest sync next run
      await sleep(throttleMs);
      budget.spend(1);
      let detail: FirefliesDetail;
      try {
        detail = await client.getTranscript(id);
      } catch (e) {
        if (isRateLimited(e)) break;
        out.skipped++;
        continue;
      }
      const note = firefliesNote(t, detail);
      if (!note) {
        // Fireflies holds the recording but produced NO transcript (it stops
        // transcribing over the minutes cap). There is nothing to ingest, so the
        // delete gate will never authorize removing it. Instead, RECOVER it: hand
        // the audio back for transcription and ingest the result on a later run.
        out.skipped++;
        const upload = client.uploadAudio?.bind(client);
        const audioUrl = t.audio_url;
        const canRecover =
          recoverEmpty &&
          !!audioUrl &&
          !!upload &&
          !!ownerEmail &&
          ownerOf(t) === ownerEmail &&
          recoveredThisRun < maxRecoveries &&
          budget.remaining() > 0;
        if (!canRecover || !upload || !audioUrl) continue;

        await sleep(throttleMs);
        budget.spend(1);
        let ok = false;
        try {
          ok = await upload(audioUrl, title, `reprocess-${id}`);
        } catch (e) {
          if (isRateLimited(e)) break;
        }
        if (!ok) continue;
        // The stub is what makes recovery exactly-once: next run this id has a
        // vault note, so it takes the delete branch (and is refused there,
        // because the stub records zero verbatim) rather than re-uploading.
        try {
          await vault.createNote(emptySourceStub(t));
        } catch {
          /* if the stub fails we may retry the upload next run — safe, not destructive */
        }
        recoveredThisRun++;
        out.recovered++;
        emit({ kind: "recovered", id, title });
        continue;
      }
      // Two Fireflies transcripts of the same meeting slug to the same path.
      // Retry once with the transcript id appended, and never let one bad note
      // abort the run (which would strand the rest of the backlog).
      let created: Note;
      try {
        created = await vault.createNote(note);
      } catch (e) {
        if (!/path_conflict|409/.test(String((e as Error).message))) {
          out.skipped++;
          continue;
        }
        try {
          created = await vault.createNote({ ...note, path: `${note.path}-${id.slice(-6).toLowerCase()}` });
        } catch {
          out.skipped++;
          continue;
        }
      }
      candidates.set(id, [created.id]);
      out.created++;
      newThisRun++;
      emit({ kind: "ingested", id, title });

      // If this transcript is the replacement for an empty recording we recovered,
      // record the link both ways. That link is what later authorizes deleting the
      // empty original — never a guess, always a note that passed the ingest gate.
      const stub = awaitingReplacement.get(normTitle(title));
      if (stub && stub.metadata?.source_id !== id) {
        awaitingReplacement.delete(normTitle(title));
        await markNote(vault, stub.id, { fireflies_superseded_by_note: created.id });
        await markNote(vault, created.id, { fireflies_recovered_from: stub.metadata?.source_id ?? null });
      }
    }
  }

  return out;
}

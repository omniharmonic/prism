/**
 * Fathom → vault transcript ingester (Phase 3). Node port of the desktop's
 * transcript_sync Fathom path, so meeting transcripts flow into the vault from
 * the SERVER. Credential (API key) comes from the per-tenant secret store. Note
 * shape matches the desktop exactly (tags [transcript,fathom], path
 * vault/_inbox/transcripts/fathom/<date>-<slug>, metadata {type,source,source_id,…})
 * and it DEDUPES by source_id — so the desktop + server can briefly overlap
 * during cutover WITHOUT creating duplicates (each recording is ingested once).
 *
 * `fetch` is injectable so the parse/map logic is unit-tested without the API.
 */
import type { Note } from "../parachute";
import type { IngestVault } from "./matrix";

export interface FathomMeeting {
  recording_id?: string | number;
  id?: string | number;
  title?: string;
  meeting_title?: string;
  scheduled_start_time?: string;
  scheduled_at?: string;
  recording_start_time?: string;
  recorded_at?: string;
  created_at?: string;
  share_url?: string;
  calendar_invitees?: Array<{ name?: string; email?: string }>;
}

type FetchLike = typeof fetch;
const API = "https://api.fathom.ai/external/v1";

export class FathomClient {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async get(path: string): Promise<unknown> {
    const r = await this.fetchImpl(`${API}${path}`, { headers: { "X-Api-Key": this.apiKey } });
    if (!r.ok) throw new Error(`fathom ${path} → ${r.status}`);
    return r.json();
  }
  /** Best-effort GET returning "" on any non-2xx (summary/transcript are optional). */
  private async getSoft(path: string): Promise<unknown | null> {
    try {
      const r = await this.fetchImpl(`${API}${path}`, { headers: { "X-Api-Key": this.apiKey } });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  /** Meetings created after `sinceIso` (RFC3339). */
  async listMeetings(sinceIso: string): Promise<FathomMeeting[]> {
    const data = (await this.get(`/meetings?created_after=${encodeURIComponent(sinceIso)}`)) as { items?: FathomMeeting[] } | FathomMeeting[];
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  async summary(recordingId: string): Promise<string> {
    return parseSummary(await this.getSoft(`/recordings/${encodeURIComponent(recordingId)}/summary`));
  }
  async transcript(recordingId: string): Promise<string> {
    return parseTranscript(await this.getSoft(`/recordings/${encodeURIComponent(recordingId)}/transcript`));
  }
}

// ── pure parse/map (unit-tested) ─────────────────────────────────────────────

export function parseSummary(data: unknown): string {
  const d = (data ?? {}) as Record<string, any>;
  const md =
    d.markdown ??
    d.summary?.markdown_formatted ??
    d.summary?.markdown ??
    d.recording?.markdown_formatted ??
    d.content ??
    "";
  return typeof md === "string" ? md : "";
}

export function parseTranscript(data: unknown): string {
  const d = (data ?? {}) as Record<string, any>;
  const segs: any[] = d.transcript ?? d.items ?? d.segments ?? [];
  if (!Array.isArray(segs)) return "";
  return segs
    .map((s) => {
      const speaker = s?.speaker_display_name ?? s?.speaker ?? "Speaker";
      const text = s?.text ?? "";
      return text ? `**${speaker}**: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

export const recordingIdOf = (m: FathomMeeting): string => {
  const v = m.recording_id ?? m.id;
  return v == null ? "" : String(v);
};
const titleOf = (m: FathomMeeting): string => m.title ?? m.meeting_title ?? "Untitled Meeting";
const dateOf = (m: FathomMeeting): string => {
  const s = m.scheduled_start_time ?? m.scheduled_at ?? m.recording_start_time ?? m.recorded_at ?? m.created_at ?? "";
  return s.length >= 10 ? s.slice(0, 10) : s;
};
const attendeesOf = (m: FathomMeeting): string[] =>
  (m.calendar_invitees ?? []).map((a) => a.name ?? a.email).filter((x): x is string => !!x);
const sanitizePath = (s: string): string =>
  (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

/** Build the transcript note (matches the desktop's Fathom note verbatim). */
export function fathomNote(m: FathomMeeting, summary: string, transcript: string): {
  content: string;
  path: string;
  tags: string[];
  metadata: Record<string, unknown>;
} {
  const title = titleOf(m);
  const date = dateOf(m);
  const rid = recordingIdOf(m);
  const shareUrl = m.share_url ?? "";
  const attendees = attendeesOf(m);
  let content = `---\ntitle: "${title}"\ndate: ${date}\nsource: fathom\nrecording_id: "${rid}"\nfathom_url: "${shareUrl}"\nattendees:\n`;
  for (const a of attendees) content += `  - ${a}\n`;
  content += "---\n\n";
  if (summary) content += `## Summary\n\n${summary}\n\n`;
  if (transcript) content += `## Transcript\n\n${transcript}\n`;
  return {
    content,
    path: `vault/_inbox/transcripts/fathom/${date}-${sanitizePath(title)}`,
    tags: ["transcript", "fathom"],
    metadata: {
      type: "transcript",
      source: "fathom",
      source_id: rid,
      synced_at: new Date().toISOString(),
      title,
      date,
      attendees,
      fathom_url: shareUrl,
    },
  };
}

export interface FathomIngestResult {
  meetings: number;
  created: number;
  skipped: number;
}

/** Ingest recent Fathom meetings (last `days`, default 7). Dedupes by source_id
 *  against existing transcript notes — create-only, never re-appends. */
export async function ingestFathom(
  client: Pick<FathomClient, "listMeetings" | "summary" | "transcript">,
  vault: IngestVault,
  opts: { days?: number; now?: number } = {},
): Promise<FathomIngestResult> {
  const days = opts.days ?? 7;
  const sinceIso = new Date((opts.now ?? Date.now()) - days * 86_400_000).toISOString();
  const meetings = await client.listMeetings(sinceIso);

  const existing = await vault.listNotes({ tags: ["transcript"], includeContent: false });
  const seen = new Set<string>();
  for (const n of existing) {
    const sid = (n.metadata?.source_id ?? n.metadata?.sourceId) as string | undefined;
    if (sid) seen.add(sid);
  }

  let created = 0;
  let skipped = 0;
  for (const m of meetings) {
    const rid = recordingIdOf(m);
    if (!rid || seen.has(rid)) {
      skipped++;
      continue;
    }
    const [summary, transcript] = await Promise.all([client.summary(rid), client.transcript(rid)]);
    if (!summary && !transcript) {
      skipped++;
      continue;
    }
    await vault.createNote(fathomNote(m, summary, transcript));
    seen.add(rid); // guard against dupes within one run
    created++;
  }
  return { meetings: meetings.length, created, skipped };
}

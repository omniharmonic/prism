/**
 * Durable, server-owned journal of transcript ↔ meeting link decisions.
 *
 * Note metadata is editable by anyone with edit on that one note, so it is never
 * the authority to modify ANOTHER note. This journal is. Every row is scoped to
 * the vault id AND the registry identity (`[url, vault]`) it was written under,
 * so a replaced registry entry starts at revision 0 with no receipts.
 *
 * Tables are created here (not in db.ts) so this slice owns its schema.
 */
import { randomUUID } from "node:crypto";
import { db, resolveVaultEntry } from "./db";

db.exec(`
CREATE TABLE IF NOT EXISTS transcript_link_state (
  vault_id TEXT NOT NULL,
  vault_identity TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  meeting_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual','auto')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, vault_identity, transcript_id)
);
CREATE INDEX IF NOT EXISTS transcript_link_state_meeting
  ON transcript_link_state (vault_id, vault_identity, meeting_id);
CREATE TABLE IF NOT EXISTS transcript_link_suppressions (
  vault_id TEXT NOT NULL,
  vault_identity TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  event_id TEXT NOT NULL DEFAULT '',
  decision_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, vault_identity, transcript_id, meeting_id)
);
CREATE TABLE IF NOT EXISTS transcript_link_decisions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  vault_identity TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  from_meeting_id TEXT,
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link','unlink')),
  reason TEXT NOT NULL,
  evidence TEXT,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','applied','superseded')),
  step INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  UNIQUE (vault_id, vault_identity, actor, request_id)
);
CREATE INDEX IF NOT EXISTS transcript_link_decisions_transcript
  ON transcript_link_decisions (vault_id, vault_identity, transcript_id, state);
`);

export const TRANSCRIPT_LINK_TABLES = [
  "transcript_link_state",
  "transcript_link_suppressions",
  "transcript_link_decisions",
] as const;

export interface LinkScope {
  vaultId: string;
  identity: string;
}

export interface LinkState {
  revision: number;
  meeting_id: string | null;
  origin: "manual" | "auto";
}

export interface DecisionRow {
  id: string;
  transcript_id: string;
  meeting_id: string;
  from_meeting_id: string | null;
  actor: string;
  request_id: string;
  body_hash: string;
  action: "link" | "unlink";
  reason: string;
  evidence: string | null;
  revision: number;
  state: "pending" | "applied" | "superseded";
  step: number;
}

/** The scope for a vault id, or null when the id no longer names a registry entry. */
export function linkScope(vaultId: string): LinkScope | null {
  const entry = resolveVaultEntry(vaultId);
  if (entry.id !== vaultId) return null;
  return { vaultId, identity: JSON.stringify([entry.url, entry.vault]) };
}

export function getLinkState(s: LinkScope, transcriptId: string): LinkState | null {
  return (
    (db
      .prepare("SELECT revision, meeting_id, origin FROM transcript_link_state WHERE vault_id=? AND vault_identity=? AND transcript_id=?")
      .get(s.vaultId, s.identity, transcriptId) as LinkState | undefined) ?? null
  );
}

/** Transcripts the journal says are linked to this meeting. */
export function journalTranscriptsFor(s: LinkScope, meetingId: string): string[] {
  return (
    db
      .prepare("SELECT transcript_id FROM transcript_link_state WHERE vault_id=? AND vault_identity=? AND meeting_id=? ORDER BY transcript_id")
      .all(s.vaultId, s.identity, meetingId) as { transcript_id: string }[]
  ).map((r) => r.transcript_id);
}

export function findDecision(s: LinkScope, actor: string, requestId: string): DecisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM transcript_link_decisions WHERE vault_id=? AND vault_identity=? AND actor=? AND request_id=?")
      .get(s.vaultId, s.identity, actor, requestId) as DecisionRow | undefined) ?? null
  );
}

export function pendingDecisions(s: LinkScope, actor?: string): DecisionRow[] {
  return db
    .prepare(
      `SELECT * FROM transcript_link_decisions WHERE vault_id=? AND vault_identity=? AND state='pending'${actor ? " AND actor=?" : ""} ORDER BY created_at, id`,
    )
    .all(...(actor ? [s.vaultId, s.identity, actor] : [s.vaultId, s.identity])) as DecisionRow[];
}

/** A manual unlink of (transcript, meeting) or of the same calendar event. */
export function isSuppressed(s: LinkScope, transcriptId: string, meetingId: string | null, eventId: string | null): boolean {
  const rows = db
    .prepare("SELECT meeting_id, event_id FROM transcript_link_suppressions WHERE vault_id=? AND vault_identity=? AND transcript_id=?")
    .all(s.vaultId, s.identity, transcriptId) as { meeting_id: string; event_id: string }[];
  return rows.some((r) => (!!meetingId && r.meeting_id === meetingId) || (!!eventId && r.event_id === eventId));
}

/**
 * Accept a decision: ONE transaction inserts the pending journal row, bumps the
 * transcript's revision and desired link, records/clears the manual-unlink
 * suppression and supersedes older pending rows for the transcript.
 */
export function acceptDecision(
  s: LinkScope,
  p: {
    transcriptId: string;
    meetingId: string;
    fromMeetingId: string | null;
    desiredMeetingId: string | null;
    actor: string;
    requestId: string;
    bodyHash: string;
    action: "link" | "unlink";
    reason: string;
    evidence?: string[];
    origin: "manual" | "auto";
    eventId: string | null;
  },
): DecisionRow {
  const id = randomUUID();
  const now = Date.now();
  db.transaction(() => {
    const revision = (getLinkState(s, p.transcriptId)?.revision ?? 0) + 1;
    db.prepare(
      "UPDATE transcript_link_decisions SET state='superseded' WHERE vault_id=? AND vault_identity=? AND transcript_id=? AND state='pending'",
    ).run(s.vaultId, s.identity, p.transcriptId);
    db.prepare(
      `INSERT INTO transcript_link_decisions
        (id, vault_id, vault_identity, transcript_id, meeting_id, from_meeting_id, actor, request_id, body_hash, action, reason, evidence, revision, state, step, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?)`,
    ).run(
      id, s.vaultId, s.identity, p.transcriptId, p.meetingId, p.fromMeetingId, p.actor, p.requestId, p.bodyHash, p.action, p.reason,
      p.evidence ? JSON.stringify(p.evidence) : null, revision, now,
    );
    db.prepare(
      `INSERT INTO transcript_link_state (vault_id, vault_identity, transcript_id, revision, meeting_id, origin, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(vault_id, vault_identity, transcript_id)
       DO UPDATE SET revision=excluded.revision, meeting_id=excluded.meeting_id, origin=excluded.origin, updated_at=excluded.updated_at`,
    ).run(s.vaultId, s.identity, p.transcriptId, revision, p.desiredMeetingId, p.origin, now);
    if (p.origin === "manual") {
      if (p.action === "unlink") {
        db.prepare(
          `INSERT INTO transcript_link_suppressions (vault_id, vault_identity, transcript_id, meeting_id, event_id, decision_id)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(vault_id, vault_identity, transcript_id, meeting_id)
           DO UPDATE SET event_id=excluded.event_id, decision_id=excluded.decision_id`,
        ).run(s.vaultId, s.identity, p.transcriptId, p.meetingId, p.eventId ?? "", id);
      } else {
        db.prepare(
          "DELETE FROM transcript_link_suppressions WHERE vault_id=? AND vault_identity=? AND transcript_id=? AND (meeting_id=? OR (event_id<>'' AND event_id=?))",
        ).run(s.vaultId, s.identity, p.transcriptId, p.meetingId, p.eventId ?? "");
      }
    }
  })();
  return db.prepare("SELECT * FROM transcript_link_decisions WHERE id=?").get(id) as DecisionRow;
}

export function setDecisionStep(id: string, step: number): void {
  db.prepare("UPDATE transcript_link_decisions SET step=? WHERE id=?").run(step, id);
}

export function markDecisionApplied(id: string): void {
  db.prepare("UPDATE transcript_link_decisions SET state='applied', applied_at=? WHERE id=? AND state='pending'").run(Date.now(), id);
}

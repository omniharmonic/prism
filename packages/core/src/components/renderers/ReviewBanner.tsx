/**
 * The review banner — what a contributor sees on a note they may improve but may
 * not publish (P4).
 *
 * The old behavior for that person was a lie by omission: the editor looked
 * writable, autosave fired, and the gateway answered 403 into a void. This
 * replaces it with the honest affordance — keep typing, then submit the result
 * as a governed `edit_note` proposal that a steward reviews.
 *
 * GATING (this is the whole safety story): the banner is rendered only when
 * `reviewMode(note)` is not "none", and `reviewMode` is driven by the gateway's
 * `_caps` annotation, which the Prism Server adds ONLY for non-owner actors. The
 * desktop shell reads the vault directly and a web owner is served by the
 * transparent passthrough, so neither ever carries `_caps` and neither can ever
 * render this component. See lib/governance/review.ts.
 */
import { useCallback, useState } from "react";
import { CheckCircle2, History, Send, Eye, AlertTriangle } from "lucide-react";
import { fetchRevisions, type NoteRevision, type ReviewMode } from "../../lib/governance/review";
import { submitForReview } from "../../lib/governance/review";

const wrap: React.CSSProperties = {
  margin: "0 auto",
  maxWidth: "var(--content-measure)",
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  background: "var(--glass-bg, var(--glass))",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const line: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  fontSize: 13,
  lineHeight: 1.45,
  color: "var(--text-secondary)",
};

const button: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12.5,
  fontWeight: 500,
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--glass-border)",
  background: "var(--glass)",
  color: "var(--text-primary)",
  cursor: "pointer",
};

const linkButton: React.CSSProperties = {
  ...button,
  border: "none",
  background: "none",
  color: "var(--text-secondary)",
  padding: "5px 4px",
};

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; id: string }
  | { kind: "failed"; message: string };

export function ReviewBanner({
  noteId,
  mode,
  getContent,
}: {
  noteId: string;
  /** "propose" → editable + submit; "read-only" → the one-line notice. */
  mode: Exclude<ReviewMode, "none">;
  /** The editor's current HTML — read at click time, never cached. */
  getContent: () => string;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setStatus({ kind: "sending" });
    const r = await submitForReview(noteId, getContent());
    setStatus(r.ok ? { kind: "sent", id: r.data.id } : { kind: "failed", message: r.error });
  }, [noteId, getContent]);

  const toggleHistory = useCallback(async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next || revisions !== null) return;
    const r = await fetchRevisions(noteId);
    if (r.ok) setRevisions(r.data);
    else setHistoryError(r.error);
  }, [historyOpen, revisions, noteId]);

  return (
    <div style={wrap} data-testid="review-banner" data-review-mode={mode}>
      <div style={line}>
        {mode === "read-only" ? (
          <>
            <Eye size={14} style={{ flexShrink: 0 }} />
            <span data-testid="review-readonly-notice">
              You have read access to this note. Editing it requires permission from a steward.
            </span>
          </>
        ) : status.kind === "sent" ? (
          <>
            <CheckCircle2 size={14} style={{ flexShrink: 0, color: "var(--color-success, #2e7d32)" }} />
            <span data-testid="review-submitted">
              Submitted for review — proposal <code>{status.id}</code>. It goes live once enough members approve it.
            </span>
          </>
        ) : (
          <>
            <span>
              You don&apos;t have direct edit access. Changes you make here can be submitted for review.
            </span>
            <button
              type="button"
              style={{ ...button, opacity: status.kind === "sending" ? 0.6 : 1 }}
              disabled={status.kind === "sending"}
              onClick={() => void submit()}
              data-testid="submit-for-review"
            >
              <Send size={13} /> {status.kind === "sending" ? "Submitting…" : "Submit for review"}
            </button>
          </>
        )}

        <span style={{ flex: 1 }} />
        <button type="button" style={linkButton} onClick={() => void toggleHistory()} data-testid="review-history-toggle">
          <History size={13} /> History
        </button>
      </div>

      {status.kind === "failed" && (
        <div style={{ ...line, color: "var(--color-error, #c62828)" }} data-testid="review-error">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span>{status.message}</span>
        </div>
      )}

      {historyOpen && <RevisionList revisions={revisions} error={historyError} />}
    </div>
  );
}

/**
 * The note's revision trail, read-only. Rolling back is a governed act with a
 * `publish` power behind it — it stays in the governance panel; this is the
 * "what happened to this page" answer a reader needs in place.
 */
function RevisionList({ revisions, error }: { revisions: NoteRevision[] | null; error: string | null }) {
  if (error) {
    return (
      <div style={{ ...line, fontSize: 12.5 }} data-testid="review-history">
        Couldn&apos;t load the history: {error}
      </div>
    );
  }
  if (revisions === null) {
    return (
      <div style={{ ...line, fontSize: 12.5 }} data-testid="review-history">
        Loading history…
      </div>
    );
  }
  if (revisions.length === 0) {
    return (
      <div style={{ ...line, fontSize: 12.5 }} data-testid="review-history">
        No recorded revisions yet — approved changes to this note will show up here.
      </div>
    );
  }
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflow: "auto" }}
      data-testid="review-history"
    >
      {revisions.map((r) => (
        <div
          key={r.id}
          data-testid="review-history-row"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}
        >
          <span style={{ whiteSpace: "nowrap" }}>{formatTime(r.at)}</span>
          <span style={{ color: "var(--text-primary)" }}>{r.author || "unknown"}</span>
          <span>{r.origin}</span>
          {r.published && (
            <span
              style={{
                fontSize: 10.5,
                padding: "1px 6px",
                borderRadius: 999,
                border: "1px solid var(--glass-border)",
                color: "var(--color-success, #2e7d32)",
              }}
            >
              published
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || "";
  return new Date(t).toLocaleString();
}

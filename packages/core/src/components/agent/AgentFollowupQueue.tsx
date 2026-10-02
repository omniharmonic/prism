import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { AgentSourcePreview } from "./AgentSourcePreview";
import { AgentSnapshotPreview } from "./AgentSnapshotAttachments";
import type { AgentContextSnapshot } from "../../lib/agent/contextSnapshots";
import type {
  AgentClient,
  AgentFollowup,
  AgentPermissionMode,
} from "../../lib/agent/sessions";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";

export const followupKey = (client: AgentClient, id: string) => [
  "agent-followups",
  client.scope?.() ?? null,
  id,
];
const button =
  "focus-ring min-h-10 rounded-lg px-2 py-2 text-xs hover:bg-[var(--glass-hover)] disabled:opacity-40";
const modeLabel = (mode: AgentPermissionMode) =>
  mode === "read-only"
    ? "Read-only"
    : mode === "suggest"
      ? "Suggested edits only"
      : "Read/write";
export function AgentFollowupQueue({
  client,
  sessionId,
  mode,
  policyVersion,
  onAdmitted,
}: {
  client: AgentClient;
  sessionId: string;
  mode: AgentPermissionMode;
  policyVersion: number;
  onAdmitted: () => void;
}) {
  const scope = client.scope?.() ?? null;
  const queries = useQueryClient();
  const [editing, setEditing] = useState<AgentFollowup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const previousIds = useRef<string[] | null>(null);
  const query = useQuery({
    queryKey: followupKey(client, sessionId),
    queryFn: async () => {
      const data = await client.listFollowups!(sessionId);
      if ((client.scope?.() ?? null) !== scope)
        throw Error("Workspace changed");
      return data;
    },
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const rows = query.isError ? [] : (query.data?.followups ?? []);
  useEffect(() => {
    if (!query.data || query.isError) return;
    const ids = query.data.followups.map((r) => r.id);
    if (previousIds.current?.some((id) => !ids.includes(id))) onAdmitted();
    previousIds.current = ids;
  }, [query.data, query.isError, onAdmitted]);
  async function cancel(row: AgentFollowup) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await client.changeFollowup!(sessionId, row.id, {
        version: row.version,
        action: "cancel",
      });
      await queries.invalidateQueries({
        queryKey: followupKey(client, sessionId),
      });
    } catch {
      if ((client.scope?.() ?? null) === scope)
        setError(
          "The queue changed or the request failed. Refresh before trying again.",
        );
    } finally {
      lock.current = false;
      if ((client.scope?.() ?? null) === scope) setBusy(false);
    }
  }
  if (!rows.length && !query.isError) return null;
  return (
    <section
      aria-label="Queued follow-ups"
      className="mb-3 rounded-xl border border-[var(--glass-border)] p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Next up · {rows.length}</h3>
        <span className="text-[var(--text-muted)]">Runs after this turn</span>
      </div>
      {query.isError && (
        <p role="alert">
          Could not load queued messages.{" "}
          <button className={button} onClick={() => void query.refetch()}>
            Refresh queue
          </button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}
          <button
            className={button}
            onClick={() => {
              setError("");
              void query.refetch();
            }}
          >
            Refresh queue
          </button>
        </p>
      )}
      <ol className="max-h-44 overflow-auto">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className="mt-2 border-t border-[var(--glass-border)] pt-2"
          >
            <p className="line-clamp-3 whitespace-pre-wrap break-words">
              {index + 1}. {row.payload.prompt}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[var(--text-muted)]">
              <span>{modeLabel(row.permissionMode)}</span>
              {row.status === "blocked" ? (
                <span>Paused · review required</span>
              ) : row.status === "dispatching" ? (
                <span>Starting…</span>
              ) : (
                <span>Queued</span>
              )}
              {row.status !== "dispatching" && (
                <>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => setEditing(row)}
                  >
                    {row.status === "blocked" ? "Review & resume" : "Edit"}
                  </button>
                  <button
                    className={button}
                    aria-label={`Remove queued message ${index + 1}`}
                    disabled={busy}
                    onClick={() => void cancel(row)}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {editing && (
        <FollowupEditor
          key={editing.id}
          client={client}
          row={editing}
          mode={mode}
          policyVersion={policyVersion}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queries.invalidateQueries({
              queryKey: followupKey(client, sessionId),
            });
            onAdmitted();
          }}
        />
      )}
    </section>
  );
}
function FollowupEditor({
  client,
  row,
  mode,
  policyVersion,
  onClose,
  onSaved,
}: {
  client: AgentClient;
  row: AgentFollowup;
  mode: AgentPermissionMode;
  policyVersion: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const scope = client.scope?.() ?? null;
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [reviewedPolicy] = useState({ mode, version: policyVersion });
  const [source, setSource] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AgentContextSnapshot | null>(null);
  const savedSources = [
    ...new Set(
      [row.payload.noteId, ...(row.payload.contextNoteIds ?? [])].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const draft = useScopedDraft("agent-followup-edit", scope, row.id);
  const [text, setText] = useState(draft.text || row.payload.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current;
    modal?.showModal();
    return () => {
      modal?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function save() {
    if (lock.current || !text.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await client.changeFollowup!(row.sessionId, row.id, {
        version: row.version,
        action: row.status === "blocked" ? "resume" : "edit",
        policyVersion: reviewedPolicy.version,
        payload: { ...row.payload, prompt: text.trim() },
      });
      if ((client.scope?.() ?? null) !== scope) return;
      draft.clearIfUnchanged(text);
      onSaved();
    } catch {
      if ((client.scope?.() ?? null) === scope)
        setError(
          "This queued message changed or could not be saved. Your draft is kept. Close and reopen it to review the current queue before retrying.",
        );
    } finally {
      lock.current = false;
      if ((client.scope?.() ?? null) === scope) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="agent-source-preview"
      aria-label="Edit queued message"
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-3 p-4"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {row.status === "blocked"
              ? "Review queued message"
              : "Edit queued message"}
          </h2>
          <button
            type="button"
            className={button}
            aria-label="Close queued message"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {row.error && <p className="text-xs">{row.error}</p>}
        <p className="text-xs text-[var(--text-secondary)]">
          {row.status === "blocked"
            ? `Resuming uses the session’s current permissions: ${modeLabel(reviewedPolicy.mode)}.`
            : `Queued with ${modeLabel(row.permissionMode)} permissions. A change pauses this message for review.`}{" "}
          Sources are checked again before this message starts.
        </p>
        {(savedSources.length > 0 ||
          !!row.payload.contextSnapshots?.length) && (
          <section
            aria-label="Queued context"
            className="space-y-2 rounded-lg border border-[var(--glass-border)] p-3"
          >
            <h3 className="text-xs font-medium">Context for this message</h3>
            <p className="text-xs text-[var(--text-muted)]">
              Saved notes use their latest text when the turn starts. Captured
              text stays exactly as attached.
            </p>
            <div className="flex flex-wrap gap-2">
              {savedSources.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  className={button + " border border-[var(--glass-border)]"}
                  onClick={() => setSource(id)}
                >
                  {id === row.payload.noteId
                    ? "Preview working document"
                    : `Preview saved note ${index + 1}`}
                </button>
              ))}
              {row.payload.contextSnapshots?.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  className={button + " border border-[var(--glass-border)]"}
                  onClick={() => setSnapshot(item)}
                >
                  Preview captured {item.kind} {index + 1}
                </button>
              ))}
            </div>
          </section>
        )}
        <textarea
          autoFocus
          aria-label="Queued instruction"
          className="focus-ring min-h-32 w-full resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] p-3 text-base"
          value={text}
          disabled={busy}
          maxLength={50000}
          onChange={(e) => {
            setText(e.target.value);
            draft.setText(e.target.value);
          }}
        />
        {draft.error && (
          <p role="status" className="text-xs">
            {draft.error}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className={button + " border border-[var(--glass-border)]"}
        >
          {busy
            ? "Saving…"
            : row.status === "blocked"
              ? "Resume with these permissions"
              : "Save queued message"}
        </button>
      </form>
      {source && (
        <AgentSourcePreview noteId={source} onClose={() => setSource(null)} />
      )}
      {snapshot && (
        <AgentSnapshotPreview
          snapshot={snapshot}
          onClose={() => setSnapshot(null)}
        />
      )}
    </dialog>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, History, RotateCcw, X } from "lucide-react";
import type { NoteVersionSummary } from "../../data/VaultClient";
import { HistoryConflictError } from "../../data/VaultClient";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { reviewMode } from "../../lib/governance/review";
import { useNoteVersion, useRestoreVersion, useHistorySource } from "../../app/hooks/useNoteHistory";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { contentAsText, diffMetadata, diffText, type DiffRow } from "../../lib/history/diff";
import { sanitizeHtml } from "../../lib/html/sanitize";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { ago, formatWhen, opLabel, savedAt } from "./labels";

type Compare = "current" | "previous";
type View = "changes" | "full";

const tint = (color: string, pct: number) => `color-mix(in srgb, var(${color}) ${pct}%, transparent)`;

/**
 * Full-size view of one saved version: what restoring it would change (diffed
 * against the current note), what changed in it (diffed against the version
 * before), or its full text — and a two-step Restore. ←/→ step through versions.
 */
export function VersionViewer({
  noteId,
  versions,
  index,
  onIndexChange,
  onClose,
  canRestore,
  onRestored,
}: {
  noteId: string;
  versions: NoteVersionSummary[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  canRestore: boolean;
  onRestored: (when: string | null) => void;
}) {
  const isMobile = useIsMobile();
  const client = useVaultClient();
  const audience = useAgentChatStore(state => state.scope);
  const scope = client.scope?.() ?? audience;
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  const summary = versions[index]!;
  const older = versions[index + 1];
  const [compare, setCompare] = useState<Compare>("current");
  const [view, setView] = useState<View>("changes");
  const [confirming, setConfirming] = useState(false);

  const currentSource = useHistorySource(noteId);
  const current = currentSource.data;
  const selected = useNoteVersion(noteId, summary.versionIx);
  const previous = useNoteVersion(noteId, compare === "previous" && older ? older.versionIx : null);
  const restore = useRestoreVersion();

  // Reset per-version UI state when stepping through versions.
  useEffect(() => {
    setConfirming(false);
    restore.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      if (e.key === "ArrowLeft" && index + 1 < versions.length) onIndexChange(index + 1);
      if (e.key === "ArrowRight" && index > 0) onIndexChange(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, versions.length, onClose, onIndexChange]);

  // Direction matters: vs current reads "what restoring does" (current → this),
  // vs previous reads "what this edit changed" (older → this).
  const baseSource = compare === "current" ? current : previous.data;
  const base = baseSource ? { content: baseSource.content, metadata: baseSource.metadata } : null;
  // Keyed on the cached objects (stable across renders) — diffing a large note is not free.
  const diff = useMemo(() => {
    if (!baseSource || !selected.data) return null;
    return diffText(contentAsText(baseSource.content), contentAsText(selected.data.content));
  }, [baseSource, selected.data]);
  const metaChanges = useMemo(
    () => (baseSource && selected.data ? diffMetadata(baseSource.metadata, selected.data.metadata) : []),
    [baseSource, selected.data],
  );

  const when = savedAt(versions, index);
  const unrecoverable = selected.data?.content === null;
  const isIdentical = compare === "current" && diff && diff.added === 0 && diff.removed === 0 && metaChanges.length === 0;

  const allowedRestore = canRestore && !!current && reviewMode(current) === "none";
  const doRestore = () => {
    if (!allowedRestore || !selected.data || selected.isFetching || restore.isPending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    restore.mutate(
      { noteId, versionIx: summary.versionIx, expectedScope: scope },
      { onSuccess: () => onRestored(when) },
    );
  };

  const restoreError = restore.error
    ? restore.error instanceof HistoryConflictError
      ? restore.error.message
      : "This version could not be restored. Check your connection and edit access, then try again."
    : null;

  // Portaled to <body>: the context panel is a transformed drawer on mobile, and a
  // `position: fixed` child of a transformed ancestor is fixed to THAT box, not
  // the viewport — the viewer would be trapped inside the sidebar.
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="Version history"
      className="prism-version-dialog"
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(control => control.getClientRects().length > 0);
        event.preventDefault();
        if (!controls.length) { event.currentTarget.focus(); return; }
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        controls[next]?.focus();
      }}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="prism-version-layout flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <History size={16} style={{ color: "var(--color-accent)", flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
              {current && selected.data ? (when ? formatWhen(when) : "Oldest saved version") : "Saved version"}
            </div>
            <div className="text-xs leading-relaxed break-words" style={{ color: "var(--text-muted)" }}>
              {current && selected.data ? <>{when ? `${ago(when)} · ` : ""}then {opLabel(summary.op)} {ago(summary.supersededAt)}
              {summary.actor ? ` · ${summary.actor}` : ""}{summary.via ? ` · via ${summary.via}` : ""}</> : "Checking page access"}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Older version"
            title="Older version (←)"
            disabled={index + 1 >= versions.length}
            onClick={() => onIndexChange(index + 1)}
            icon={<ArrowLeft size={14} />}
          />
          <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            {versions.length - index}/{versions.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Newer version"
            title="Newer version (→)"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
            icon={<ArrowRight size={14} />}
          />
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} icon={<X size={16} />} />
        </div>

        {/* Controls */}
        <div
          className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
          style={{ borderBottom: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}
        >
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { id: "changes", label: "Changes" },
              { id: "full", label: "Full text" },
            ]}
          />
          {view === "changes" && (
            <>
              <span style={{ color: "var(--text-muted)" }}>compared with</span>
              <Segmented
                value={compare}
                onChange={setCompare}
                options={[
                  { id: "current", label: "Current note" },
                  { id: "previous", label: "Version before", disabled: !older },
                ]}
              />
            </>
          )}
          {view === "changes" && diff && (
            <span className="ml-auto tabular-nums">
              <span style={{ color: "var(--color-success)" }}>+{diff.added}</span>{" "}
              <span style={{ color: "var(--color-danger)" }}>−{diff.removed}</span> lines
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-3">
          {selected.error || currentSource.error || (compare === "previous" && previous.error) || selected.unavailable ? (
            <div role="alert" className="prism-context-state"><p>This version could not be loaded. Check your connection and page access.</p>
              <button type="button" onClick={() => { void selected.refetch(); void currentSource.refetch(); if (compare === "previous" && older) void previous.refetch(); }}>Try again</button>
            </div>
          ) : !selected.data || selected.isFetching || currentSource.isFetching || (view === "changes" && !base) ? (
            <div role="status" className="flex justify-center gap-2 pt-16">
              <Spinner size={20} /> Loading version…
            </div>
          ) : unrecoverable ? (
            <Notice>
              This version was over 2 MB when it was replaced, so Parachute recorded that it existed but not its text. It
              can't be viewed or restored.
            </Notice>
          ) : view === "full" ? (
            <FullText content={selected.data!.content ?? ""} />
          ) : isIdentical ? (
            <Notice>This version is identical to the current note.</Notice>
          ) : (
            <>
              {metaChanges.length > 0 && (
                <div className="mb-4 rounded-lg p-3 text-xs" style={{ background: "var(--glass)" }}>
                  <div className="font-medium mb-1.5" style={{ color: "var(--text-secondary)" }}>
                    Properties
                  </div>
                  {metaChanges.map((m) => (
                    <div key={m.key} className="flex gap-2 py-0.5 font-mono" style={{ color: "var(--text-primary)" }}>
                      <span style={{ color: "var(--text-muted)", minWidth: 120 }}>{m.key}</span>
                      {m.before !== undefined && (
                        <span style={{ background: tint("--color-danger", 16), textDecoration: "line-through" }}>
                          {short(m.before)}
                        </span>
                      )}
                      {m.after !== undefined && (
                        <span style={{ background: tint("--color-success", 18) }}>{short(m.after)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {diff && <DiffView rows={diff.rows} />}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex flex-wrap items-center gap-3 px-4 py-3"
          style={{
            borderTop: "1px solid var(--glass-border)",
            paddingBottom: isMobile ? "calc(12px + env(safe-area-inset-bottom))" : undefined,
          }}
        >
          <div className="flex-1 min-w-[200px] text-xs" style={{ color: restoreError ? "var(--color-danger)" : "var(--text-muted)" }}>
            {restoreError ??
              (allowedRestore
                ? "Restoring replaces the note's text and properties; tags and location stay as they are. The current version is saved to history first, so you can undo."
                : "You can view this version, but restoring needs edit access.")}
          </div>
          {allowedRestore && (
            <>
              {confirming && (
                <Button variant="ghost" size="md" onClick={() => setConfirming(false)} disabled={restore.isPending}>
                  Cancel
                </Button>
              )}
              <Button
                variant="primary"
                size="md"
                icon={<RotateCcw size={14} />}
                loading={restore.isPending}
                disabled={unrecoverable || !selected.data || selected.isFetching || !!isIdentical}
                onClick={doRestore}
              >
                {confirming ? "Confirm restore" : "Restore this version"}
              </Button>
            </>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ id: T; label: string; disabled?: boolean }>;
}) {
  return (
    <div className="inline-flex rounded-md p-0.5" style={{ background: "var(--glass)" }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className="px-2 py-1 rounded text-xs transition-colors disabled:opacity-40"
          style={{
            background: value === o.id ? "var(--bg-elevated)" : "transparent",
            color: value === o.id ? "var(--text-primary)" : "var(--text-secondary)",
            boxShadow: value === o.id ? "0 1px 2px rgba(0,0,0,0.15)" : undefined,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (rows.length === 0) return <Notice>No text changes.</Notice>;
  return (
    <div className="text-sm leading-relaxed" style={{ fontFamily: "var(--font-sans)" }}>
      {rows.map((r, i) => {
        if (r.kind === "fold") {
          if (open.has(i)) {
            return r.lines.map((t, j) => <Line key={`${i}-${j}`} text={t} />);
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => setOpen(new Set(open).add(i))}
              className="w-full text-left text-xs my-1 px-2 py-1 rounded"
              style={{ color: "var(--text-muted)", background: "var(--glass)" }}
            >
              ⋯ {r.lines.length} unchanged line{r.lines.length === 1 ? "" : "s"}
            </button>
          );
        }
        if (r.kind === "edit") {
          return (
            <div key={i} className="px-2 py-0.5 rounded-sm whitespace-pre-wrap" style={{ borderLeft: "2px solid var(--color-warning)" }}>
              {r.spans.map((s, j) => (
                <span
                  key={j}
                  style={
                    s.kind === "add"
                      ? { background: tint("--color-success", 24), borderRadius: 2 }
                      : s.kind === "del"
                        ? { background: tint("--color-danger", 20), textDecoration: "line-through", borderRadius: 2 }
                        : undefined
                  }
                >
                  {s.text}
                </span>
              ))}
            </div>
          );
        }
        return <Line key={i} text={r.text} kind={r.kind} />;
      })}
    </div>
  );
}

function Line({ text, kind = "same" }: { text: string; kind?: "same" | "add" | "del" }) {
  const style =
    kind === "add"
      ? { background: tint("--color-success", 14), borderLeft: "2px solid var(--color-success)" }
      : kind === "del"
        ? { background: tint("--color-danger", 12), borderLeft: "2px solid var(--color-danger)", textDecoration: "line-through" }
        : { borderLeft: "2px solid transparent", color: "var(--text-secondary)" };
  return (
    <div className="px-2 py-0.5 whitespace-pre-wrap" style={style}>
      {text || " "}
    </div>
  );
}

function FullText({ content }: { content: string }) {
  const trimmed = content.trim();
  if (trimmed.startsWith("<") && !trimmed.startsWith("<svg")) {
    return <div className="prose-editor" dangerouslySetInnerHTML={{ __html: sanitizeHtml(content) }} />;
  }
  return (
    <pre className="text-sm whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
      {content}
    </pre>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm text-center pt-12 px-6" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

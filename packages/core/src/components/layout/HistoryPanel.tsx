import { useEffect, useState, type ReactNode } from "react";
import { Check, CheckCheck, Clock, History, RotateCcw, Sparkles } from "lucide-react";
import type { Note } from "../../lib/types";
import { useNoteVersions } from "../../app/hooks/useNoteHistory";
import { useVaultClient } from "../../data/VaultClientContext";
import { reviewMode } from "../../lib/governance/review";
import { VersionViewer } from "../history/VersionViewer";
import { ago, dayLabel, formatWhen, opLabel, savedAt, sizeDelta } from "../history/labels";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { writerName, writerOf, writerTitle, type WriterInfo } from "../../lib/history/attribution";
import { PageUpdates } from "../sharing/PageUpdates";
import { PersonAvatar } from "../sharing/PersonAvatar";
import { useViewerEmail } from "../sharing/useViewerEmail";
import "./context-panels.css";

interface HistoryPanelProps {
  note: Note;
}

/**
 * A note's version history (Parachute vault ≥ 0.7.9): the current version, then
 * every saved earlier state grouped by day. Click one to compare it with the
 * current note or the version before it, read it in full, or restore it.
 * On a vault without history, falls back to the created/modified timeline.
 */
export function HistoryPanel({ note }: HistoryPanelProps) {
  const client = useVaultClient();
  const audience = useAgentChatStore(state => state.scope);
  const scope = client.scope?.() ?? audience;
  return <ScopedHistory key={JSON.stringify([scope, note.id])} note={note} />;
}

function ScopedHistory({ note }: HistoryPanelProps) {
  const client = useVaultClient();
  const history = useNoteVersions(note.id);
  const viewer = useViewerEmail();
  const [tab, setTab] = useState<"versions" | "updates">("versions");
  const [openIx, setOpenIx] = useState<number | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<string | null | undefined>(undefined);
  // Owners, desktop, and anyone holding `edit` (reviewMode "none"); propose/read-only
  // actors can browse but not restore — the gateway enforces the same rule.
  const canRestore = !!client.restoreNoteVersion && reviewMode(note) === "none";

  useEffect(() => {
    setOpenIx(null);
    setRestoredFrom(undefined);
  }, [note.id]);

  if (history.unavailable) return <LegacyTimeline note={note} />;

  const { versions, total } = history;
  const producedByRestore = versions[0]?.op === "restore";
  // The current version's own change: its size vs the newest saved version
  // (content_len is bytes, so measure the live note the same way).
  const currentDelta = versions[0]
    ? sizeDelta(versions[0].contentLength, new TextEncoder().encode(note.content ?? "").length)
    : undefined;

  const currentWriter = writerOf({ metadata: note.metadata }, viewer);
  return (
    <section className="prism-context-history space-y-3" aria-label="Page history">
      <header><h2>Version history</h2><p>Saved versions of this page</p></header>
      <div role="tablist" aria-label="History view" className="prism-history-tabs" style={{ display: "flex", gap: 16, borderBottom: "1px solid var(--glass-border)" }}>
        {(["versions", "updates"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            style={{ border: 0, background: "none", padding: "6px 0 8px", marginBottom: -1, font: "inherit", fontSize: 13, cursor: "pointer", color: tab === id ? "var(--text-primary)" : "var(--text-muted)", fontWeight: tab === id ? 600 : 450, borderBottom: tab === id ? "2px solid var(--color-accent)" : "2px solid transparent" }}
          >
            {id === "versions" ? "Versions" : "Updates"}
          </button>
        ))}
      </div>
      {tab === "updates" ? (
        <PageUpdates note={note} versions={versions} viewer={viewer} />
      ) : (<>
      {restoredFrom !== undefined && (
        <div
          className="flex items-start gap-2 rounded-lg p-2.5 text-xs"
          style={{ background: "color-mix(in srgb, var(--color-success) 14%, transparent)", color: "var(--text-primary)" }}
        >
          <Check size={14} style={{ color: "var(--color-success)", flexShrink: 0, marginTop: 1 }} />
          <div className="flex-1">
            Restored {restoredFrom ? `the version from ${formatWhen(restoredFrom)}` : "the oldest saved version"}. The text it
            replaced is the newest entry below — open it to undo.
          </div>
        </div>
      )}

      {/* Current */}
      <TimelineRow
        active
        title="Current version"
        writer={currentWriter}
        subtitle={
          note.updatedAt
            ? `${writerLine(currentWriter)}${producedByRestore ? "Restored" : "Saved"} ${formatWhen(note.updatedAt)} · ${ago(note.updatedAt)}`
            : undefined
        }
        icon={producedByRestore ? <RotateCcw size={10} /> : <Check size={10} />}
        badge={currentDelta && currentDelta.sign !== 0 ? currentDelta : undefined}
        last={versions.length === 0}
      />

      {(history.isLoading || (history.isFetching && !history.isFetchingNextPage)) ? (
        <div role="status" className="flex items-center justify-center gap-2 py-4 text-xs">
          <Spinner size={16} /> Loading history…
        </div>
      ) : history.error ? (
        <div role="alert" className="prism-context-state">
          <p>History could not be loaded. Check your connection and page access.</p>
          <button type="button" onClick={() => void history.refetch()}>Try again</button>
        </div>
      ) : versions.length === 0 ? (
        <div className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          No earlier versions yet. Saved versions will appear here as this page changes.
        </div>
      ) : (
        <div>
          {versions.map((v, i) => {
            const when = savedAt(versions, i);
            const day = dayLabel(when ?? v.supersededAt);
            const prevDay = i === 0 ? null : dayLabel(savedAt(versions, i - 1) ?? versions[i - 1]!.supersededAt);
            // What THIS save changed: its size vs the version before it.
            const older = versions[i + 1];
            const delta = older ? sizeDelta(older.contentLength, v.contentLength) : undefined;
            const writer = writerOf(v, viewer);
            return (
              <div key={v.versionIx}>
                {day !== prevDay && (
                  <div className="text-[11px] font-medium uppercase tracking-wide pt-2 pb-1" style={{ color: "var(--text-muted)" }}>
                    {day}
                  </div>
                )}
                <TimelineRow
                  onClick={() => setOpenIx(i)}
                  title={writer.kind === "unknown" ? (when ? formatWhen(when) : "Oldest saved version") : writerTitle(writer)}
                  writer={writer}
                  subtitle={`${writerLine(writer)}${writer.kind === "unknown" ? "" : when ? `${formatWhen(when)} · ` : "Oldest saved version · "}then ${opLabel(v.op)} ${ago(v.supersededAt)}${v.actor ? ` · ${v.actor}` : ""}${v.via ? ` · via ${v.via}` : ""}`}
                  badge={delta && delta.sign !== 0 ? delta : undefined}
                  icon={v.op === "restore" ? <RotateCcw size={10} /> : writer.kind === "agent" ? <Sparkles size={10} /> : writer.kind === "accepted-suggestion" ? <CheckCheck size={10} /> : <Clock size={10} />}
                  last={i === versions.length - 1}
                />
              </div>
            );
          })}
          {history.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full mt-1"
              loading={history.isFetchingNextPage}
              onClick={() => history.fetchNextPage()}
            >
              Load older versions ({total - versions.length} more)
            </Button>
          )}
        </div>
      )}

      <div className="text-[11px] leading-relaxed pt-2" style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}>
        {total > 0 ? `${total} saved version${total === 1 ? "" : "s"}. ` : ""}
        History availability and retention are managed by your vault.
      </div>
      </>)}

      {openIx !== null && versions[openIx] && (
        <VersionViewer
          noteId={note.id}
          versions={versions}
          index={openIx}
          onIndexChange={setOpenIx}
          onClose={() => setOpenIx(null)}
          canRestore={canRestore}
          onRestored={(when) => {
            setOpenIx(null);
            setRestoredFrom(when);
          }}
        />
      )}
    </section>
  );
}

/** "You · " / "Sam Chen · " before a row's time; nothing when unknown. */
function writerLine(w: WriterInfo): string {
  const who = writerName(w);
  return who ? `${who} · ` : "";
}

function TimelineRow({
  title,
  subtitle,
  writer,
  icon,
  badge,
  active,
  last,
  onClick,
}: {
  title: string;
  subtitle?: string;
  writer?: WriterInfo;
  icon: ReactNode;
  badge?: { text: string; sign: -1 | 0 | 1 };
  active?: boolean;
  last?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick ? event => { event.currentTarget.focus(); onClick(); } : undefined}
      className="prism-context-history-row w-full text-left flex items-start gap-2.5 py-1.5 px-1 -mx-1 rounded-md relative transition-colors"
      style={{ cursor: onClick ? "pointer" : "default" }}
      onMouseEnter={(e) => onClick && (e.currentTarget.style.background = "var(--glass-hover)")}
      onMouseLeave={(e) => onClick && (e.currentTarget.style.background = "transparent")}
    >
      {!last && (
        <div className="absolute left-[13px] top-7 bottom-[-6px] w-px" style={{ background: "var(--glass-border)" }} />
      )}
      <div
        className="w-[18px] h-[18px] rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{
          background: active ? "var(--color-accent)" : "var(--glass)",
          color: active ? "white" : "var(--text-muted)",
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm flex items-center gap-1.5" style={{ color: "var(--text-primary)", fontWeight: active ? 500 : 400 }}>
          <span className="truncate">{title}</span>
          {badge && (
            <span
              className="text-[10px] tabular-nums px-1 rounded"
              style={{
                color: badge.sign > 0 ? "var(--color-success)" : "var(--color-danger)",
                background: "var(--glass)",
              }}
            >
              {badge.text}
            </span>
          )}
        </div>
        {subtitle && (
          <div className="prism-context-history-detail text-xs" data-writer-kind={writer?.kind} style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            {writer && writerName(writer) && <PersonAvatar name={writerName(writer)} size={16} />}
            <span>{subtitle}</span>
          </div>
        )}
      </div>
    </Tag>
  );
}

/** Pre-0.7.9 vaults: the timestamps we do have, and what's coming. */
function LegacyTimeline({ note }: { note: Note }) {
  const events: { label: string; time: string }[] = [{ label: "Created", time: note.createdAt }];
  if (note.updatedAt && note.updatedAt !== note.createdAt) events.push({ label: "Last modified", time: note.updatedAt });
  const syncConfigs = ((note.metadata as Record<string, unknown> | null)?.sync as Array<Record<string, unknown>>) || [];
  for (const config of syncConfigs) {
    if (config.last_synced) events.push({ label: `Synced to ${config.adapter}`, time: config.last_synced as string });
  }
  events.sort((a, b) => b.time.localeCompare(a.time));
  return (
    <div className="space-y-3">
      <div>
        {events.map((e, i) => (
          <TimelineRow
            key={i}
            title={e.label}
            subtitle={`${formatWhen(e.time)} · ${ago(e.time)}`}
            icon={<Clock size={10} />}
            last={i === events.length - 1}
          />
        ))}
      </div>
      <div
        className="flex items-start gap-2 text-xs leading-relaxed pt-2"
        style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}
      >
        <History size={13} style={{ flexShrink: 0, marginTop: 2 }} />
        Full version history — compare and restore any earlier version — turns on once this vault runs Parachute 0.7.9.
      </div>
    </div>
  );
}

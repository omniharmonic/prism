import { useEffect, useState, type ReactNode } from "react";
import { Check, Clock, History, RotateCcw } from "lucide-react";
import type { Note } from "../../lib/types";
import { useNoteVersions } from "../../app/hooks/useNoteHistory";
import { useVaultClient } from "../../data/VaultClientContext";
import { reviewMode } from "../../lib/governance/review";
import { VersionViewer } from "../history/VersionViewer";
import { ago, dayLabel, formatWhen, opLabel, savedAt, sizeDelta } from "../history/labels";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";

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
  const history = useNoteVersions(note.id);
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

  return (
    <div className="space-y-3">
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
        subtitle={
          note.updatedAt
            ? `${producedByRestore ? "Restored" : "Saved"} ${formatWhen(note.updatedAt)} · ${ago(note.updatedAt)}`
            : undefined
        }
        icon={producedByRestore ? <RotateCcw size={10} /> : <Check size={10} />}
        badge={currentDelta && currentDelta.sign !== 0 ? currentDelta : undefined}
        last={versions.length === 0}
      />

      {history.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={16} />
        </div>
      ) : history.error ? (
        <div className="text-xs" style={{ color: "var(--color-danger)" }}>
          Couldn't load history: {(history.error as Error).message}
        </div>
      ) : versions.length === 0 ? (
        <div className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          No earlier versions yet. From now on, every change to this note is saved here and can be restored.
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
            return (
              <div key={v.versionIx}>
                {day !== prevDay && (
                  <div className="text-[11px] font-medium uppercase tracking-wide pt-2 pb-1" style={{ color: "var(--text-muted)" }}>
                    {day}
                  </div>
                )}
                <TimelineRow
                  onClick={() => setOpenIx(i)}
                  title={when ? formatWhen(when) : "Oldest saved version"}
                  subtitle={`then ${opLabel(v.op)} ${ago(v.supersededAt)}`}
                  badge={delta && delta.sign !== 0 ? delta : undefined}
                  icon={v.op === "restore" ? <RotateCcw size={10} /> : <Clock size={10} />}
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
        Parachute keeps every note's recent history — at least 20 versions, up to 100, for 180 days.
      </div>

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
    </div>
  );
}

function TimelineRow({
  title,
  subtitle,
  icon,
  badge,
  active,
  last,
  onClick,
}: {
  title: string;
  subtitle?: string;
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
      onClick={onClick}
      className="w-full text-left flex items-start gap-2.5 py-1.5 px-1 -mx-1 rounded-md relative transition-colors"
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
          <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {subtitle}
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

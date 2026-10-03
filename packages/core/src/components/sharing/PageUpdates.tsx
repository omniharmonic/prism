import { CheckCheck, MessageSquare, PenLine, Sparkles, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import type { NoteVersionSummary } from "../../data/VaultClient";
import { usePageActivity } from "./usePageActivity";
import { writerName, writerOf, writerTitle, type WriterInfo } from "../../lib/history/attribution";
import type { PageActivity } from "../../lib/sharing/types";
import type { Note } from "../../lib/types";
import { ago, formatWhen, savedAt } from "../history/labels";
import { PersonAvatar } from "./PersonAvatar";

export interface UpdateItem {
  key: string;
  kind: "edit" | "agent" | "accepted-suggestion" | "suggestion" | "comment" | "share";
  at: number;
  title: string;
  who: string | null;
  detail?: string;
  avatar?: string | null;
}

const LEVEL: Record<string, string> = { view: "view", comment: "comment", suggest: "suggest", edit: "edit", own: "full access" };

function editItem(key: string, w: WriterInfo, at: number): UpdateItem {
  const kind = w.kind === "agent" ? "agent" : w.kind === "accepted-suggestion" ? "accepted-suggestion" : w.kind === "suggestion" ? "suggestion" : "edit";
  return { key, kind, at, title: writerTitle(w), who: writerName(w) };
}

/**
 * The page's Updates feed (NP-CO-15), newest first: edits with their author kind
 * (person / agent / accepted suggestion), comments and replies, and shares — the
 * latter only when the caller may see who has access. Pure, so the fixtures and
 * the panel agree.
 */
export function buildUpdates(input: { note: Pick<Note, "updatedAt" | "metadata">; versions: NoteVersionSummary[]; activity?: PageActivity | null }): UpdateItem[] {
  const directory = { names: input.activity?.writers ?? null, me: input.activity?.me ?? null };
  const items: UpdateItem[] = [];
  const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
  if (input.note.updatedAt) {
    const current = input.activity?.lastEditor ?? writerOf({ metadata: input.note.metadata }, directory);
    items.push(editItem("current", current, t(input.note.updatedAt)));
  }
  input.versions.forEach((v, i) => {
    const when = savedAt(input.versions, i);
    if (!when) return;
    items.push(editItem(`v${v.versionIx}`, writerOf(v, directory), t(when)));
  });
  for (const thread of input.activity?.comments ?? []) {
    thread.comments.forEach((c, i) => {
      items.push({
        key: `c:${thread.threadId}:${i}`,
        kind: "comment",
        at: c.createdAt,
        title: i === 0 ? (c.agent ? "Agent commented" : "Commented") : "Replied",
        who: c.mine ? "You" : c.author,
        detail: `${thread.quote ? `“${thread.quote.slice(0, 80)}” — ` : ""}${c.text.slice(0, 160)}`,
      });
    });
  }
  for (const s of input.activity?.shares ?? []) {
    const name = s.name ?? s.email ?? "Someone";
    items.push({
      key: `s:${s.email ?? name}:${s.at}`,
      kind: "share",
      at: s.at,
      title: s.inheritedFrom ? `Shared through ${s.inheritedFrom.title}` : "Shared",
      who: s.by,
      detail: `${name} · can ${LEVEL[s.level] ?? s.level}${s.scope === "page" && !s.inheritedFrom ? " (with sub-pages)" : ""}`,
      avatar: s.avatar,
    });
  }
  return items.filter((i) => i.at > 0).sort((a, b) => b.at - a.at).slice(0, 200);
}

const ICON: Record<UpdateItem["kind"], ReactNode> = {
  edit: <PenLine size={13} />,
  agent: <Sparkles size={13} />,
  "accepted-suggestion": <CheckCheck size={13} />,
  suggestion: <PenLine size={13} />,
  comment: <MessageSquare size={13} />,
  share: <UserPlus size={13} />,
};

/** The Updates tab of the history panel. */
export function PageUpdates({ note, versions }: { note: Note; versions: NoteVersionSummary[] }) {
  const activity = usePageActivity(note);
  const items = buildUpdates({ note, versions, activity: activity.data ?? null });
  return (
    <div className="prism-page-updates" aria-label="Page updates">
      {activity.isError && (
        <div role="alert" className="prism-context-state">
          <p>Comments and shares could not be loaded. Edits are still listed.</p>
          <button type="button" onClick={() => void activity.refetch()}>Try again</button>
        </div>
      )}
      {!items.length ? (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>No updates yet. Edits, comments and shares will appear here.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li key={item.key} data-update-kind={item.kind} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--glass-border)" }}>
              <span aria-hidden style={{ width: 24, height: 24, borderRadius: 999, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--glass)", color: item.kind === "agent" ? "var(--color-accent)" : "var(--text-muted)" }}>
                {ICON[item.kind]}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong style={{ fontWeight: 550 }}>{item.title}</strong>
                  {item.who && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text-secondary)" }}>
                      <PersonAvatar name={item.who} avatar={item.kind === "share" ? null : undefined} size={16} />
                      {item.who}
                    </span>
                  )}
                </div>
                {item.detail && <div style={{ fontSize: 12.5, color: "var(--text-secondary)", overflowWrap: "anywhere", marginTop: 2 }}>{item.detail}</div>}
                <time dateTime={new Date(item.at).toISOString()} title={formatWhen(new Date(item.at).toISOString())} style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {ago(new Date(item.at).toISOString())}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

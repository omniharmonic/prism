import { useQuery } from "@tanstack/react-query";
import { FileText, Hash, Users } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useCollabSharing } from "../../data/CollabSharing";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { SharedItem } from "../../lib/sharing/types";

const LEVEL: Record<string, string> = {
  view: "Can view",
  comment: "Can comment",
  suggest: "Can suggest",
  edit: "Can edit",
  own: "Full access",
};

/** The query behind the sidebar's "Shared with me" (NP-SB-09). Null when the shell has no such read. */
export function useSharedWithMe(enabled = true) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const supported = !!client.listSharedWithMe;
  return useQuery({
    queryKey: ["shared-with-me", scope],
    enabled: enabled && supported,
    queryFn: () => client.listSharedWithMe!(),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Is the signed-in viewer a GUEST of the active workspace (an account with no
 * workspace role — everything they see was shared with them)? False while unknown,
 * on a failed read, and in shells with no viewer read (the desktop is the owner):
 * a transient error must never hide the workspace from a member.
 */
export function useViewerIsGuest(): boolean {
  const sharing = useCollabSharing();
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const query = useQuery({
    queryKey: ["viewer-role", scope],
    enabled: !!sharing?.getViewer,
    queryFn: () => sharing!.getViewer!(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return query.data?.role === "guest";
}

/**
 * Sidebar section: pages other people shared with the signed-in user. Each row
 * opens the page; its sub-pages are browsed from there (the tree already only
 * lists what the viewer may see). Renders nothing when the shell has no
 * shared-with-me read, or (unless `guest`) when nothing is shared.
 *
 * A guest — a signed-in account with no workspace role — sees ONLY this section
 * (`guest`), with an explicit empty state, so no workspace structure they cannot
 * view is ever shown. The host decides `guest` from the viewer's role.
 */
export function SharedWithMe({
  onOpen,
  activeId,
  guest = false,
  collapsed = false,
}: {
  onOpen: (item: SharedItem) => void;
  activeId?: string | null;
  guest?: boolean;
  collapsed?: boolean;
}) {
  const client = useVaultClient();
  const query = useSharedWithMe(!!client.listSharedWithMe);
  if (!client.listSharedWithMe) return null;
  const items = query.data?.items ?? [];
  const tags = query.data?.tags ?? [];
  // A member's sidebar shows this section only when there is something in it: no
  // loading line, and a failed read (an older server has no such route) stays quiet.
  if (!guest && !items.length && !tags.length) return null;
  return (
    <section className="prism-shared-with-me" aria-labelledby="prism-shared-with-me-heading">
      <style>{`
        .prism-shared-with-me { padding: 4px 0 8px; }
        .prism-shared-with-me { margin-top: 18px; }
        .prism-shared-with-me h3 { display: flex; align-items: center; gap: 6px; margin: 0; padding: 6px 10px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); letter-spacing: .01em; }
        .prism-shared-with-me ul { list-style: none; margin: 0; padding: 0; }
        .prism-shared-with-me button.prism-shared-row { width: 100%; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-primary); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
        .prism-shared-with-me button.prism-shared-row:hover { background: var(--glass-hover, var(--surface-hover)); }
        .prism-shared-with-me button.prism-shared-row[aria-current="page"] { background: var(--surface-hover, var(--glass-hover)); font-weight: 550; }
        .prism-shared-with-me button.prism-shared-row:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
        .prism-shared-with-me .prism-shared-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .prism-shared-with-me .prism-shared-meta { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
        .prism-shared-with-me p { margin: 0; padding: 4px 10px; font-size: 12.5px; line-height: 1.5; color: var(--text-muted); }
        @media (max-width: 820px) { .prism-shared-with-me button.prism-shared-row { min-height: 44px; font-size: 15px; } }
      `}</style>
      <h3 id="prism-shared-with-me-heading">
        <Users size={12} aria-hidden style={{ flexShrink: 0 }} />
        Shared with me
      </h3>
      {query.isLoading ? (
        <p role="status">Loading shared pages…</p>
      ) : query.isError ? (
        <p role="alert">
          Shared pages couldn’t be loaded.{" "}
          <button type="button" onClick={() => void query.refetch()} style={{ border: 0, background: "none", color: "var(--color-accent)", padding: 0, font: "inherit", cursor: "pointer" }}>
            Try again
          </button>
        </p>
      ) : !items.length && !tags.length ? (
        <p>Nothing has been shared with you yet. Pages appear here when someone invites you.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="prism-shared-row"
                aria-current={activeId === item.id ? "page" : undefined}
                title={`${item.title} · ${LEVEL[item.level] ?? item.level} · shared by ${item.sharedBy.name}`}
                onClick={() => onOpen(item)}
              >
                <FileText size={15} aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <span className="prism-shared-title">{item.title}</span>
                {!collapsed && <span className="prism-shared-meta">{item.scope === "page" ? "with sub-pages" : ""}</span>}
              </button>
            </li>
          ))}
          {tags.map((t) => (
            <li key={`#${t.tag}`}>
              <div className="prism-shared-row" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32, padding: "4px 10px", fontSize: 13.5, color: "var(--text-secondary)" }}>
                <Hash size={15} aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <span className="prism-shared-title">Everything tagged #{t.tag}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

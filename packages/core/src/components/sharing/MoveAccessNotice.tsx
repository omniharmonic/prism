import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { AccessPreview } from "../../lib/sharing/types";

const LEVEL: Record<string, string> = { view: "view", comment: "comment", suggest: "suggest", edit: "edit", own: "full access" };

/** How a move would change who can open the page (null while unknown / unsupported). */
export function useMoveAccessPreview(noteId: string | null, parentPath: string | null) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  return useQuery({
    queryKey: ["move-access-preview", scope, noteId, parentPath],
    enabled: !!client.getAccessPreview && !!noteId && parentPath !== null,
    queryFn: () => client.getAccessPreview!(noteId!, parentPath!),
    staleTime: 10_000,
    retry: false,
  });
}

/** The sentence for a preview (pure). */
export function moveAccessSummary(p: AccessPreview): string | null {
  if (!p.willChange) return null;
  if (!p.changes) return "Moving this page changes who can open it, because it will no longer inherit the same shared access.";
  const losing = p.changes.filter((c) => !c.to);
  const gaining = p.changes.filter((c) => !c.from);
  const changing = p.changes.filter((c) => c.from && c.to);
  const name = (c: { name: string | null; email: string | null }) => c.name ?? c.email ?? "Someone";
  const parts: string[] = [];
  if (losing.length) parts.push(`${losing.slice(0, 3).map(name).join(", ")}${losing.length > 3 ? ` and ${losing.length - 3} more` : ""} will lose access`);
  if (gaining.length) parts.push(`${gaining.slice(0, 3).map(name).join(", ")}${gaining.length > 3 ? ` and ${gaining.length - 3} more` : ""} will gain access`);
  if (changing.length) parts.push(changing.slice(0, 3).map((c) => `${name(c)} will change from ${LEVEL[c.from!] ?? c.from} to ${LEVEL[c.to!] ?? c.to}`).join(", "));
  return `${parts.join("; ")}. Access shared on the page above it no longer applies after the move.`;
}

/**
 * The warning a move dialog shows before moving a page out of (or into) a shared
 * page (NP-CO-09): inherited access follows the location. Renders nothing when
 * the move changes nobody's access. Mount it in the move picker with the page
 * and the chosen destination parent path ("" = top level).
 */
export function MoveAccessNotice({ noteId, parentPath }: { noteId: string; parentPath: string | null }) {
  const preview = useMoveAccessPreview(noteId, parentPath);
  const text = preview.data ? moveAccessSummary(preview.data) : null;
  if (!text) return null;
  return (
    <div role="alert" className="prism-move-access" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderRadius: 8, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-primary)", background: "color-mix(in srgb, var(--color-warning, #d97706) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--color-warning, #d97706) 35%, transparent)" }}>
      <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: "var(--color-warning, #d97706)" }} />
      <span>{text}</span>
    </div>
  );
}

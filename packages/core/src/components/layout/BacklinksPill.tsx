import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, FileText } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { inferContentType } from "../../lib/schemas/content-types";
import { buildSnippet, contentWindow, plainText, queryTerms } from "../../lib/search/match";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { isTrashed } from "../../lib/pages/model";
import "./backlinks.css";

const MAX_LISTED = 20;

/**
 * NP-PG-10: "N backlinks" under the title. Counted only over pages the viewer
 * can already see (the permission-filtered tree), so a hidden page is never
 * counted or named; hidden when there are none or the shell can't list links
 * (non-owners today: the gateway doesn't serve /links). Opening the list loads
 * a snippet per page (≤ 20) through the normal note read.
 * `inline`: the pill as one item of the page's chrome row (a phone): the count only, named in
 * full for assistive tech; its list hangs from the row's trailing edge.
 */
export function BacklinksPill({ noteId, title, inline = false }: { noteId: string; title: string; inline?: boolean }) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const tree = useVaultTree();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const links = useQuery({
    queryKey: ["vault", "backlinks", scope, noteId],
    enabled: isVaultNoteId(noteId) && typeof client.getLinks === "function",
    queryFn: async () => (await client.getLinks(noteId)).filter((l) => l.targetId === noteId && l.sourceId !== noteId),
    retry: false,
    staleTime: 30_000,
  });
  const visible = new Map((tree.data ?? []).filter((row) => !isTrashed(row)).map((row) => [row.id, row]));
  const sources = [...new Set((links.data ?? []).map((l) => l.sourceId))].filter((id) => visible.has(id));
  const snippets = useQuery({
    queryKey: ["vault", "backlink-snippets", scope, noteId, sources.slice(0, MAX_LISTED)],
    enabled: open && sources.length > 0,
    queryFn: async () => {
      const terms = queryTerms(title);
      return Object.fromEntries(await Promise.all(sources.slice(0, MAX_LISTED).map(async (id) => {
        try {
          const note = await client.getNote(id);
          const words = terms.length ? terms : [title.toLowerCase()];
          return [id, buildSnippet(plainText(contentWindow(note.content ?? "", words)), words, 140).snippet] as const;
        } catch {
          return [id, ""] as const;
        }
      })));
    },
    retry: false,
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);
  if (!sources.length) return null;
  const label = `${sources.length} backlink${sources.length === 1 ? "" : "s"}`;
  return (
    <div className="backlinks" data-inline={inline || undefined}>
      <button ref={button} type="button" className="backlinks-pill focus-ring" aria-expanded={open} aria-controls="backlinks-list"
        aria-label={inline ? label : undefined} title={inline ? label : undefined}
        onClick={() => setOpen((o) => !o)}>
        <ArrowDownLeft size={13} aria-hidden /> {inline ? sources.length : label}
      </button>
      {open && (
        <div ref={panel} id="backlinks-list" className="backlinks-list prism-menu-enter" role="region" aria-label="Pages that link here">
          <ul>
            {sources.slice(0, MAX_LISTED).map((id) => {
              const row = visible.get(id)!;
              const name = row.path?.split("/").pop() || id;
              return (
                <li key={id}>
                  <button type="button" className="backlinks-item focus-ring" onClick={() => {
                    setOpen(false);
                    useUIStore.getState().openTab(id, name, inferContentType({ ...row, content: "" } as never));
                  }}>
                    <FileText size={15} aria-hidden />
                    <span className="backlinks-item-text">
                      <span className="backlinks-item-title">{name}</span>
                      {row.path && <span className="backlinks-item-path">{row.path}</span>}
                      <span className="backlinks-item-snippet">{snippets.isFetching ? "Loading…" : snippets.data?.[id] ?? ""}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {sources.length > MAX_LISTED && <p className="backlinks-more">Showing {MAX_LISTED} of {sources.length}. See all in the Links panel.</p>}
        </div>
      )}
    </div>
  );
}

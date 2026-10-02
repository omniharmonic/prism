import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, X } from "lucide-react";
import DOMPurify from "dompurify";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { AgentMarkdown } from "./AgentMarkdown";

/** A fresh, read-only source inspection; never changes a conversation binding. */
export function AgentSourcePreview({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const source = useQuery({
    queryKey: ["vault", "agent-source-preview", scope, noteId],
    queryFn: () => client.getNote(noteId),
    enabled: !!scope,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
  // Refetch before displaying a cached passage. A denied read must not show the
  // previous successful response retained by the query cache.
  const note = !source.isFetching && !source.isError && scope ? source.data : undefined;
  const name = note?.path?.split("/").pop() || "Source preview";
  const textHtml = useMemo(() => note?.content.trimStart().startsWith("<") ? DOMPurify.sanitize(note.content, {
    ALLOWED_TAGS: ["p", "br", "span", "strong", "b", "em", "i", "del", "s", "blockquote", "pre", "code", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }) : null, [note?.content]);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialogRef} aria-label="Source preview" className="agent-source-preview prism-agent-source-peek"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="flex max-h-[85dvh] min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--glass-border)" }}>
        <div className="min-w-0 flex-1"><h2 className="break-words text-lg font-semibold">{name}</h2><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Saved text preview{note?.updatedAt && <span> · Updated <time dateTime={note.updatedAt}>{Number.isNaN(Date.parse(note.updatedAt)) ? note.updatedAt : new Date(note.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time></span>}</p></div>
        <button onClick={onClose} aria-label="Close source preview" className="interactive focus-ring flex h-10 w-10 items-center justify-center rounded-lg"><X size={18} /></button>
      </div>
      <div className="prism-agent-source-body min-h-0 overflow-y-auto p-5 text-sm leading-relaxed">
        {(source.isFetching || source.isPending) && scope ? <p role="status">Loading source…</p> : null}
        {(!scope || source.isError) && <div role="alert"><p>This source is unavailable. It may have moved, been deleted, or your access may have changed.</p><button onClick={() => void source.refetch()} disabled={!scope} className="interactive focus-ring mt-3 rounded-lg border px-3 py-2" style={{ borderColor: "var(--glass-border)" }}>Try again</button></div>}
        {note && (textHtml !== null ? <div className="agent-markdown" dangerouslySetInnerHTML={{ __html: textHtml }} /> : <AgentMarkdown text={note.content} />)}
      </div>
      {note && <div className="flex shrink-0 justify-end border-t p-3" style={{ borderColor: "var(--glass-border)" }}><button className="interactive focus-ring flex items-center gap-2 rounded-lg px-3 py-2 text-sm" onClick={() => { useUIStore.getState().openTab(note.id, name, inferContentType(note)); onClose(); }}>Open document <ArrowUpRight size={15} /></button></div>}
    </div>
  </dialog>;
}

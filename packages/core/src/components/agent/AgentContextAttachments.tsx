import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";

/** Choose references only; the server rechecks access and reads text at send. */
export function AgentContextAttachments({ ids, onChange, onPreview, disabled, maxNotes, maxCharacters }: {
  ids: string[]; onChange: (ids: string[]) => void; onPreview: (id: string) => void;
  disabled: boolean; maxNotes: number; maxCharacters: number;
}) {
  const [open, setOpen] = useState(false);
  return <div className="mb-2 text-xs" data-testid="agent-context-attachments">
    <div className="flex flex-wrap items-center gap-2">
      {ids.map((id, index) => <div key={id} className="flex min-w-0 max-w-full items-center rounded-lg border" style={{ borderColor: "var(--glass-border)" }}>
        <button onClick={() => onPreview(id)} className="interactive focus-ring flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-2"><FileText size={13} className="shrink-0" /><AttachedNoteName id={id} fallback={`Note ${index + 1}`} /></button>
        <button disabled={disabled} onClick={() => onChange(ids.filter((item) => item !== id))} aria-label={`Remove attached note ${index + 1}`} className="interactive focus-ring flex h-9 w-9 items-center justify-center rounded-lg"><X size={13} /></button>
      </div>)}
      <button disabled={disabled || ids.length >= maxNotes} onClick={() => setOpen(true)} className="interactive focus-ring flex items-center gap-1.5 rounded-lg px-2 py-2 disabled:opacity-40"><Paperclip size={14} />Attach notes</button>
    </div>
    {ids.length > 0 && <p className="mt-1" style={{ color: "var(--text-muted)" }}>Saved text is read when you send; up to {maxCharacters.toLocaleString()} characters per note.</p>}
    {open && <ContextPicker ids={ids} onChange={onChange} maxNotes={maxNotes} onClose={() => setOpen(false)} />}
  </div>;
}

function AttachedNoteName({ id, fallback }: { id: string; fallback: string }) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const note = useQuery({ queryKey: ["vault", "agent-attached-note", scope, id], queryFn: () => client.getNote(id), enabled: !!scope, staleTime: 0, gcTime: 0, retry: false });
  return <span className="truncate">{note.isError ? "Unavailable note" : !note.isFetching && note.data?.path ? note.data.path.split("/").pop() : fallback}</span>;
}

function ContextPicker({ ids, onChange, maxNotes, onClose }: { ids: string[]; onChange: (ids: string[]) => void; maxNotes: number; onClose: () => void }) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 200); return () => clearTimeout(timer); }, [search]);
  const results = useQuery({
    queryKey: ["vault", "agent-context-search", scope, query], queryFn: () => client.search(query, undefined, 12),
    enabled: !!scope && query.length >= 2, staleTime: 0, gcTime: 0, retry: false,
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const searching = search.trim() !== query || results.isFetching;
  const notes = !searching && !results.isError && scope && query.length >= 2 ? results.data : undefined;
  return <dialog ref={dialogRef} aria-label="Attach vault notes" className="agent-source-preview" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="flex max-h-[85dvh] min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--glass-border)" }}>
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Attach vault notes</h2><p className="text-xs" style={{ color: "var(--text-muted)" }}>Choose up to {maxNotes} sources for this message.</p></div>
        <button aria-label="Close note picker" onClick={onClose} className="interactive focus-ring flex h-10 w-10 items-center justify-center rounded-lg"><X size={18} /></button>
      </div>
      <div className="p-4"><input autoFocus aria-label="Search notes to attach" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your vault…" className="focus-ring w-full rounded-lg border px-3 py-2 text-base" style={{ background: "var(--bg-surface)", borderColor: "var(--glass-border)" }} /></div>
      <div className="min-h-0 overflow-y-auto px-4 pb-4 text-sm">
        {searching ? <p role="status">Searching…</p> : search.trim().length < 2 ? <p style={{ color: "var(--text-muted)" }}>Type at least two characters to find a note.</p> : null}
        {!searching && results.isError && <div role="alert">Couldn't search this vault. <button onClick={() => void results.refetch()} className="focus-ring underline">Try again</button></div>}
        {notes?.length === 0 && <p>No matching notes.</p>}
        {notes?.map((note) => <button key={note.id} disabled={ids.includes(note.id) || ids.length >= maxNotes} onClick={() => onChange([...ids, note.id])} className="interactive focus-ring flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left disabled:opacity-50">
          <FileText size={17} className="shrink-0" /><span className="min-w-0 flex-1 break-words">{note.path || "Untitled note"}</span>{ids.includes(note.id) && <span className="text-xs">Attached</span>}
        </button>)}
      </div>
      <div className="flex justify-end border-t p-3" style={{ borderColor: "var(--glass-border)" }}><button onClick={onClose} className="interactive focus-ring rounded-lg px-4 py-2 text-sm">Done · {ids.length} attached</button></div>
    </div>
  </dialog>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search, X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { Note, NoteTreeEntry } from "../../lib/types";

const control = "focus-ring min-h-control rounded-lg border border-[var(--glass-border)] px-3 text-sm disabled:opacity-50";
const title = (n: NoteTreeEntry) => (typeof n.metadata?.title === "string" && n.metadata.title) || n.path?.split("/").pop() || "Untitled";

type Props = { onAddNote: (note: Note) => Promise<void>; canvasNoteIds: Set<string>; onClose: () => void };
export function NoteDrawer(props: Props) {
  const client = useVaultClient();
  const audience = useAgentChatStore(s => s.scope);
  const scope = client.scope?.() ?? audience;
  return <Drawer key={scope} {...props} scope={scope} />;
}
function Drawer({ onAddNote, canvasNoteIds, onClose, scope }: Props & { scope: string | null }) {
  const client = useVaultClient();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const lock = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  const notes = useQuery({
    queryKey: ["vault", "canvas-picker", scope],
    queryFn: async () => {
      const result = await client.listTree();
      if (!current()) throw Error("Workspace changed");
      return result;
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  const visible = !notes.isFetching && !notes.isError ? notes.data ?? [] : [];
  const tags = useMemo(() => [...new Set(visible.flatMap(n => n.tags ?? []))].sort(), [visible]);
  const filtered = visible.filter(n => (!tag || n.tags?.includes(tag)) && (!query || `${title(n)} ${n.path ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())));
  const close = () => { onClose(); document.querySelector<HTMLButtonElement>('button[title="Note drawer"]')?.focus(); };
  async function add(ids: string[]) {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true); setError("");
    try {
      for (const id of ids) {
        if (!current()) return;
        const entry = visible.find(n => n.id === id);
        if (!entry || canvasNoteIds.has(id)) continue;
        // The renderer performs a fresh authorized read before embedding anything.
        await onAddNote({ ...entry, content: "", createdAt: "", updatedAt: null });
        if (!current()) return;
        setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
      }
    } catch {
      if (current()) setError("The note could not be added. Your remaining selection is kept; try again after checking access.");
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  }
  return <aside aria-label="Canvas notes" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }} className="prism-canvas-drawer absolute inset-0 z-20 flex h-full min-w-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-surface)] sm:static sm:w-80 sm:shrink-0">
    <header className="flex items-center justify-between px-4 pt-3">
      <div><h2 className="font-medium">Add notes</h2><p className="prism-canvas-subtitle">Bring context into your canvas</p></div>
      <button className={control} aria-label="Close canvas notes" onClick={close}><X size={16}/></button>
    </header>
    <div className="space-y-3 p-4">
      <p className="prism-canvas-copy-notice text-xs text-[var(--text-secondary)]">Cards copy a title and properties into this canvas. Copy preview also includes saved text, visible to everyone with canvas access.</p>
      <label className="flex min-h-control items-center gap-2 rounded-lg border border-[var(--glass-border)] px-3"><Search size={16}/><span className="sr-only">Find canvas notes</span><input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setLimit(50);}} placeholder="Find a note…" className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none"/></label>
      <div className="prism-canvas-filter"><select aria-label="Filter canvas notes by tag" value={tag} onChange={e=>{setTag(e.target.value);setLimit(50);}} className={control+" w-full bg-[var(--bg-surface)]"}><option value="">All tags</option>{tags.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
      {selected.size > 0 && <button className={control+" w-full"} disabled={busy || notes.isFetching || notes.isError} onClick={()=>void add([...selected])}>{busy ? "Adding…" : `Add ${selected.size} selected`}</button>}
      {error && <p role="alert" className="text-sm">{error}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
      {notes.isFetching && <p role="status" className="p-3 text-sm">Loading notes…</p>}
      {notes.isError && <div role="alert" className="p-3 text-sm">Notes could not be loaded.<button className={control+" mt-3"} onClick={()=>void notes.refetch()}>Try again</button></div>}
      {filtered.slice(0,limit).map(n=>{ const added=canvasNoteIds.has(n.id); return <div key={n.id} className="prism-canvas-picker-row flex min-h-16 items-center gap-3 rounded-lg px-2 hover:bg-[var(--glass-hover)]">
        <label className="flex min-h-control min-w-control items-center justify-center"><span className="sr-only">Select {title(n)}</span><input type="checkbox" disabled={busy || added} checked={selected.has(n.id)} onChange={()=>setSelected(prev=>{const next=new Set(prev);if(next.has(n.id))next.delete(n.id);else next.add(n.id);return next;})}/></label>
        <FileText aria-hidden="true" size={17} className="prism-canvas-note-icon"/>
        <button disabled={busy || added} onClick={()=>void add([n.id])} className="focus-ring min-h-control min-w-0 flex-1 py-1.5 text-left disabled:opacity-50"><span className="block truncate text-sm font-medium">{title(n)}</span><span className="block truncate text-xs text-[var(--text-secondary)]">{added ? "On canvas" : n.path || "Add to canvas"}</span></button>
      </div>;})}
      {!notes.isFetching && !notes.isError && !filtered.length && <p className="p-6 text-center text-sm text-[var(--text-secondary)]">No matching notes</p>}
      {filtered.length > limit && <button className={control+" mt-3 w-full"} onClick={()=>setLimit(n=>n+50)}>Show more notes</button>}
    </div>
  </aside>;
}

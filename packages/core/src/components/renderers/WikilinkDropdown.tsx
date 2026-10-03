import { useState, useMemo, useEffect, useId, useCallback, useContext, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { QueryClientContext } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import type { Note } from "../../lib/types";
import { noteAliases, noteLinkTitle } from "../../lib/wikilinks";
import type { WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { createSubPage, pageNameFromQuery } from "../../lib/tiptap/subPages";

type Row = { kind: "note"; note: Note } | { kind: "create"; name: string };

/**
 * One keyboard-accessible `[[` picker for both local and collaborative editors:
 * matching pages with their icon and path (pages sharing a title are told apart
 * by the path), and — where this page can hold sub-pages (`hostPath`) —
 * "Create page '<query>'", which makes the page inside this one and links it
 * (NP-RF-01).
 */
export function WikilinkDropdown({ editor, notes, autocomplete, hostPath }: {
  editor: Editor|null; notes: Note[]; autocomplete: WikilinkAutocompleteState;
  /** This page's path: enables "Create page". Omitted → only existing pages are offered. */
  hostPath?: string | null;
}) {
  const id = useId();
  const client = useOptionalVaultClient();
  const queryClient = useContext(QueryClientContext) ?? null;
  const signature = `${autocomplete.from}:${autocomplete.query}`;
  const [selection,setSelection] = useState({signature:"",index:0,dismissed:false});
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const rows = useMemo<Row[]>(()=>{
    const query = autocomplete.query.trim().toLowerCase();
    const matches = notes.filter(note=>[noteLinkTitle(note),note.path??"",...noteAliases(note)].some(text=>text.toLowerCase().includes(query))).slice(0,8);
    const out: Row[] = matches.map((note) => ({ kind: "note", note }));
    // A query with a path or alias separator is a typed link, not a new title.
    const name = /[\\/|]/.test(autocomplete.query) ? null : pageNameFromQuery(autocomplete.query);
    if (name && hostPath && client && !notes.some((n) => noteLinkTitle(n).toLowerCase() === name.toLowerCase())) out.push({ kind: "create", name });
    return out;
  },[notes,autocomplete.query,hostPath,client]);
  const index = selection.signature===signature ? Math.min(selection.index,Math.max(0,rows.length-1)) : 0;
  const dismissed = selection.signature===signature && selection.dismissed;
  const visible = !!editor && autocomplete.active && !dismissed && rows.length>0;
  const insertLink = useCallback((noteId: string, title: string)=>{
    // IDs survive renames. A text node preserves portable syntax without
    // interpreting a title containing <...> as editor HTML.
    const label = title.replace(/[\[\]|]/g, "").trim() || noteId;
    editor?.chain().focus().deleteRange({from:autocomplete.from,to:autocomplete.to})
      .insertContent({type:"text",text:`[[${noteId}|${label}]] `}).run();
  },[editor,autocomplete.from,autocomplete.to]);
  const select = useCallback((row: Row)=>{
    if (row.kind === "note") { insertLink(row.note.id, noteLinkTitle(row.note)); return; }
    if (!client || !hostPath || creating.current) return;
    creating.current = true;
    setError(null);
    // The `[[query` text stays until the page exists: a refused create loses nothing.
    createSubPage(client, queryClient, hostPath, row.name)
      .then((pageId) => { if (pageId) insertLink(pageId, row.name); else setError("Couldn’t create that page."); },
        () => setError("Couldn’t create that page. You may not be able to add pages here."))
      .finally(() => { creating.current = false; });
  },[client,hostPath,queryClient,insertLink]);
  useEffect(() => setError(null), [signature]);
  useEffect(()=>{
    if (!editor || !visible) return;
    const element = editor.view.dom;
    element.setAttribute("aria-controls",id);
    element.setAttribute("aria-autocomplete","list");
    element.setAttribute("aria-activedescendant",`${id}-${index}`);
    const keydown = (event:KeyboardEvent)=>{
      if (event.isComposing) return;
      if (event.key==="ArrowDown" || event.key==="ArrowUp") {
        event.preventDefault();event.stopImmediatePropagation();
        const next=(index+(event.key==="ArrowDown"?1:-1)+rows.length)%rows.length;
        setSelection({signature,index:next,dismissed:false});
        document.getElementById(`${id}-${next}`)?.scrollIntoView({block:"nearest"});
      } else if ((event.key==="Enter" || event.key==="Tab") && !event.shiftKey && rows[index]) {
        event.preventDefault();event.stopImmediatePropagation();select(rows[index]);
      } else if (event.key==="Escape") {
        event.preventDefault();event.stopImmediatePropagation();setSelection({signature,index,dismissed:true});
      }
    };
    element.addEventListener("keydown",keydown,true);
    return ()=>{
      element.removeEventListener("keydown",keydown,true);
      for(const name of ["aria-controls","aria-autocomplete","aria-activedescendant"])element.removeAttribute(name);
    };
  },[editor,visible,id,index,rows,select,signature]);
  if (!editor || !visible) return null;
  const coords = editor.view.coordsAtPos(Math.min(autocomplete.to,editor.state.doc.content.size));
  const width = Math.min(320,window.innerWidth-16);
  const height = Math.min(280,window.innerHeight-16);
  const top = coords.bottom+height+6>window.innerHeight ? Math.max(8,coords.top-height-6) : coords.bottom+6;
  return <div id={id} role="listbox" aria-label="Link to a document" className="fixed glass-elevated overflow-auto rounded-xl p-1 shadow-lg"
    style={{left:Math.max(8,Math.min(coords.left,window.innerWidth-width-8)),top,width,maxHeight:height,zIndex:70}}>
    {rows.map((row,i)=>{
      const icon = row.kind === "note" && typeof row.note.metadata?.icon === "string" ? row.note.metadata.icon as string : null;
      return <button key={row.kind === "note" ? row.note.id : "create"} id={`${id}-${i}`} role="option" aria-selected={i===index} tabIndex={-1}
        onMouseDown={event=>event.preventDefault()} onClick={()=>select(row)} onMouseEnter={()=>setSelection({signature,index:i,dismissed:false})}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left" style={{background:i===index?"var(--surface-selected)":"transparent",color:"var(--text-primary)",borderTop:row.kind==="create"&&i>0?"1px solid var(--glass-border)":undefined}}>
        <span aria-hidden="true" data-wikilink-icon className="mt-0.5 inline-flex w-5 shrink-0 justify-center text-[var(--text-secondary)]">{row.kind === "create" ? <Plus size={15}/> : icon ?? <FileText size={15}/>}</span>
        {row.kind === "note"
          ? <span className="flex min-w-0 flex-col gap-1"><span className="max-w-full truncate text-sm font-medium">{noteLinkTitle(row.note)}</span><span className="max-w-full truncate text-xs text-[var(--text-secondary)]">{row.note.path??row.note.id}</span></span>
          : <span className="flex min-w-0 flex-col gap-1"><span className="max-w-full truncate text-sm font-medium">Create page “{row.name}”</span><span className="max-w-full truncate text-xs text-[var(--text-secondary)]">A new page inside this one</span></span>}
      </button>;
    })}
    {error && <p role="alert" className="px-3 py-2 text-xs" style={{color:"var(--color-danger)"}}>{error}</p>}
  </div>;
}

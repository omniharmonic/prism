import { useState, useMemo, useEffect, useId, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import type { Note } from "../../lib/types";
import { noteAliases, noteLinkTitle } from "../../lib/wikilinks";
import type { WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";

/** One keyboard-accessible picker for both local and collaborative editors. */
export function WikilinkDropdown({ editor, notes, autocomplete }: {
  editor: Editor|null; notes: Note[]; autocomplete: WikilinkAutocompleteState;
}) {
  const id = useId();
  const signature = `${autocomplete.from}:${autocomplete.query}`;
  const [selection,setSelection] = useState({signature:"",index:0,dismissed:false});
  const matches = useMemo(()=>{
    const query = autocomplete.query.trim().toLowerCase();
    return notes.filter(note=>[noteLinkTitle(note),note.path??"",...noteAliases(note)].some(text=>text.toLowerCase().includes(query))).slice(0,8);
  },[notes,autocomplete.query]);
  const index = selection.signature===signature ? Math.min(selection.index,Math.max(0,matches.length-1)) : 0;
  const dismissed = selection.signature===signature && selection.dismissed;
  const visible = !!editor && autocomplete.active && !dismissed && matches.length>0;
  const select = useCallback((note:Note)=>{
    // IDs survive renames. A text node preserves portable syntax without
    // interpreting a title containing <...> as editor HTML.
    const label = noteLinkTitle(note).replace(/[\[\]|]/g, "").trim() || note.id;
    editor?.chain().focus().deleteRange({from:autocomplete.from,to:autocomplete.to})
      .insertContent({type:"text",text:`[[${note.id}|${label}]] `}).run();
  },[editor,autocomplete.from,autocomplete.to]);
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
        const next=(index+(event.key==="ArrowDown"?1:-1)+matches.length)%matches.length;
        setSelection({signature,index:next,dismissed:false});
        document.getElementById(`${id}-${next}`)?.scrollIntoView({block:"nearest"});
      } else if ((event.key==="Enter" || event.key==="Tab") && !event.shiftKey && matches[index]) {
        event.preventDefault();event.stopImmediatePropagation();select(matches[index]);
      } else if (event.key==="Escape") {
        event.preventDefault();event.stopImmediatePropagation();setSelection({signature,index,dismissed:true});
      }
    };
    element.addEventListener("keydown",keydown,true);
    return ()=>{
      element.removeEventListener("keydown",keydown,true);
      for(const name of ["aria-controls","aria-autocomplete","aria-activedescendant"])element.removeAttribute(name);
    };
  },[editor,visible,id,index,matches,select,signature]);
  if (!editor || !visible) return null;
  const coords = editor.view.coordsAtPos(Math.min(autocomplete.to,editor.state.doc.content.size));
  const width = Math.min(320,window.innerWidth-16);
  const height = Math.min(280,window.innerHeight-16);
  const top = coords.bottom+height+6>window.innerHeight ? Math.max(8,coords.top-height-6) : coords.bottom+6;
  return <div id={id} role="listbox" aria-label="Link to a document" className="fixed glass-elevated overflow-auto rounded-xl p-1 shadow-lg"
    style={{left:Math.max(8,Math.min(coords.left,window.innerWidth-width-8)),top,width,maxHeight:height,zIndex:70}}>
    {matches.map((note,i)=><button key={note.id} id={`${id}-${i}`} role="option" aria-selected={i===index} tabIndex={-1}
      onMouseDown={event=>event.preventDefault()} onClick={()=>select(note)} onMouseEnter={()=>setSelection({signature,index:i,dismissed:false})}
      className="flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left" style={{background:i===index?"var(--surface-selected)":"transparent",color:"var(--text-primary)"}}>
      <span className="max-w-full truncate text-sm font-medium">{noteLinkTitle(note)}</span><span className="max-w-full truncate text-xs text-[var(--text-secondary)]">{note.path??note.id}</span>
    </button>)}
  </div>;
}

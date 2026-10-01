import { useEffect, useRef } from "react";
import { X, FileText } from "lucide-react";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { closeWikilinkNavigation, useWikilinkNavigation } from "../../lib/wikilinkNavigation";

export function WikilinkChooser() {
  const request = useWikilinkNavigation(s=>s.request);
  const scope = useAgentChatStore(s=>s.scope);
  const dialog = useRef<HTMLDialogElement>(null);
  const visible = request?.scope===scope ? request : null;
  useEffect(()=>()=>closeWikilinkNavigation(),[]);
  useEffect(()=>{
    if (!visible) return;
    const element = dialog.current;
    element?.showModal();
    return ()=>{element?.close();visible.returnFocus();};
  },[visible?.id]);
  useEffect(()=>{if(request && request.scope!==scope)closeWikilinkNavigation();},[scope,request]);
  if (!visible) return null;
  return <dialog ref={dialog} aria-label="Open linked document" onCancel={e=>{e.preventDefault();closeWikilinkNavigation();}}
    className="m-auto w-[calc(100%-24px)] max-w-lg rounded-xl border border-[var(--glass-border)] bg-[var(--bg-surface)] p-0 text-[var(--text-primary)] shadow-xl backdrop:bg-black/40">
    <div className="flex items-center justify-between gap-3 border-b border-[var(--glass-border)] p-4"><h2 className="min-w-0 break-words text-base font-medium">{visible.state==="choose"?"Choose a document":"Open linked document"}</h2><button className="focus-ring shrink-0 rounded-lg p-2" aria-label="Close linked document picker" onClick={closeWikilinkNavigation}><X size={18}/></button></div>
    <div className="max-h-[65dvh] space-y-3 overflow-auto p-4">
      {visible.state==="loading" && <p role="status">Checking this link…</p>}
      {visible.state==="error" && <p role="alert" className="text-sm">{visible.error}</p>}
      {visible.state==="choose" && <><p className="break-words text-sm text-[var(--text-secondary)]">More than one document matches “{visible.target}”. Choose the one you mean.</p>
        {visible.candidates.map(note=><button key={note.id} className="focus-ring flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-[var(--glass-hover)]" onClick={()=>void visible.select(note.id)}><FileText size={18} className="mt-0.5 shrink-0"/><span className="min-w-0"><span className="block break-words text-sm font-medium">{note.title}</span><span className="block break-words text-xs text-[var(--text-secondary)]">{note.path??note.id}</span></span></button>)}</>}
    </div>
  </dialog>;
}

import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { useDocumentSnapshots } from "../../lib/agent/documentSnapshots";
import { SNAPSHOT_MAX_CHARACTERS, MAX_CONTEXT_SNAPSHOTS, type AgentContextSnapshot } from "../../lib/agent/contextSnapshots";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";

const control = "interactive focus-ring min-h-10 rounded-lg px-2 py-2 text-xs disabled:opacity-40";
export function AgentSnapshotAttachments({ noteId, snapshots, onChange, disabled, available, onReading }: {
  noteId?: string | null; snapshots: AgentContextSnapshot[]; onChange: (snapshots: AgentContextSnapshot[]) => void; disabled: boolean; available: boolean; onReading: (reading: boolean) => void;
}) {
  const capture = useDocumentSnapshots(s => noteId ? s.notes[noteId] : undefined);
  const scope = useAgentChatStore(s => s.scope);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<AgentContextSnapshot | null>(null);
  const locked = reading || disabled || !available || snapshots.length >= MAX_CONTEXT_SNAPSHOTS;
  const snapshotsRef = useRef(snapshots); snapshotsRef.current = snapshots;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const add = (snapshot: AgentContextSnapshot) => {
    if (snapshotsRef.current.length < MAX_CONTEXT_SNAPSHOTS) onChange([...snapshotsRef.current, snapshot]);
  };
  async function file(file: File) {
    setError(""); setReading(true); onReading(true);
    try {
      if (file.size > 256_000 || !/\.(txt|md|markdown|csv|json|log|js|ts|tsx|jsx|py|rs|css|html|yaml|yml)$/i.test(file.name)) throw Error("Choose a text or code file smaller than 256 KB.");
      const text = await file.text();
      if (!mounted.current || scope !== useAgentChatStore.getState().scope) return;
      if (!text.trim() || text.includes("\0")) throw Error("This file does not contain readable text.");
      add({ kind: "file", label: file.name.slice(0,200), text: text.slice(0, SNAPSHOT_MAX_CHARACTERS), capturedAt: new Date().toISOString(), truncated: text.length > SNAPSHOT_MAX_CHARACTERS });
    } catch (e) { if (mounted.current && scope === useAgentChatStore.getState().scope) setError(e instanceof Error ? e.message : "Could not read this file."); }
    finally { if (mounted.current) { setReading(false); onReading(false); } }
  }
  return <div className="mb-2 text-xs" data-testid="agent-snapshot-attachments">
    <div className="flex flex-wrap gap-1">
      {snapshots.map((s,index)=><span key={index} className="flex max-w-full items-center rounded-lg border border-[var(--glass-border)]"><button className={control+" min-w-0 truncate"} onClick={()=>setPreview(s)}><FileText size={13} className="mr-1 inline"/>{s.kind === "selection" ? "Selected passage" : s.kind === "document" ? "Document snapshot" : s.label}{s.truncated ? " · truncated" : ""}</button><button className={control} aria-label={`Remove snapshot ${index+1}`} disabled={disabled} onClick={()=>onChange(snapshots.filter((_,i)=>i!==index))}><X size={13}/></button></span>)}
      {available && <details className="rounded-lg"><summary className={control+" cursor-pointer"}>Capture text</summary><div className="flex flex-wrap gap-1 rounded-lg border border-[var(--glass-border)] p-2">
        <button className={control} disabled={locked || !capture?.selection?.text.trim()} onClick={()=>capture?.selection && add(capture.selection)}>Attach selection</button>
        <button className={control} disabled={locked || !capture?.document.text.trim()} onClick={()=>capture && add(capture.document)}>Attach document snapshot</button>
        <button className={control} disabled={locked} onClick={()=>fileRef.current?.click()}>Attach text file</button>
        <input ref={fileRef} type="file" aria-label="Choose context text file" className="sr-only" tabIndex={-1} disabled={locked} onChange={e=>{const picked=e.target.files?.[0];e.target.value="";if(picked)void file(picked);}}/>
      </div></details>}
    </div>
    {snapshots.length > 0 && <p className="mt-1 text-[var(--text-muted)]">Captured text, including unsaved edits. Up to 3 snapshots, 8,000 characters each. Preview before sending.</p>}
    {reading && <p role="status">Reading file…</p>}
    {error && <p role="alert" className="mt-1">{error}</p>}
    {preview && <AgentSnapshotPreview snapshot={preview} onClose={()=>setPreview(null)}/>}
  </div>;
}

export function AgentSnapshotPreview({ snapshot, onClose }: { snapshot: AgentContextSnapshot; onClose: () => void }) {
  const client = useVaultClient();
  const scope = useAgentChatStore(s=>s.scope);
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<{scope: string | null; snapshot: AgentContextSnapshot; status: "ready" | "denied"} | null>(null);
  const state = result?.scope === scope && result?.snapshot === snapshot ? result.status : "loading";
  useEffect(()=>{
    let active=true;
    const prior=document.activeElement as HTMLElement|null;
    dialog.current?.showModal();
    if (!snapshot.noteId) setResult({scope,snapshot,status:"ready"});
    else client.getNote(snapshot.noteId).then(()=>{if(active && useAgentChatStore.getState().scope===scope)setResult({scope,snapshot,status:"ready"});}).catch(()=>{if(active)setResult({scope,snapshot,status:"denied"});});
    return ()=>{active=false;dialog.current?.close();if(prior?.isConnected)prior.focus();};
  },[client,snapshot,scope]);
  return <dialog ref={dialog} aria-label="Captured context" className="agent-source-preview" onCancel={e=>{e.preventDefault();onClose();}}>
    <div className="flex max-h-[85dvh] flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--glass-border)] p-4"><div className="min-w-0"><h2 className="break-words text-sm font-medium">{state === "ready" ? snapshot.label : "Captured context"}</h2><p className="text-xs text-[var(--text-muted)]">{snapshot.kind} · {new Date(snapshot.capturedAt).toLocaleString()}{snapshot.truncated ? " · truncated" : ""}</p></div><button className={control} aria-label="Close captured context" onClick={onClose}><X size={18}/></button></header>
      {state === "ready" ? <pre className="min-h-0 overflow-auto whitespace-pre-wrap break-words p-4 text-sm">{snapshot.text}</pre> : <p role="status" className="p-4 text-sm">{state === "loading" ? "Checking source access…" : "This source is unavailable or your access changed."}</p>}
    </div>
  </dialog>;
}

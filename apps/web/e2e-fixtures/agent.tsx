import { SearchPanel } from "../../../packages/core/src/components/navigation/SearchPanel";
import { CommandBar } from "../../../packages/core/src/components/layout/CommandBar";
import { useComposerDraft } from "../../../packages/core/src/lib/agent/useComposerDraft";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import DocumentRenderer from "../../../packages/core/src/components/renderers/DocumentRenderer";
import { CollabDoc } from "../src/collab/CollabDoc";
import { useAgentDocumentSnapshot } from "../../../packages/core/src/lib/agent/documentSnapshots";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, AgentClientProvider, VaultClientProvider, createHttpAgentClient, useAgentChatStore, useUIStore, type VaultClient, type Note, type AgentClient, type AgentSession, type AgentPermissionMode } from "@prism/core";
import { fetchMe, agentScope, setActiveVault, setActiveWorkspace } from "../src/config";
import { httpAgentClient } from "../src/agent/HttpAgentClient";
import { useAgentConversation } from "../../../packages/core/src/lib/agent/useAgentConversation";
import AgentChat, { AgentPanelChat } from "../../../packages/core/src/components/agent/AgentChat";
import { AgentMarkdown } from "../../../packages/core/src/components/agent/AgentMarkdown";

const handoffFixture = new URLSearchParams(location.search).has("handoff");
const queueFixture = new URLSearchParams(location.search).has("queue");
const retryFixture = new URLSearchParams(location.search).has("retry");
const selectionFixture = new URLSearchParams(location.search).has("selection");
const snapshotFixture = new URLSearchParams(location.search).has("snapshots");
const attachmentsFixture = new URLSearchParams(location.search).has("attachments") || snapshotFixture;
const permissionsFixture = new URLSearchParams(location.search).has("permissions") || retryFixture || attachmentsFixture || queueFixture;
const contextFixture = new URLSearchParams(location.search).has("context");
const visualFixture = new URLSearchParams(location.search).has("visual");
const historyFixture = new URLSearchParams(location.search).has("history");
const fixtureNote = (id: string): Note => ({ id, path: id === "document-a" ? "Draft brief" : "Reference note", content: "<p>Fixture</p>", metadata: {}, tags: [], createdAt: "2026-10-01", updatedAt: "2026-10-01" });
const vault = { semanticSearch: async () => [fixtureNote("document-b")], listNotes: async () => [fixtureNote("document-a"), fixtureNote("document-b")], getLinks: async () => [], updateNote: async (id: string, changes: Partial<Note>) => ({ ...fixtureNote(id), ...changes }), search: async (query: string) => { if (controls.denySource) throw new Error("Fixture access denied"); return [fixtureNote("document-b")].filter((note) => note.path?.toLowerCase().includes(query.toLowerCase())); }, getNote: async (id: string) => { if (controls.holdSource) await new Promise<void>(resolve => controls.releaseSources.push(resolve)); if (controls.denySource) throw new Error("Fixture access denied"); return fixtureNote(id); } } as unknown as VaultClient;
if (contextFixture) useUIStore.getState().openTab("document-a", "Draft brief", "document");
const controls = { holdSource: false, releaseSources: [] as (() => void)[], holdTurn: false, releaseTurn: null as null | (() => void), listFails: new URLSearchParams(location.search).has("list-error"), attempts: 0, turnAttempts: 0, reject: !permissionsFixture, queueAttempts:0, loseQueueResponse:false, rejectQueueChange:false, rejectTurn:false, lastOptions:null as unknown, pendingMode: false, denySource: false, archived: [] as string[], completeTurn: () => {}, releaseLimits: () => {}, releaseSession: () => {} };
const limitsReady = new Promise<void>((resolve) => { controls.releaseLimits = resolve; if (!new URLSearchParams(location.search).has("slow-limits")) resolve(); });
const sessionReady = new Promise<void>((resolve) => { controls.releaseSession = resolve; if (!new URLSearchParams(location.search).has("slow-session")) resolve(); });
Object.assign(window, { prismAgentFixture: controls, prismAgentStore: useAgentChatStore, prismFixtureUI: useUIStore, prismAgentHost: { fetchMe, agentScope, setActiveVault, setActiveWorkspace, httpAgentClient, createHttpAgentClient } });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const audience = (owner: string) => JSON.stringify(["https://fixture.example.test/api", "workspace", "vault", owner]);
let scope = audience("alex@example.test");
useAgentChatStore.getState().bindScope(scope);
const session: AgentSession = { id: "fixture-session", vault_id: "vault", owner_email: "alex@example.test", title: "Document conversation", profile: "vault-ro", note_id: null, cli_session_id: null, status: "idle", transcript_note_id: null, cost_usd: 0, created_at: 1, updated_at: 1 };
if (historyFixture) { session.title = "Shape the launch brief"; session.note_id = "document-a"; useAgentChatStore.getState().setActiveSession(session.id); }
if (permissionsFixture) Object.assign(session, JSON.parse(localStorage.getItem("fixture-agent-policy") ?? '{"permission_mode":"read-only","policy_version":1,"profile":"prism-ro"}'));
let settleAfter = 0;
const policyProfile = (mode: AgentPermissionMode) => mode === "read-only" ? "prism-ro" : mode === "suggest" ? "prism-suggest" : "prism-rw";
const persistPolicy = () => localStorage.setItem("fixture-agent-policy", JSON.stringify(session));
function acceptRetryRequest(kind: "session" | "turn", requestId?: string) {
  if (!requestId) throw new Error("Missing retry identifier");
  const key = `fixture-accepted-${kind}`;
  const accepted: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
  if (accepted.includes(requestId)) return;
  accepted.push(requestId);
  localStorage.setItem(key, JSON.stringify(accepted));
  throw new Error(`Fixture lost ${kind} response after acceptance`);
}
let followups:any[]=JSON.parse(localStorage.getItem('fixture-followups')??'[]');
let queueTurns:any[]=JSON.parse(localStorage.getItem('fixture-queue-turns')??'[]');
const persistQueue=()=>{localStorage.setItem('fixture-followups',JSON.stringify(followups));localStorage.setItem('fixture-queue-turns',JSON.stringify(queueTurns));};
Object.assign(controls,{finishCurrent:()=>{for(const turn of queueTurns)turn.status='done';persistQueue();},pauseQueue:()=>{for(const row of followups){row.status='blocked';row.version++;row.error='Session permissions changed.';}persistQueue();}});
const client: AgentClient = {
  listFollowups:async()=>({followups:followups.filter(r=>r.status!=='cancelled'&&r.status!=='accepted').map(r=>({...r}))}),
  queueFollowup:async(id,payload)=>{
    controls.queueAttempts++;
    let row=followups.find(r=>r.requestId===payload.requestId);
    if(!row){row={id:crypto.randomUUID(),sessionId:id,requestId:payload.requestId,status:'waiting',version:1,permissionMode:session.permission_mode,payload,error:null,turnId:null,createdAt:Date.now()};followups.push(row);persistQueue();}
    if(controls.loseQueueResponse){controls.loseQueueResponse=false;throw Error('Fixture queue response lost');}
    return {followup:{...row}};
  },
  changeFollowup:async(_sid,id,change)=>{
    const row=followups.find(r=>r.id===id);if(controls.rejectQueueChange||!row||row.version!==change.version)throw Error('Queue changed');
    if(change.payload)row.payload=change.payload;
    row.status=change.action==='cancel'?'cancelled':change.action==='resume'?'waiting':row.status;
    if(change.action==='resume'){row.permissionMode=session.permission_mode;row.error=null;}
    row.version++;persistQueue();return {followup:{...row}};
  },
  scope: () => new URLSearchParams(location.search).has("collab") ? agentScope() ?? "" : scope,
  createSession: async (params) => { controls.attempts++; await new Promise((resolve) => setTimeout(resolve, 150)); if (controls.reject) throw new Error("Fixture create rejected"); if (retryFixture) acceptRetryRequest("session", params?.requestId); session.note_id = params?.noteId ?? null; if (params?.permissionMode) { session.permission_mode = params.permissionMode; session.profile = policyProfile(params.permissionMode); persistPolicy(); } return { sessionId: session.id, session }; },
  listSessions: async (options) => {
    if (options?.limit === 50 && controls.listFails) throw Error("Fixture session list unavailable");
    return historyFixture ? [session, { ...session, id: "second-session", title: "Explore the source material" }, ...(visualFixture ? [{ ...session, id: "older-session", title: "Review the weekly plan" }] : [])].filter((s) => !controls.archived.includes(s.id)).map((s) => ({ ...s, turnCount: 1, lastTurnAt: s.id === "older-session" ? Date.now() - 3 * 86400000 : Date.now(), lastTurnStatus: "done" as const })) : [];
  },
  getSession: async () => {
    await sessionReady;
    if (session.pending_mode && --settleAfter <= 0) {
      session.permission_mode = session.pending_mode; session.pending_mode = null;
      session.profile = policyProfile(session.permission_mode); session.policy_version!++; persistPolicy();
    }
    return { session: { ...session }, turns: queueFixture ? queueTurns : historyFixture || (attachmentsFixture && !!localStorage.getItem("fixture-attachment-context")) ? [{ context: JSON.parse(localStorage.getItem("fixture-attachment-context") ?? "[]"), id: "history-turn", session_id: session.id, prompt: "Help me make the launch brief clearer. Keep the original tone and suggest a stronger opening.", note_id: session.note_id, status: "done", pid: null, exit_code: 0, error: null, cost_usd: 0.06, started_at: Date.now() - 60_000, ended_at: Date.now() - 58_000, finalText: "The brief already has a clear purpose. I would bring that purpose into the first sentence:\n\n**A shared place to think, write, and build—with your context close at hand.**\n\nThis keeps the focus on collaboration and gives the reader a concrete sense of what Prism helps them do.\n\nWould you like me to suggest this change in the document?", tools: [], touched: [] }] : [] };
  },
  ...(permissionsFixture ? {
    getLimits: async () => { await limitsReady; return { billing: "unknown" as const, session: { limitUsd: null }, daily: { limitUsd: null, spentUsd: 0, remainingUsd: null, resetsAt: Date.now() }, profiles: ["prism-ro", "prism-suggest", "prism-rw"] as const as any, defaultProfile: "prism-ro" as const, permissionModes: ["read-only", "suggest", "read-write"] as AgentPermissionMode[], idempotentRequests: true, ...(queueFixture ? {followups:{maxQueued:10}} : {}), ...(attachmentsFixture ? { contextNotes: { maxNotes: 5, maxCharactersPerNote: 8000 }, ...(snapshotFixture ? {contextSnapshots:{maxSnapshots:3,maxCharacters:8000}} : {}) } : {}) }; },
    updatePermissions: async (_id: string, mode: AgentPermissionMode, version: number) => {
      if (version !== session.policy_version) throw new Error("Policy changed elsewhere");
      if (controls.pendingMode) { session.pending_mode = mode; settleAfter = 2; }
      else { session.permission_mode = mode; session.profile = policyProfile(mode); session.policy_version!++; }
      persistPolicy();
      return { session: { ...session } };
    },
  } : {}),
  sendTurn: async (_id, _prompt, options) => { controls.turnAttempts++; controls.lastOptions=options; if(controls.holdTurn) await new Promise<void>(resolve=>{controls.releaseTurn=resolve;}); if(controls.rejectTurn)throw Error("Fixture turn rejected"); if (retryFixture) acceptRetryRequest("turn", options?.requestId); const context = (options?.contextNoteIds ?? []).map((noteId) => ({ noteId, characters: 8000, truncated: true, updatedAt: "2026-10-01T10:00:00Z" })); if(queueFixture){queueTurns.push({id:crypto.randomUUID(),session_id:session.id,prompt:_prompt,note_id:session.note_id,status:'running',pid:null,exit_code:null,error:null,cost_usd:null,started_at:Date.now(),ended_at:null,finalText:'',tools:[],touched:[]});persistQueue();}
    const allContext=[...context,...(options?.contextSnapshots??[]).map(snapshot=>({noteId:snapshot.noteId??"",characters:snapshot.text.length,truncated:snapshot.truncated,updatedAt:snapshot.baseUpdatedAt??null,snapshot}))]; if (attachmentsFixture) localStorage.setItem("fixture-attachment-context", JSON.stringify(allContext)); return { turnId: queueFixture ? queueTurns.at(-1).id : "fixture-turn", status: retryFixture || attachmentsFixture ? "done" : "running", context:allContext }; },
  cancelTurn: async () => true,
  archiveSession: async (id) => { controls.archived.push(id); },
  streamSession: (_id, _after, handlers) => {
    controls.completeTurn = () => { session.cost_usd = 0.06; handlers.onEvent({ t: "status", status: "done", turnId: "fixture-turn", seq: 1 }); };
    return () => {};
  },
};
function BudgetProbe() {
  const conversation = useAgentConversation(client, session.id);
  return <div><button onClick={() => { void conversation.send("Budget test"); }}>Send test turn</button><output aria-label="Session spend">{conversation.session?.cost_usd ?? "loading"}</output></div>;
}
function MarkdownProbe() {
  const [text, setText] = useState("");
  return <div className="min-w-0 p-4"><textarea aria-label="Fixture Markdown" value={text} onChange={(event) => setText(event.target.value)} /><section aria-label="Rendered reply"><AgentMarkdown text={text} /></section></div>;
}
function SnapshotEditor() {
  const editor=useEditor({extensions:[StarterKit],content:"<p>Initial captured draft.</p>"});
  useAgentDocumentSnapshot(editor,"document-a","Draft brief","2026-10-01T10:00:00Z");
  return <section aria-label="Working document" className="max-h-32 shrink-0 overflow-auto border-b p-3"><EditorContent editor={editor}/></section>;
}
function SelectionDocument() {
  const [note] = useState(() => ({ ...fixtureNote("document-a"), content: "<h2>Working draft</h2><p>Initial captured draft.</p>" }));
  return <section aria-label="Working document" style={{ height: "48vh", minHeight: 280, flexShrink: 0, overflow: "auto" }}>
    <PlatformProvider value="web">{new URLSearchParams(location.search).has("collab") ? <CollabDoc noteId="document-a" /> : <DocumentRenderer note={note} readOnly={new URLSearchParams(location.search).has("view")} />}</PlatformProvider>
  </section>;
}
function ContextMirror() {
 const session = useAgentChatStore(s=>s.activeSessionId), draft = useAgentChatStore(s=>s.draft);
 const saved = useComposerDraft(scope, `context:${session ? `session:${session}` : `note:${draft?.noteId ?? "new"}`}`);
 Object.assign(window, { prismContextMirror: saved });
 return null;
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [, update] = useState(0);
  const expanded = useUIStore((s) => s.activeTabId === "agent-chat");
  const switchTo = (owner: string) => { scope = audience(owner); useAgentChatStore.getState().bindScope(scope); update((n) => n + 1); };
  return <QueryClientProvider client={query}><VaultClientProvider client={vault}><AgentClientProvider client={client}>
    <div style={{ height: "100dvh", maxWidth: visualFixture ? undefined : historyFixture ? 1040 : 600 }} className="flex flex-col">
      <div className="flex gap-4 p-3"><button onClick={() => setVisible((v) => !v)}>Toggle panel</button><button onClick={() => switchTo("alex@example.test")}>Alex</button><button onClick={() => switchTo("morgan@example.test")}>Morgan</button></div>
      {handoffFixture && <><ContextMirror/><button onClick={()=>useUIStore.getState().openCommandBar()}>Search workspace</button><div className="h-48 shrink-0 overflow-auto"><SearchPanel query="Reference" onClose={()=>{}}/></div><CommandBar/></>}
      {selectionFixture ? <SelectionDocument/> : snapshotFixture && <SnapshotEditor/>}
      {contextFixture && <button onClick={() => useUIStore.getState().openTab("document-b", "Reference note", "document")}>Open reference</button>}
      {new URLSearchParams(location.search).has("markdown") ? <MarkdownProbe /> : new URLSearchParams(location.search).has("budget") ? <BudgetProbe /> : visible && ((contextFixture && expanded) || historyFixture || handoffFixture ? <AgentChat note={fixtureNote("agent-chat")} /> : <AgentPanelChat client={client} />)}
    </div>
  </AgentClientProvider></VaultClientProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

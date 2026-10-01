import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentClientProvider, VaultClientProvider, createHttpAgentClient, useAgentChatStore, useUIStore, type VaultClient, type Note, type AgentClient, type AgentSession, type AgentPermissionMode } from "@prism/core";
import { fetchMe, agentScope, setActiveVault, setActiveWorkspace } from "../src/config";
import { httpAgentClient } from "../src/agent/HttpAgentClient";
import { useAgentConversation } from "../../../packages/core/src/lib/agent/useAgentConversation";
import AgentChat, { AgentPanelChat } from "../../../packages/core/src/components/agent/AgentChat";
import { AgentMarkdown } from "../../../packages/core/src/components/agent/AgentMarkdown";

const retryFixture = new URLSearchParams(location.search).has("retry");
const attachmentsFixture = new URLSearchParams(location.search).has("attachments");
const permissionsFixture = new URLSearchParams(location.search).has("permissions") || retryFixture || attachmentsFixture;
const contextFixture = new URLSearchParams(location.search).has("context");
const historyFixture = new URLSearchParams(location.search).has("history");
const fixtureNote = (id: string): Note => ({ id, path: id === "document-a" ? "Draft brief" : "Reference note", content: "<p>Fixture</p>", metadata: {}, tags: [], createdAt: "2026-10-01", updatedAt: "2026-10-01" });
const vault = { search: async (query: string) => { if (controls.denySource) throw new Error("Fixture access denied"); return [fixtureNote("document-b")].filter((note) => note.path?.toLowerCase().includes(query.toLowerCase())); }, getNote: async (id: string) => { if (controls.denySource) throw new Error("Fixture access denied"); return fixtureNote(id); } } as VaultClient;
if (contextFixture) useUIStore.getState().openTab("document-a", "Draft brief", "document");
const controls = { attempts: 0, turnAttempts: 0, reject: !permissionsFixture, pendingMode: false, denySource: false, archived: [] as string[], completeTurn: () => {}, releaseLimits: () => {}, releaseSession: () => {} };
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
const client: AgentClient = {
  scope: () => scope,
  createSession: async (params) => { controls.attempts++; await new Promise((resolve) => setTimeout(resolve, 150)); if (controls.reject) throw new Error("Fixture create rejected"); if (retryFixture) acceptRetryRequest("session", params?.requestId); session.note_id = params?.noteId ?? null; if (params?.permissionMode) { session.permission_mode = params.permissionMode; session.profile = policyProfile(params.permissionMode); persistPolicy(); } return { sessionId: session.id, session }; },
  listSessions: async () => historyFixture ? [session, { ...session, id: "second-session", title: "Explore the source material" }].filter((s) => !controls.archived.includes(s.id)).map((s) => ({ ...s, turnCount: 1, lastTurnAt: Date.now(), lastTurnStatus: "done" as const })) : [],
  getSession: async () => {
    await sessionReady;
    if (session.pending_mode && --settleAfter <= 0) {
      session.permission_mode = session.pending_mode; session.pending_mode = null;
      session.profile = policyProfile(session.permission_mode); session.policy_version!++; persistPolicy();
    }
    return { session: { ...session }, turns: historyFixture || (attachmentsFixture && !!localStorage.getItem("fixture-attachment-context")) ? [{ context: JSON.parse(localStorage.getItem("fixture-attachment-context") ?? "[]"), id: "history-turn", session_id: session.id, prompt: "Help me make the launch brief clearer. Keep the original tone and suggest a stronger opening.", note_id: session.note_id, status: "done", pid: null, exit_code: 0, error: null, cost_usd: 0.06, started_at: Date.now() - 60_000, ended_at: Date.now() - 58_000, finalText: "The brief already has a clear purpose. I would bring that purpose into the first sentence:\n\n**A shared place to think, write, and build—with your context close at hand.**\n\nThis keeps the focus on collaboration and gives the reader a concrete sense of what Prism helps them do.\n\nWould you like me to suggest this change in the document?", tools: [], touched: [] }] : [] };
  },
  ...(permissionsFixture ? {
    getLimits: async () => { await limitsReady; return { billing: "unknown" as const, session: { limitUsd: null }, daily: { limitUsd: null, spentUsd: 0, remainingUsd: null, resetsAt: Date.now() }, profiles: ["prism-ro", "prism-suggest", "prism-rw"] as const as any, defaultProfile: "prism-ro" as const, permissionModes: ["read-only", "suggest", "read-write"] as AgentPermissionMode[], idempotentRequests: true, ...(attachmentsFixture ? { contextNotes: { maxNotes: 5, maxCharactersPerNote: 8000 } } : {}) }; },
    updatePermissions: async (_id: string, mode: AgentPermissionMode, version: number) => {
      if (version !== session.policy_version) throw new Error("Policy changed elsewhere");
      if (controls.pendingMode) { session.pending_mode = mode; settleAfter = 2; }
      else { session.permission_mode = mode; session.profile = policyProfile(mode); session.policy_version!++; }
      persistPolicy();
      return { session: { ...session } };
    },
  } : {}),
  sendTurn: async (_id, _prompt, options) => { controls.turnAttempts++; if (retryFixture) acceptRetryRequest("turn", options?.requestId); const context = (options?.contextNoteIds ?? []).map((noteId) => ({ noteId, characters: 8000, truncated: true, updatedAt: "2026-10-01T10:00:00Z" })); if (attachmentsFixture) localStorage.setItem("fixture-attachment-context", JSON.stringify(context)); return { turnId: "fixture-turn", status: retryFixture || attachmentsFixture ? "done" : "running", context }; },
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
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [, update] = useState(0);
  const expanded = useUIStore((s) => s.activeTabId === "agent-chat");
  const switchTo = (owner: string) => { scope = audience(owner); useAgentChatStore.getState().bindScope(scope); update((n) => n + 1); };
  return <QueryClientProvider client={query}><VaultClientProvider client={vault}><AgentClientProvider client={client}>
    <div style={{ height: "100dvh", maxWidth: historyFixture ? 1040 : 600 }} className="flex flex-col">
      <div className="flex gap-4 p-3"><button onClick={() => setVisible((v) => !v)}>Toggle panel</button><button onClick={() => switchTo("alex@example.test")}>Alex</button><button onClick={() => switchTo("morgan@example.test")}>Morgan</button></div>
      {contextFixture && <button onClick={() => useUIStore.getState().openTab("document-b", "Reference note", "document")}>Open reference</button>}
      {new URLSearchParams(location.search).has("markdown") ? <MarkdownProbe /> : new URLSearchParams(location.search).has("budget") ? <BudgetProbe /> : visible && ((contextFixture && expanded) || historyFixture ? <AgentChat note={fixtureNote("agent-chat")} /> : <AgentPanelChat client={client} />)}
    </div>
  </AgentClientProvider></VaultClientProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

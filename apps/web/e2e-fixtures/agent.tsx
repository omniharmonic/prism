import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentClientProvider, createHttpAgentClient, useAgentChatStore, type AgentClient, type AgentSession } from "@prism/core";
import { fetchMe, agentScope, setActiveVault, setActiveWorkspace } from "../src/config";
import { httpAgentClient } from "../src/agent/HttpAgentClient";
import { AgentPanelChat } from "../../../packages/core/src/components/agent/AgentChat";

const controls = { attempts: 0, reject: true };
Object.assign(window, { prismAgentFixture: controls, prismAgentStore: useAgentChatStore, prismAgentHost: { fetchMe, agentScope, setActiveVault, setActiveWorkspace, httpAgentClient, createHttpAgentClient } });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const audience = (owner: string) => JSON.stringify(["https://fixture.example.test/api", "workspace", "vault", owner]);
let scope = audience("alex@example.test");
useAgentChatStore.getState().bindScope(scope);
const session: AgentSession = { id: "fixture-session", vault_id: "vault", owner_email: "alex@example.test", title: "Document conversation", profile: "vault-ro", note_id: null, cli_session_id: null, status: "idle", transcript_note_id: null, cost_usd: 0, created_at: 1, updated_at: 1 };
const client: AgentClient = {
  scope: () => scope,
  createSession: async () => { controls.attempts++; await new Promise((resolve) => setTimeout(resolve, 150)); if (controls.reject) throw new Error("Fixture create rejected"); return { sessionId: session.id, session }; },
  listSessions: async () => [],
  getSession: async () => ({ session, turns: [] }),
  sendTurn: async () => ({ turnId: "fixture-turn", status: "done" }),
  cancelTurn: async () => true,
  archiveSession: async () => {},
  streamSession: () => () => {},
};
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [, update] = useState(0);
  const switchTo = (owner: string) => { scope = audience(owner); useAgentChatStore.getState().bindScope(scope); update((n) => n + 1); };
  return <QueryClientProvider client={query}><AgentClientProvider client={client}>
    <div style={{ height: "100dvh", maxWidth: 600 }} className="flex flex-col">
      <div className="flex gap-4 p-3"><button onClick={() => setVisible((v) => !v)}>Toggle panel</button><button onClick={() => switchTo("alex@example.test")}>Alex</button><button onClick={() => switchTo("morgan@example.test")}>Morgan</button></div>
      {visible && <AgentPanelChat client={client} />}
    </div>
  </AgentClientProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

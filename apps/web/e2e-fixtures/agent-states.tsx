import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentClientProvider, VaultClientProvider, useAgentChatStore, type VaultClient, type Note } from "@prism/core";
import type { AgentClient, AgentSessionDetail, AgentStreamHandlers } from "../../../packages/core/src/lib/agent/sessions";
import { Conversation } from "../../../packages/core/src/components/agent/AgentChat";
const scope = "fictional-agent-states";
useAgentChatStore.getState().bindScope(scope);
const detail = (id: string): AgentSessionDetail => ({
  session: { id, vault_id: "fictional-vault", owner_email: "alex@example.test", title: `Conversation ${id}`, profile: "prism-ro", permission_mode: "read-only", note_id: "brief", cli_session_id: null, status: "running", transcript_note_id: null, cost_usd: 0, created_at: 1, updated_at: 1 },
  turns: [{ id: `${id}-turn`, session_id: id, prompt: "Compare the two notes and summarize the shared ideas.", note_id: "brief", status: "running", pid: null, exit_code: null, error: null, cost_usd: null, started_at: 1790956800000, ended_at: null, finalText: "", tools: [], touched: [], firstSeq: 1, lastSeq: 0 }], lastSeq: 0,
});
const details = new Map([["first", detail("first")], ["second", detail("second")]]);
let current: { id: string; handlers: AgentStreamHandlers } | null = null;
const controls = {
  stops: [] as string[],
  settle: null as null | ((accepted: boolean) => void),
  fail: null as null | (() => void),
  activity() {
    const active = current!;
    active.handlers.onEvent({ t: "tool_use", turnId: `${active.id}-turn`, seq: 1, id: "read", name: "read_note", input: {} });
    active.handlers.onEvent({ t: "tool_result", turnId: `${active.id}-turn`, seq: 2, toolUseId: "read", ok: true, summary: "Read the source successfully.\n" + "A long source identifier and explanatory result ".repeat(40) });
    active.handlers.onEvent({ t: "tool_use", turnId: `${active.id}-turn`, seq: 3, id: "search", name: "search_notes", input: {} });
    active.handlers.onEvent({ t: "text_delta", turnId: `${active.id}-turn`, blockId: "reply", text: "I’m comparing the shared context in these notes." });
  },
  reconnect() { current!.handlers.onError?.(new Error("Fixture connection lost"), { willRetry: true }); },
  finish(id = "first") {
    const record = details.get(id)!;
    record.turns[0]!.status = "cancelled";
    record.session.status = "idle";
    if (current?.id === id) current.handlers.onEvent({ t: "status", status: "cancelled", seq: 4, turnId: `${id}-turn` });
  },
};
Object.assign(window, { prismAgentStates: controls });
const client: AgentClient = {
  scope: () => scope,
  createSession: async () => { throw Error("Existing fixture sessions only"); },
  listSessions: async () => [],
  getSession: async id => structuredClone(details.get(id)!),
  sendTurn: async () => { throw Error("Fixture does not generate real turns"); },
  streamSession: (id, handlersAfter, handlers) => {
    void handlersAfter;
    const entry = { id, handlers }; current = entry;
    queueMicrotask(() => { if (current === entry) handlers.onOpen?.(); });
    return () => { if (current === entry) current = null; };
  },
  cancelTurn: id => { controls.stops.push(id); return new Promise<boolean>((resolve, reject) => { controls.settle = resolve; controls.fail = () => reject(new Error("Fixture stop response lost")); }); },
  archiveSession: async () => {},
  getLimits: async () => ({ billing: "unknown", session: { limitUsd: null }, daily: { limitUsd: null, spentUsd: 0, remainingUsd: null, resetsAt: 0 }, profiles: ["prism-ro"], defaultProfile: "prism-ro", permissionModes: ["read-only"], idempotentRequests: true }),
};
const note: Note = { id: "brief", path: "Draft brief", content: "Fictional document.", metadata: {}, tags: [], createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const unsupported = async (): Promise<never> => { throw new Error("Unexpected vault operation in agent-state fixture"); };
const vault: VaultClient = { scope: () => scope, getNote: async () => note, listNotes: unsupported, listTree: unsupported, createNote: unsupported, updateNote: unsupported, deleteNote: unsupported, search: unsupported, getTags: unsupported, addTags: unsupported, removeTags: unsupported, getStats: unsupported, getLinks: unsupported, createLink: unsupported, deleteLink: unsupported, getGraph: unsupported, getVaultInfo: unsupported, updateVaultDescription: unsupported };
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [id, setId] = useState("first"); const [shown, setShown] = useState(true);
  return <QueryClientProvider client={queries}><VaultClientProvider client={vault}><AgentClientProvider client={client}><main className="flex h-[100dvh] max-w-[440px] flex-col"><div className="flex gap-3 p-2"><button onClick={() => setId("second")}>Switch session</button><button onClick={() => setShown(false)}>Unmount</button></div>{shown && <Conversation client={client} sessionId={id} onCreated={() => {}} compact />}</main></AgentClientProvider></VaultClientProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

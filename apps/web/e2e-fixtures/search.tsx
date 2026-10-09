import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentClientProvider, type AgentClient, VaultClientProvider, PlatformProvider, useAgentChatStore, useUIStore, type Note, type VaultClient } from "@prism/core";
import { SearchPanel } from "../../../packages/core/src/components/navigation/SearchPanel";
import { CommandBar } from "../../../packages/core/src/components/layout/CommandBar";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.remove("light");
const controls = { semantic: "ok", keyword: "ok", requests: [] as string[], release: null as null | (() => void) };
const note: Note = { id: "source-a", path: "Projects/Prism/Connected ideas", content: '<h2>Shared context</h2><p>Documents &amp; conversations.</p><script>window.prismInjected = true</script><img src="https://untrusted.example.test/private">', tags: ["note"], metadata: { type: "document" }, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const vault = {
  semanticSearch: async (q: string) => {
    controls.requests.push(`ranked:${q}`);
    const scope = useAgentChatStore.getState().scope;
    if (controls.semantic === "wait") await new Promise<void>(resolve => { controls.release = resolve; });
    if (controls.semantic === "fail") throw new Error("Unavailable");
    return scope === "search-b" || q === "nothing" ? [] : params.has("many") ? [note, ...Array.from({length:10}, (_,i)=>({...note,id:`message-${i}`,path:`Messages/Design/Prism discussion ${i + 1}`,metadata:{type:"message-thread"},content:"A conversation about the new collaborative workspace."}))] : [{ ...note, _snippet: "A matching passage about connected ideas." }];
  },
  search: async (q: string) => { controls.requests.push(`keyword:${q}`); if (controls.keyword === "fail") throw new Error("Denied"); if (useAgentChatStore.getState().scope === "search-b") return []; if (controls.keyword === "extra") return [{ ...note, id: "exact-title", path: "Library/Ideas ledger", content: "<p>A plain keyword hit the ranked index has not seen yet.</p>" }, note, { ...note, id: "body-only", path: "Library/Minutes", content: "<p>Loose ideas were mentioned once.</p>" }]; return q === "nothing" ? [] : [note]; },
} as unknown as VaultClient;
const agent = { listSessions: async () => [] } as unknown as AgentClient;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
useAgentChatStore.setState({ scope: "search-a" });
Object.assign(window, { prismSearchFixture: controls, prismSearchUI: useUIStore, prismSearchStore: useAgentChatStore, prismSearchClient: client });
function Nested({ children }: {children: React.ReactNode}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal(); return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} aria-label="Parent navigation" onCancel={e=>{e.preventDefault();dialog.current?.close();}}>{children}</dialog>;
}
function Fixture() {
  const [query, setQuery] = useState("ideas");
  return <><button onClick={e => { e.currentTarget.focus(); useUIStore.getState().openCommandBar(); }}>Open search</button><label>Query<input aria-label="Query" style={{ border: "1px solid var(--glass-border)" }} value={query} onChange={e => setQuery(e.target.value)} /></label><div style={{ width: "min(480px, 100%)" }}><SearchPanel query={query} onClose={() => {}} /></div><CommandBar /></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><PlatformProvider value="web"><VaultClientProvider client={vault}><AgentClientProvider client={params.has("no-agent") ? null : agent}>{params.has("nested") ? <Nested><Fixture /></Nested> : <Fixture />}</AgentClientProvider></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);

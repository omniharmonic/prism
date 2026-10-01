import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, useAgentChatStore, useUIStore, type Note, type VaultClient } from "@prism/core";
import { SearchPanel } from "../../../packages/core/src/components/navigation/SearchPanel";
import { CommandBar } from "../../../packages/core/src/components/layout/CommandBar";
const controls = { semantic: "ok", keyword: "ok", requests: [] as string[], release: null as null | (() => void) };
const note: Note = { id: "source-a", path: "Projects/Prism/Connected ideas", content: '<h2>Shared context</h2><p>Documents &amp; conversations.</p><script>window.prismInjected = true</script><img src="https://untrusted.example.test/private">', tags: ["note"], metadata: { type: "document" }, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const vault = {
  semanticSearch: async (q: string) => {
    controls.requests.push(`ranked:${q}`);
    const scope = useAgentChatStore.getState().scope;
    if (controls.semantic === "wait") await new Promise<void>(resolve => { controls.release = resolve; });
    if (controls.semantic === "fail") throw new Error("Unavailable");
    return scope === "search-b" || q === "nothing" ? [] : [{ ...note, _snippet: "A matching passage about connected ideas." }];
  },
  search: async (q: string) => { controls.requests.push(`keyword:${q}`); if (controls.keyword === "fail") throw new Error("Denied"); return q === "nothing" ? [] : [note]; },
} as unknown as VaultClient;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
useAgentChatStore.setState({ scope: "search-a" });
Object.assign(window, { prismSearchFixture: controls, prismSearchUI: useUIStore, prismSearchStore: useAgentChatStore, prismSearchClient: client });
function Fixture() {
  const [query, setQuery] = useState("ideas");
  return <><button onClick={() => useUIStore.getState().openCommandBar()}>Open search</button><label>Query<input aria-label="Query" value={query} onChange={e => setQuery(e.target.value)} /></label><div style={{ width: "min(480px, 100%)" }}><SearchPanel query={query} onClose={() => {}} /></div><CommandBar /></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={client}><PlatformProvider value="web"><VaultClientProvider client={vault}><Fixture /></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);

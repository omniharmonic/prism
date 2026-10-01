import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  VaultClientProvider,
  PlatformProvider,
  useAgentChatStore,
  useUIStore,
  type VaultClient,
  type VaultNeighborhood,
  type Note,
} from "@prism/core";
import { GraphExplorer } from "../../../packages/core/src/components/layout/GraphExplorer";
import { GraphFullscreen } from "../../../packages/core/src/components/layout/GraphFullscreen";
const nodes = [
  {
    id: "home",
    title: "A living workspace",
    path: "Projects/Prism/A living workspace",
    tags: ["project"],
  },
  {
    id: "people",
    title: "People and conversations",
    path: "Research/People and conversations",
    tags: ["research"],
  },
  {
    id: "ideas",
    title: "Connected ideas",
    path: "Notes/Connected ideas",
    tags: ["note"],
  },
  {
    id: "plan",
    title: "Next steps",
    path: "Projects/Prism/Next steps",
    tags: ["task"],
  },
];
const graph: VaultNeighborhood = {
  nodes,
  edges: [
    { source: "home", target: "people", relationship: "explores" },
    { source: "ideas", target: "home", relationship: "supports" },
    { source: "home", target: "plan", relationship: "next" },
  ],
  truncated: true,
};
const controls = {
  calls: [] as string[],
  fail: false,
  hold: false,
  release: null as null | (() => void),
  denyOpen: false,
  opened: [] as string[],
};
const client = {
  scope: () => useAgentChatStore.getState().scope ?? "",
  getNeighborhood: async (center: string) => {
    controls.calls.push(center);
    if (controls.hold)
      await new Promise<void>((r) => {
        controls.release = r;
      });
    if (controls.fail) throw Error("denied");
    return graph;
  },
  getNote: async (id: string) => {
    if (controls.denyOpen) throw Error("denied");
    controls.opened.push(id);
    return {
      ...nodes.find((n) => n.id === id)!,
      content: "Synthetic graph document",
      metadata: { type: "document" },
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
    } as Note;
  },
} as unknown as VaultClient;
const query = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
useAgentChatStore.setState({ scope: "graph-a" });
useUIStore.getState().openTab("home", "A living workspace", "document");
Object.assign(window, {
  prismGraphFixture: controls,
  prismGraphStore: useAgentChatStore,
  prismGraphUI: useUIStore,
  prismGraphQuery: query,
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={query}>
      <PlatformProvider value="web">
        <VaultClientProvider client={client}>
          <main style={{ height: "100dvh", maxWidth: 880, margin: "auto" }}>
            <GraphExplorer noteId="home" />
            <GraphFullscreen />
          </main>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

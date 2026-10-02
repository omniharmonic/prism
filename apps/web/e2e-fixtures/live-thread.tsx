import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, VaultClientProvider, type VaultClient, type Note, type MatrixMessage } from "@prism/core";
import MessageRenderer from "../../../packages/core/src/components/renderers/MessageRenderer";
const controls = { fail: false, reads: [] as Array<string | undefined>, writes: 0 };
Object.assign(window, { prismLiveThreadFixture: controls });
const messages: MatrixMessage[] = Array.from({ length: 70 }, (_, i) => ({ event_id: `event-${i}`, sender: `@${i % 2 ? "alex-design" : "alex-engineering"}:example.test`, sender_name: "Alex", timestamp: Date.UTC(2026, 8, 30, 23, 0) + i * 60000, body: `Live message ${i}\nKeep this line.`, msg_type: "m.text", is_outgoing: false, media_url: null, media_info: null, source: "matrix" }));
messages[69].body = 'Read https://example.test/plan. Literal <img src="https://example.test/tracker"> javascript:alert(1)';
const note: Note = { id: "fixture-thread", path: "Messages/Design discussion", metadata: { matrixRoomId: "!room:example.test", platform: "telegram" }, content: Array.from({ length: 120 }, (_, i) => `[2026-10-01 10:15] Saved sender: Saved message ${i}`).join("\n"), tags: ["message-thread"], createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const client = {
  scope: () => "fixture-owner",
  getThreadMessages: async (_id: string, before?: string) => {
    controls.reads.push(before);
    if (controls.fail) throw Error("Fixture unavailable");
    return before ? { messages: messages.slice(0, 21).reverse(), start: before, end: null, has_more: false }
      : { messages: messages.slice(20).reverse(), start: "now", end: "older", has_more: true };
  },
  addTags: async () => { controls.writes++; }, removeTags: async () => { controls.writes++; },
} as unknown as VaultClient;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queryClient}><PlatformProvider value="web"><VaultClientProvider client={client}><div style={{ height: "100dvh" }}><MessageRenderer note={note} readOnly={location.search.includes("readonly")} /></div></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);

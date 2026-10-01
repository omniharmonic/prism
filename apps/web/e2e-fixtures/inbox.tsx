import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveActionsProvider, PlatformProvider, VaultClientProvider, useUIStore, type Note, type VaultClient } from "@prism/core";
import type { LiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import Inbox from "../../../packages/core/src/components/comms/VaultMessagesDashboard";

const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown> = {}): Note => ({ id, path, tags, metadata, content: "A saved conversation excerpt.", createdAt: "2026-10-01", updatedAt: "2026-10-01" });
const notes = [
  note("direct", "Messages/Direct discussion", ["message-thread", "email", "urgent", "handled"], { platform: "telegram", matrixRoomId: "!direct:example.test", lastMessageAt: Date.now() }),
  note("group", "Messages/Planning group", ["message-thread", "low", "triaged"], { platform: "telegram", matrixRoomId: "!group:example.test", lastMessageAt: Date.now() - 1000 }),
  note("reviewed", "Messages/Reviewed discussion", ["message-thread", "triaged"]),
  note("social", "Messages/Social discussion", ["message-thread", "social"]),
  note("morgan", "People/Morgan", ["person"], { name: "Morgan", channels: { telegram: "@not-a-room:example.test" } }),
];
const controls = { denyThreads: location.search.includes("failed"), sends: [] as Array<{ room: string; body: string; key?: string }> };
Object.assign(window, { prismInboxFixture: controls, prismInboxUI: useUIStore });
const vault = {
  listNotes: async (filters: Parameters<VaultClient["listNotes"]>[0]) => { if (filters?.tag === "message-thread" && controls.denyThreads) throw new Error("Fixture unavailable"); return notes.filter((note) => !filters?.tag || note.tags?.includes(filters.tag)); },
  getGraph: async () => ({ nodes: [], edges: [{ source: "morgan", target: "direct", relationship: "messages-with" }, { source: "direct", target: "morgan", relationship: "email-from" }, { source: "morgan", target: "group", relationship: "messages-with" }] }),
} as unknown as VaultClient;
const client = {
  scope: () => JSON.stringify(["https://fixture.example.test/api", "workspace", "vault", "owner@example.test"]),
  status: async () => ({ matrix: { enabled: !location.search.includes("unavailable"), configured: true, agentRooms: 0 }, email: { enabled: false, configured: false }, calendar: { enabled: false, configured: false } }),
  matrixSend: async (room, body, options) => { controls.sends.push({ room, body, key: options?.idempotencyKey }); return { roomId: room, eventId: "accepted" }; },
} as LiveActionsClient;
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={query}><PlatformProvider value="web"><VaultClientProvider client={vault}><LiveActionsProvider client={client}><div style={{ height: "100dvh" }}><Inbox note={note("inbox", "Inbox", [])} /></div></LiveActionsProvider></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);

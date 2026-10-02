import { identityPeople, identityEmail, identityEdges } from "./inbox-people-data";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  LiveActionsProvider,
  PlatformProvider,
  VaultClientProvider,
  useUIStore,
  useAgentChatStore,
  type Note,
  type VaultClient,
} from "@prism/core";
import type { LiveActionsClient } from "../../../packages/core/src/lib/actions/client";
import Inbox from "../../../packages/core/src/components/comms/VaultMessagesDashboard";

const note = (
  id: string,
  path: string,
  tags: string[],
  metadata: Record<string, unknown> = {},
): Note => ({
  id,
  path,
  tags,
  metadata,
  content: "A saved conversation excerpt.",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
});
const notes = [
  note(
    "direct",
    "Messages/Direct discussion",
    ["message-thread", "email", "urgent", "handled"],
    {
      platform: "telegram",
      matrixRoomId: "!direct:example.test",
      lastMessageAt: Date.now(),
    },
  ),
  note(
    "group",
    "Messages/Planning group",
    ["message-thread", "low", "triaged"],
    {
      platform: "telegram",
      matrixRoomId: "!group:example.test",
      lastMessageAt: Date.now() - 1000,
    },
  ),
  note("reviewed", "Messages/Reviewed discussion", [
    "message-thread",
    "triaged",
  ]),
  note("social", "Messages/Social discussion", ["message-thread", "social"]),
  note("morgan", "People/Morgan", ["person"], {
    name: "Morgan",
    channels: { telegram: "@not-a-room:example.test" },
  }),
];
if (location.search.includes("identity")) notes.push(...identityPeople, identityEmail);
if (location.search.includes("visual")) {
  notes[1].path = "Messages/Workshop planning";
  notes[1].content = "";
  notes[1].tags = ["message-thread", "action-required"];
  notes[0].path = "Messages/Rowan Ellis";
  notes[0].tags = ["message-thread", "informational"];
  notes[2].path = "Messages/Project notes";
  notes[2].tags = ["message-thread", "informational"];
}
if (location.search.includes("long"))
  notes[1].path +=
    " — collaborative planning with an exceptionally long conversation title that remains readable on a narrow phone";
if (location.search.includes("limited"))
  for (let index = 0; index < 500; index++)
    notes.push(
      note(`older-${index}`, `Messages/Older ${index}`, [
        "message-thread",
        "low",
      ]),
    );
let audience = "owner@example.test";
const fixtureScope = () =>
  JSON.stringify([
    "https://fixture.example.test/api",
    "workspace",
    "vault",
    audience,
  ]);
useAgentChatStore.getState().bindScope(fixtureScope());
const controls = {
  denyDetail: false,
  denyPeople: false,
  switchScope: () => {
    audience = "other@example.test";
    useAgentChatStore.getState().bindScope(fixtureScope());
  },
  denyThreads: location.search.includes("failed"),
  sends: [] as Array<{ room: string; body: string; key?: string }>,
};
Object.assign(window, {
  prismInboxFixture: controls,
  prismInboxUI: useUIStore,
});
const vault = {
  scope: fixtureScope,
  getNote: async (id: string) => {
    if (controls.denyDetail || audience !== "owner@example.test")
      throw Error("Fixture inaccessible");
    return structuredClone(notes.find((note) => note.id === id)!);
  },
  getThreadMessages: async () => ({
    messages: [
      {
        event_id: "outgoing",
        sender: "@owner:example.test",
        sender_name: "Owner",
        body: "I’ll add a section for next steps.",
        timestamp: 1790937720000,
        is_outgoing: true,
        msg_type: "m.text",
        media_url: null,
        media_info: null,
      },
      {
        event_id: "incoming-2",
        sender: "@rowan:example.test",
        sender_name: "Rowan Ellis",
        body: "I can lead the opening discussion.",
        timestamp: 1790937660000,
        is_outgoing: false,
        msg_type: "m.text",
        media_url: null,
        media_info: null,
      },
      {
        event_id: "incoming-1",
        sender: "@mira:example.test",
        sender_name: "Mira Chen",
        body: "I added the agenda for Saturday.\nPlease add any questions before Friday.",
        timestamp: 1790937600000,
        is_outgoing: false,
        msg_type: "m.text",
        media_url: null,
        media_info: null,
      },
    ],
    has_more: false,
  }),
  listNotes: async (filters: Parameters<VaultClient["listNotes"]>[0]) => {
    if (filters?.tag === "person" && controls.denyPeople) throw new Error("People unavailable");
    if (filters?.tag === "message-thread" && controls.denyThreads)
      throw new Error("Fixture unavailable");
    return (audience === "owner@example.test" ? notes : [])
      .filter((note) => !filters?.tag || note.tags?.includes(filters.tag))
      .slice(0, filters?.limit);
  },
  getGraph: async () => ({
    nodes: [],
    edges: [
      ...(location.search.includes("identity") ? identityEdges : []),
      { source: "morgan", target: "direct", relationship: "messages-with" },
      { source: "direct", target: "morgan", relationship: "email-from" },
      { source: "morgan", target: "group", relationship: "messages-with" },
    ],
  }),
} as unknown as VaultClient;
const client = {
  scope: fixtureScope,
  status: async () => ({
    matrix: {
      enabled: !location.search.includes("unavailable"),
      configured: true,
      agentRooms: 0,
    },
    email: { enabled: false, configured: false },
    calendar: { enabled: false, configured: false },
  }),
  matrixSend: async (room, body, options) => {
    controls.sends.push({ room, body, key: options?.idempotencyKey });
    return { roomId: room, eventId: "accepted" };
  },
} as LiveActionsClient;
const query = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
Object.assign(window, { prismInboxQuery: query });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={query}>
      <PlatformProvider value="web">
        <VaultClientProvider client={vault}>
          <LiveActionsProvider client={client}>
            <div style={{ height: "100dvh" }}>
              <Inbox note={note("inbox", "Inbox", [])} />
            </div>
          </LiveActionsProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

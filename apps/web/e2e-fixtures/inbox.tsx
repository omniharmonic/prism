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
// `?resolved`: the shell has the server's read-time people resolution (Messages → People).
// NO graph link exists in this mode — like the production vault. The fake answers the two
// routes the way the server does: by the address / handle on the person, never by a name.
const resolved = location.search.includes("resolved");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12, 0);
const resolvedPeople = [
  { id: "mira", name: "Mira Chen", keys: ["mira@example.test", "@telegram_11:example.test"] },
  { id: "rowan", name: "Rowan Ellis", keys: ["@signal_22:example.test"] },
  { id: "river", name: "River Stone", keys: [] as string[] },
  { id: "sam", name: "Sam Okafor", keys: ["sam@example.test"] },
];
const resolvedItems = [
  { id: "group", kind: "chat", platform: "telegram", title: "Workshop planning", at: NOW, keys: ["@telegram_11:example.test", "@signal_22:example.test"], members: 3 },
  { id: "mail-agenda", kind: "email", platform: "email", title: "Saturday workshop agenda", at: NOW - 1_800_000, keys: ["mira@example.test"], unread: true },
  { id: "direct", kind: "chat", platform: "signal", title: "Rowan Ellis", at: NOW - DAY, keys: ["@signal_22:example.test"] },
  { id: "meet-review", kind: "meeting", platform: "meeting", title: "Budget review", at: NOW - 6 * DAY, keys: ["mira@example.test"] },
  // Names River in its participants only — a display name associates nobody.
  { id: "social", kind: "chat", platform: "whatsapp", title: "River Stone", at: NOW, keys: [] as string[] },
] as const;
if (resolved) {
  notes.length = 0;
  notes.push(
    note("group", "Messages/Workshop planning", ["message-thread", "action-required"], { platform: "telegram", matrixRoomId: "!group:example.test", lastMessageAt: NOW, participants: ["Mira Chen", "Rowan Ellis", "You"] }),
    note("direct", "Messages/Rowan Ellis", ["message-thread", "informational"], { platform: "signal", matrixRoomId: "!direct:example.test", lastMessageAt: NOW - DAY, participants: ["Rowan Ellis"] }),
    note("social", "Messages/River Stone", ["message-thread", "social"], { platform: "whatsapp", lastMessageAt: NOW, participants: ["River Stone"] }),
    { ...note("mail-agenda", "Email/Saturday workshop agenda", ["email", "action-required"], { type: "email", subject: "Saturday workshop agenda", from: "Mira Chen <mira@example.test>", to: "owner@example.test", isUnread: true, lastMessageAt: NOW - 1_800_000, source: "proton-bridge", messageId: "agenda@example.test" }), content: "# Saturday workshop agenda\n\n**From:** Mira Chen <mira@example.test>\n**To:** owner@example.test\n**Date:** 2026-10-06 14:42\n\n---\n\nI’ve attached the updated agenda. Could you confirm which section you’ll facilitate?" },
  );
  notes[0].content = "# Workshop planning\n\n[2026-10-06 12:00] Mira Chen: I added the agenda for Saturday.";
  notes[1].content = "# Rowan Ellis\n\n[2026-10-05 09:18] Rowan Ellis: Thanks, see you then.";
  notes[2].content = "# River Stone\n\n[2026-10-06 12:00] River Stone: Great, see you then.";
}
// `?triage`: every classification state, mixed `lastMessageAt` shapes (epoch ms and ISO), and a
// fake that records each tag write. `&legacy`: a shell without `changeTags` (add, then remove).
const triage = location.search.includes("triage");
if (triage) {
  const T = Date.UTC(2026, 9, 6, 12, 0);
  notes.length = 0;
  notes.push(
    note("t-urgent", "Messages/Grant deadline", ["message-thread", "urgent", "triaged"], { platform: "telegram", matrixRoomId: "!u:example.test", lastMessageAt: T }),
    note("t-action", "Messages/Budget question", ["message-thread", "action-required", "triaged"], { platform: "signal", matrixRoomId: "!a:example.test", lastMessageAt: new Date(T - 3_600_000).toISOString() }),
    note("t-failed", "Messages/Garbled thread", ["message-thread", "triage-failed"], { platform: "telegram", matrixRoomId: "!f:example.test", lastMessageAt: T - 7_200_000 }),
    note("t-needs", "Messages/New chat", ["message-thread", "needs-triage"], { platform: "whatsapp", lastMessageAt: T - 10_800_000 }),
    note("t-plain", "Messages/Plain chat", ["message-thread"], { platform: "telegram", lastMessageAt: T - 14_400_000 }),
    note("t-info", "Messages/Newsletter", ["message-thread", "informational", "triaged"], { platform: "telegram", lastMessageAt: T - 18_000_000 }),
    note("t-low", "Messages/Promo", ["message-thread", "low", "triaged"], { platform: "telegram", lastMessageAt: T - 21_600_000 }),
    note("t-done", "Messages/Done thing", ["message-thread", "handled"], { platform: "telegram", lastMessageAt: T - 25_200_000 }),
  );
}
const itemsFor = (keys: readonly string[]) => resolvedItems.filter((item) => item.keys.some((key) => keys.includes(key)));
const wireItem = ({ keys: _keys, ...item }: (typeof resolvedItems)[number]) => item;
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
  peopleReads: 0,
  graphReads: 0,
  tagWrites: [] as Array<{ id: string; op: string; add: string[]; remove: string[]; member?: boolean }>,
  failTagWrites: false,
  /** Ingest / another device changed a note's tags on the "server". */
  setTags: (id: string, tags: string[]) => {
    const target = notes.find((n) => n.id === id);
    if (target) target.tags = tags;
  },
};
const applyTags = (id: string, add: string[], remove: string[]) => {
  const target = notes.find((n) => n.id === id)!;
  target.tags = [...(target.tags ?? []).filter((t) => !remove.includes(t)), ...add.filter((t) => !(target.tags ?? []).includes(t))];
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
    const found = structuredClone(notes.find((note) => note.id === id)!);
    // A member's read through the gateway carries `_caps` (the status write then speaks add_tags/remove_tags).
    if (triage && id === "t-needs") found._caps = ["view", "comment", "suggest", "edit"];
    return found;
  },
  ...(triage && !location.search.includes("legacy")
    ? {
        changeTags: async (id: string, change: { add: string[]; remove: string[] }, options?: { member?: boolean }) => {
          controls.tagWrites.push({ id, op: "change", ...change, member: options?.member });
          if (controls.failTagWrites) throw new Error("Fixture refused");
          applyTags(id, change.add, change.remove);
        },
      }
    : {}),
  addTags: async (id: string, tags: string[]) => {
    controls.tagWrites.push({ id, op: "add", add: tags, remove: [] });
    if (controls.failTagWrites) throw new Error("Fixture refused");
    applyTags(id, tags, []);
  },
  removeTags: async (id: string, tags: string[]) => {
    controls.tagWrites.push({ id, op: "remove", add: [], remove: tags });
    if (controls.failTagWrites) throw new Error("Fixture refused");
    applyTags(id, [], tags);
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
      .slice(0, filters?.limit)
      .map((note) => structuredClone(note)); // a read is a copy: later "server" edits must not leak into the cache
  },
  ...(resolved
    ? {
        listPeopleConversations: async (query = "") => {
          controls.peopleReads++;
          if (controls.denyPeople || audience !== "owner@example.test") throw new Error("People unavailable");
          const q = query.trim().toLowerCase();
          const rows = resolvedPeople.map((p) => {
            const items = itemsFor(p.keys);
            return { id: p.id, name: p.name, platforms: [...new Set(items.map((i) => i.platform))], lastMessageAt: Math.max(0, ...items.map((i) => i.at)), count: items.length, unread: items.filter((i) => "unread" in i && i.unread).length, hasIdentity: p.keys.length > 0 };
          });
          const shown = rows.filter((r) => (r.count > 0 || q) && (!q || r.name.toLowerCase().includes(q))).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
          return { people: shown, total: rows.filter((r) => r.count > 0).length, withoutIdentity: rows.filter((r) => !r.count && !r.hasIdentity).length };
        },
        getPersonConversations: async (id: string) => {
          const p = resolvedPeople.find((x) => x.id === id);
          if (!p || audience !== "owner@example.test") throw new Error("not_found");
          const items = itemsFor(p.keys).slice().sort((a, b) => b.at - a.at);
          return { person: { id: p.id, name: p.name, hasIdentity: p.keys.length > 0, identityKinds: [], count: items.length, platforms: [...new Set(items.map((i) => i.platform))] }, items: items.map(wireItem), next: null };
        },
      }
    : {}),
  getGraph: async () => ({
    nodes: [],
    edges: resolved ? (controls.graphReads++, []) : [
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

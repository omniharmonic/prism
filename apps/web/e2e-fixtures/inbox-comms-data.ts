// Messages over Comms (D19 stage 1–2) — a fake `VaultClient.comms` for inbox.html?comms.
// Synthetic people and text only. The fake answers like the server: owner-only listing with
// folder / status / attention / network / unread / person / note / q filters and keyset pages,
// status counts per folder, thread detail, oldest-first message pages, the person page.
import type { CommsMessage, CommsPerson, CommsReadClient, CommsThread, CommsThreadQuery } from "@prism/core/shell";

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const swatch = (fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="${fill}"/><circle cx="20" cy="18" r="7" fill="#fff8"/><path d="M0 48 L24 26 L40 38 L52 30 L64 40 L64 48Z" fill="#0003"/></svg>`)}`;
const MEDIA: Record<string, string> = { "tok-photo": swatch("#7ea6c9"), "tok-photo-thumb": swatch("#7ea6c9"), "tok-og": swatch("#c9a77e"), "tok-mira": swatch("#a88bc9") };

const caps = { react: true, reply: true, attachments: true, send: false };
const thread = (t: Partial<CommsThread> & Pick<CommsThread, "id" | "title">): CommsThread => ({
  titleSource: "person", avatar: { monogram: t.title.split(" ").map((w) => w[0]).join("").slice(0, 2) }, kind: "dm", networks: ["telegram"],
  lastActivityAt: iso(NOW), unread: { count: 0, trusted: false }, folder: "inbox", status: "unclassified", pinned: false, muted: false,
  channels: [{ network: t.networks?.[0] ?? "telegram", accountLabel: null, capabilities: caps }], ...t,
});

export const commsThreads: CommsThread[] = [
  thread({ id: "th_group", title: "Workshop planning", kind: "group", noteId: "group", status: "action-required", avatar: { monogram: "WP", members: [{ token: "tok-mira" }] },
    lastMessage: { text: "Mira: Here is the venue, see the photo", senderName: "Mira Chen", isSelf: false, sentAt: iso(NOW) }, lastActivityAt: iso(NOW), unread: { count: 2, trusted: false }, pinned: true }),
  thread({ id: "th_direct", title: "Rowan Ellis", networks: ["signal"], noteId: "direct", personId: "rowan", status: "informational",
    lastMessage: { text: "Thanks, see you then.", senderName: "Rowan Ellis", isSelf: false, sentAt: iso(NOW - 24 * 60 * MIN) }, lastActivityAt: iso(NOW - 24 * 60 * MIN) }),
  thread({ id: "th_imsg", title: "Sam Okafor", networks: ["imessage"], personId: "sam", status: "urgent",
    lastMessage: { text: "Can you call me back?", senderName: "Sam Okafor", isSelf: false, sentAt: iso(NOW - 30 * MIN) }, lastActivityAt: iso(NOW - 30 * MIN), unread: { count: 1, trusted: true } }),
  thread({ id: "th_river", title: "River Stone", networks: ["whatsapp"], noteId: "social", status: "social", muted: true,
    lastMessage: { text: "Great, see you then.", senderName: null, isSelf: true, sentAt: iso(NOW - 3 * 24 * 60 * MIN) }, lastActivityAt: iso(NOW - 3 * 24 * 60 * MIN) }),
  thread({ id: "th_promo", title: "Weekly deals", networks: ["telegram"], folder: "low", status: "low", lastActivityAt: iso(NOW - 2 * 60 * MIN),
    lastMessage: { text: "20% off this week", senderName: "Weekly deals", isSelf: false, sentAt: iso(NOW - 2 * 60 * MIN) } }),
  thread({ id: "th_stranger", title: "+1 555 0100", networks: ["whatsapp"], folder: "unknown", titleSource: "handle", lastActivityAt: iso(NOW - 5 * 60 * MIN),
    lastMessage: { text: "Hi, is this the workshop?", senderName: null, isSelf: false, sentAt: iso(NOW - 5 * 60 * MIN) } }),
];

const ME = { id: "@me:example.test", name: "You", avatar: null, isSelf: true, isOmni: false };
const MIRA = { id: "@telegram_11:example.test", name: "Mira Chen", avatar: { token: "tok-mira" }, isSelf: false, isOmni: false, personId: "mira" };
const ROWAN = { id: "@signal_22:example.test", name: "Rowan Ellis", avatar: null, isSelf: false, isOmni: false, personId: "rowan" };
const text = (v: string) => ({ spans: [{ t: "text" as const, v }], plain: v, jumboEmoji: false, truncated: false });
let n = 0;
const msg = (threadId: string, sender: CommsMessage["sender"], at: number, over: Partial<CommsMessage> = {}): CommsMessage => {
  const id = `$${threadId}-${++n}`;
  return {
    id, threadId, channel: { network: "telegram", accountLabel: null }, source: { network: "telegram", eventId: id, ref: id }, sender, sentAt: iso(at),
    body: null, attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false, ...over,
  };
};
const D1 = NOW - 24 * 60 * MIN;
export const commsMessages: Record<string, CommsMessage[]> = {
  th_group: [
    msg("th_group", MIRA, D1 - 3 * 60 * MIN, { system: { kind: "member", text: "Mira Chen joined" } }),
    msg("th_group", MIRA, D1, { body: text("I added the agenda for Saturday.") }),
    msg("th_group", MIRA, D1 + 2 * MIN, { body: text("Please add any questions before Friday."), reactions: [{ key: "👍", count: 2, mine: true, senders: [{ id: ME.id, name: "You" }, { id: ROWAN.id, name: "Rowan Ellis" }] }] }),
    msg("th_group", ROWAN, D1 + 5 * MIN, { body: text("I can lead the opening discussion.") }),
    msg("th_group", ME, D1 + 9 * MIN, { body: text("I’ll add a section for next steps."), delivery: "read" }),
    msg("th_group", ME, D1 + 10 * MIN, { body: { spans: [{ t: "text", v: "Draft is here: " }, { t: "link", href: "https://example.org/agenda", c: [{ t: "text", v: "example.org/agenda" }] }], plain: "Draft is here: example.org/agenda", jumboEmoji: false, truncated: false },
      linkPreviews: [{ url: "https://example.org/agenda", title: "Saturday workshop agenda", description: "Opening, three working sessions and a shared lunch.", siteName: "example.org", imageToken: "tok-og" }], delivery: "read" }),
    // 75 minutes later: a new run with a time header, same sender
    msg("th_group", ME, D1 + 85 * MIN, { body: text("Booked the room until 5."), delivery: "delivered" }),
    msg("th_group", MIRA, NOW - 20 * MIN, { replyTo: { messageId: "$th_group-6", snippet: "Booked the room until 5.", senderName: "You" }, body: text("Perfect. Here is the venue:") }),
    msg("th_group", MIRA, NOW - 19 * MIN, { attachments: [{ kind: "image", mediaToken: "tok-photo", thumbToken: "tok-photo-thumb", w: 640, h: 480, name: "venue.jpg", mime: "image/jpeg" }] }),
    msg("th_group", MIRA, NOW - 18 * MIN, { attachments: [{ kind: "voice", mediaToken: "tok-voice", durationMs: 14_000, mime: "audio/ogg" }] }),
    msg("th_group", ROWAN, NOW - 2 * MIN, { body: { spans: [{ t: "text", v: "🎉" }], plain: "🎉", jumboEmoji: true, truncated: false } }),
  ],
  th_direct: [
    msg("th_direct", ROWAN, D1 - 30 * MIN, { body: text("Are we still on for Saturday?") }),
    msg("th_direct", ME, D1 - 20 * MIN, { body: text("Yes — 10am at the hall."), delivery: "read" }),
    msg("th_direct", ROWAN, D1, { body: text("Thanks, see you then.") }),
    msg("th_direct", ROWAN, D1 + MIN, { attachments: [{ kind: "video", mediaToken: "tok-video", thumbToken: "tok-photo-thumb", w: 640, h: 360, name: "hall.mp4", mime: "video/mp4", durationMs: 9_000 }] }),
  ],
  th_imsg: [msg("th_imsg", { id: "+15550100", name: "Sam Okafor", avatar: null, isSelf: false, isOmni: false, personId: "sam" }, NOW - 30 * MIN, { body: text("Can you call me back?") })],
  th_river: [msg("th_river", ME, NOW - 3 * 24 * 60 * MIN, { body: text("Great, see you then.") })],
};

export const commsPeople: Record<string, CommsPerson> = {
  rowan: { id: "rowan", name: "Rowan Ellis", noteId: "rowan", phones: [{ label: "Signal", value: "+15550002222" }], emails: [], handles: [{ network: "signal", value: "+15550002222", kind: "phone" }],
    threads: [commsThreads[1]!, commsThreads[0]!] },
  sam: { id: "sam", name: "Sam Okafor", noteId: "sam", phones: [], emails: [{ value: "sam@example.test" }], handles: [], threads: [commsThreads[2]!] },
  mira: { id: "mira", name: "Mira Chen", noteId: "mira", avatar: { token: "tok-mira" }, phones: [], emails: [{ value: "mira@example.test" }], handles: [{ network: "telegram", value: "@mira", kind: "username" }], threads: [commsThreads[0]!] },
};

// A negative status stands for "no answer" (offline): an error with no HTTP status, like fetch's TypeError.
const err = (status: number) => (status < 0 ? new TypeError("Failed to fetch") : Object.assign(new Error(`comms ${status}`), { status }));
export const commsControls = {
  refuse: 0 as number, listReads: 0, queries: [] as CommsThreadQuery[],
  /** Every message read: thread id + the `before` cursor (undefined = the newest page). */
  messageReads: [] as Array<{ id: string; before?: string }>,
  /** Media loads through `loadMedia` (the native shell's bearer fetch). */
  mediaLoads: [] as string[],
  /** Only the note lookup (`note=`) fails with this status (0 = answers). */
  refuseNoteLookup: 0 as number,
};

export function fakeComms(isOwner: () => boolean, opts: { nativeMedia?: boolean } = {}): CommsReadClient {
  const guard = () => {
    if (commsControls.refuse) throw err(commsControls.refuse);
    if (!isOwner()) throw err(403);
  };
  return {
    listThreads: async (q) => {
      guard();
      if (q.note && commsControls.refuseNoteLookup) throw err(commsControls.refuseNoteLookup);
      commsControls.listReads++;
      commsControls.queries.push(q);
      const statuses = new Set([...(q.statuses ?? []), ...(q.attention ? ["urgent", "action-required"] : [])]);
      const person = q.person ? commsPeople[q.person] : null;
      let rows = commsThreads.filter((t) =>
        (q.note ? t.noteId === q.note : true) &&
        (q.folder ? t.folder === q.folder : q.person || q.note ? true : t.folder === "inbox") &&
        (!statuses.size || statuses.has(t.status)) &&
        (!q.networks?.length || t.networks.some((n) => q.networks!.includes(n))) &&
        (!q.unread || t.unread.count > 0) &&
        (!person || person.threads.some((p) => p.id === t.id)) &&
        (!q.q || t.title.toLowerCase().includes(q.q.toLowerCase())));
      rows = rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt.localeCompare(a.lastActivityAt));
      const start = q.cursor ? Number(q.cursor) : 0;
      const limit = q.limit ?? 50;
      const page = rows.slice(start, start + limit);
      return { threads: structuredClone(page), next: start + limit < rows.length ? String(start + limit) : null };
    },
    statusCounts: async (folder) => {
      guard();
      const counts: Record<string, number> = {};
      for (const t of commsThreads.filter((x) => x.folder === folder)) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return { folder, counts, attention: (counts.urgent ?? 0) + (counts["action-required"] ?? 0) };
    },
    getThread: async (id) => {
      guard();
      const t = commsThreads.find((x) => x.id === id);
      if (!t) throw err(404);
      return { thread: structuredClone(t), capabilities: caps, members: [] };
    },
    getMessages: async (id, before) => {
      guard();
      commsControls.messageReads.push({ id, before });
      const all = commsMessages[id] ?? [];
      // Two pages for the group so "Load earlier messages" is exercised: newest 8, then the rest.
      const cut = id === "th_group" ? Math.max(0, all.length - 8) : 0;
      return before === "older"
        ? { messages: structuredClone(all.slice(0, cut)), before: null, hasMore: false }
        : { messages: structuredClone(all.slice(cut)), before: cut ? "older" : null, hasMore: cut > 0 };
    },
    getPerson: async (id) => {
      guard();
      const p = commsPeople[id];
      if (!p) throw err(404);
      return structuredClone(p);
    },
    mediaUrl: (token) => MEDIA[token] ?? `data:audio/ogg;base64,`,
    ...(opts.nativeMedia
      ? { loadMedia: async (token: string) => { commsControls.mediaLoads.push(token); return URL.createObjectURL(new Blob([new Uint8Array(4)], { type: "audio/ogg" })); } }
      : {}),
  };
}

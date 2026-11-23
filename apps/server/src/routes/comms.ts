import { forumTopic, forumTopics, forumTopicsOut, isForumThread, resolveThreadRedirect, threadAndImpliedTopic, withForumReadState } from "../comms/forums";
import { readAllTopics, readTopicTimeline } from "../comms/forum-timeline";
import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config";
import { requireCommsOwner } from "../comms/guard";
import { startRebuild } from "../comms/project-deps";
import { commsMediaRoute } from "../comms/media-route";
import { commsStream } from "../comms/stream";
import { ownerBlockedNetworks, ownerDetectionMode, resetOwnerDetection, storedOwnerSenderRows } from "../comms/owner";
import { resolveActor } from "../auth/actor";
import { loadMatrixCreds } from "../actions/matrix";
import { deleteDeviceApns, getSettings, postDeviceApns, postRead, postTestNotification, postUnread, putSettings } from "./comms-notify";
import { commsOmniApi } from "./comms-omni";
import { deleteReaction, getCapabilities, postAttachment, postConversation, postMessage, postReaction } from "./comms-send";
import { resolveVaultEntry } from "../db";
import type { MatrixCreds } from "../worker/matrix";
import { ATTENTION_STATUSES, getThread, listThreads, statusCounts, unreadSummary, personMemberIds, threadMembers, threadsOfPerson, InvalidCursorError, type Folder } from "../comms/store";
import { isCommsStatus, type CommsStatus } from "../comms/triage";
import { folderExists } from "../comms/folders";
import { contactFor, loadPerson, personAvatar, personName } from "../comms/people";
import { VaultError } from "../parachute";
import { wellFormedDeep } from "../comms/wire";
import type { Network } from "../comms/types";
import { bbThreadSource, readBbMembers, readBbTimeline } from "../bluebubbles/project";
import { blueBubblesBook, blueBubblesReader } from "../bluebubbles/service";
import { bbMemberId } from "../bluebubbles/contacts";
import { searchRecipients } from "../comms/recipients";
import { deletePin, getPins, postPin, putPins } from "./comms-pins";
import {
  getFolders, patchFolder, postArchive, postFolder, postFolderThreads, postFolderThreadsRemove, postMute, postStatus, postStatusUndo,
  putFolderOrder, removeFolder,
} from "./comms-thread-actions";
import { withReadState } from "../comms/receipts";
import { emailReplyPlan, emailThreadSource, readEmailOriginal, readEmailTimeline } from "../comms/email";
import { vaultClient, type Note } from "../parachute";
import { getSearch, getSearchMedia, getTidy, getTidyActions, getTidyThread, tidyWrite } from "./comms-search";
import {
  AccessChangedError, CursorNotFoundError, SourceUnavailableError, commsReaderFor, cursorShapeOk,
  avatarOut, messageOut, readMembers, readTimeline, threadOut, threadSource, type CommsReader,
} from "../comms/timeline";

/** Owner-only Comms API. Each route calls requireCommsOwner (comms/guard.ts). */
export const commsApi = new Hono();

// Flag off: every /api/comms/* path, matched or not, is 404 comms_disabled.
commsApi.use("*", async (c, next) => {
  if (!config.commsEnabled) {
    c.header("Cache-Control", "private, no-store");
    return c.json({ error: "comms_disabled" }, 404);
  }
  await next();
});

// GET /api/comms/media/:token — media + avatar proxy (comms/media-route.ts; owner guard per request).
commsApi.route("/media", commsMediaRoute);

// Owner session only (Task 12 additionally denies the comms-native client). Starts a background rebuild (202), single-flight.
// No Matrix credential on the primary vault (the one the rebuild projects): 409 matrix_unavailable at once.
commsApi.post("/admin/rebuild", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  if (!matrixCreds(resolveVaultEntry(undefined).id)) return c.json({ error: "matrix_unavailable" }, 409);
  const r = startRebuild();
  return c.json(r, 202);
});

// GET /api/comms/admin/owner-ids — the owner's own Matrix ids Comms treats as self, unredacted,
// with their source (detected / override / configured / person) and the detection mode. Owner
// session only; /api/comms/admin is refused to the comms-native client (middleware/client-scope.ts).
commsApi.get("/admin/owner-ids", (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  c.header("Cache-Control", "private, no-store");
  // Per id: source and, for detected ids, the evidence of the last rebuild (portals, share,
  // dmShare, alone) — for the owner / controller to audit. `blocked` = networks where an earlier
  // ghost was dropped and nothing new is adopted until a reset.
  return c.json({ detection: ownerDetectionMode(), ids: storedOwnerSenderRows(), blocked: ownerBlockedNetworks() });
});

// POST /api/comms/admin/owner-ids/reset — forget detected owner ghosts and blocked networks, then
// rebuild (202). Owner session only, refused to comms-native (like /admin/rebuild).
// After a reset, check GET /api/comms/admin/owner-ids once the rebuild has run: detection starts
// over, so what it now finds (or no longer finds) shows only there and in the log.
commsApi.post("/admin/owner-ids/reset", (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const r = resetOwnerDetection();
  console.warn(`[comms] owner ghosts reset by the owner: ${r.removed} detected ids forgotten, ${r.unblocked} networks unblocked`);
  const started = matrixCreds(resolveVaultEntry(undefined).id) ? startRebuild() : { started: false };
  return c.json({ ...r, rebuild: started }, 202);
});

const FOLDERS = new Set<Folder>(["inbox", "unknown", "low", "spam", "archived"]);
const NETWORKS = new Set<Network>(["whatsapp", "telegram", "discord", "messenger", "x", "imessage", "sms", "email", "matrix", "signal", "slack", "instagram", "linkedin"]);
const MAX_THREAD_ID = 200;
const MAX_QUERY_CHARS = 200;

/** limit 1..100, default 50; anything else → null (400 invalid_limit). */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 50;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 100 ? n : null;
}
const badCursor = (raw: string) => raw.length === 0 || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw);

const matrixCreds = loadMatrixCreds;

/**
 * `status` (repeatable and/or comma-separated; any of comms/triage.ts COMMS_STATUSES, OR-ed) and
 * `attention=true|1` (= urgent + action-required, merged into the same set). null = a bad value.
 */
function parseStatuses(raw: string[] | undefined, attention: string | undefined): CommsStatus[] | null {
  const list = (raw ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (list.length > 20 || list.some((s) => !isCommsStatus(s))) return null;
  const out = new Set(list as CommsStatus[]);
  if (attention === "1" || attention === "true") for (const s of ATTENTION_STATUSES) out.add(s);
  return [...out];
}

// GET /api/comms/threads?folder&unread&network&q&status&attention&person&note&cursor&limit → {threads, next}
// `note=<vault note id>`: the conversation projected from that message-thread note (Prism web opens
// a note); like `person`, it spans every folder unless `folder` is given.
// GET /api/comms/threads/status-counts?folder → {folder, counts: {<status>: n}, attention: n,
//   unread: {threads, attention}} — unread threads (not muted); `unread.attention` is the app badge.
commsApi.get("/threads", (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const limit = parseLimit(c.req.query("limit"));
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const person = c.req.query("person");
  if (person !== undefined && (!person || person.length > MAX_THREAD_ID)) return c.json({ error: "invalid_person" }, 400);
  const note = c.req.query("note");
  if (note !== undefined && (!note || note.length > MAX_THREAD_ID)) return c.json({ error: "invalid_note" }, 400);
  // An owner folder (sprint Task 9): only with COMMS_FOLDERS_ENABLED; an unknown one is 404.
  const inFolder = c.req.query("inFolder");
  if (inFolder !== undefined) {
    if (!config.commsFoldersEnabled) return c.json({ error: "folders_disabled" }, 404);
    if (!inFolder || inFolder.length > MAX_THREAD_ID || !folderExists(inFolder)) return c.json({ error: "folder_unavailable" }, 404);
  }
  // A person's (or a note's, or an owner folder's) chats span every folder unless one is asked for; otherwise the inbox is the default.
  const folderRaw = c.req.query("folder");
  const folder = (folderRaw ?? (person || note || inFolder ? undefined : "inbox")) as Folder | undefined;
  if (folder !== undefined && !FOLDERS.has(folder)) return c.json({ error: "invalid_folder" }, 400);
  const statuses = parseStatuses(c.req.queries("status"), c.req.query("attention"));
  if (statuses === null) return c.json({ error: "invalid_status" }, 400);
  const networks = (c.req.queries("network") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (networks.length > 20 || networks.some((n) => !NETWORKS.has(n as Network))) return c.json({ error: "invalid_network" }, 400);
  const unreadRaw = c.req.query("unread");
  const unread = unreadRaw === "1" || unreadRaw === "true";
  const q = c.req.query("q")?.trim().slice(0, MAX_QUERY_CHARS) || undefined;
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && badCursor(cursor)) return c.json({ error: "invalid_cursor" }, 400);
  try {
    const r = listThreads({ folder, unread, networks: networks as Network[], q, cursor: cursor || undefined, limit, ...(statuses.length ? { statuses } : {}), ...(person ? { personId: person } : {}), ...(note ? { noteId: note } : {}), ...(inFolder ? { inFolder } : {}) });
    return c.json({ threads: r.threads.map((t) => threadOut(t, g.actor)), next: r.next });
  } catch (e) {
    if (e instanceof InvalidCursorError) return c.json({ error: "invalid_cursor" }, 400);
    throw e;
  }
});

commsApi.get("/threads/status-counts", (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const folder = (c.req.query("folder") ?? "inbox") as Folder;
  if (!FOLDERS.has(folder)) return c.json({ error: "invalid_folder" }, 400);
  const counts = statusCounts(folder);
  return c.json({ folder, counts, attention: ATTENTION_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0), unread: unreadSummary(folder) });
});

// GET /api/comms/threads/:id → {thread, capabilities, members, contact?}
// members: live room members, each with personId when the people index maps them to a person note.
// contact: DMs only — the counterpart's phones / emails / handles (person note + bridge ghosts).
commsApi.get("/threads/:id", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  const thread = id.length <= MAX_THREAD_ID ? getThread(id) : null;
  if (!thread) return c.json({ error: "thread_unavailable" }, 404);
  const em = emailThreadSource(id);
  if (em) {
    // Email: members from the projection (mailto: ids), the reply the composer would send.
    const known = threadMembers(id);
    let contact: ReturnType<typeof contactFor> | undefined;
    if (thread.kind === "dm") {
      const note = thread.personId ? await loadPerson(g.vaultId, thread.personId).catch(() => null) : null;
      contact = contactFor(note, known.map((m) => m.memberId));
    }
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    const out = threadOut(thread, g.actor);
    const plan = emailReplyPlan(em);
    return c.json(wellFormedDeep({
      thread: out, capabilities: out.channels[0]?.capabilities ?? null,
      members: known.map((m) => ({ id: m.memberId, name: m.memberId.replace(/^mailto:/, ""), avatar: null, ...(m.personId ? { personId: m.personId } : {}) })),
      ...(contact ? { contact } : {}),
      email: { account: em.account, reply: plan.ok ? plan.plan.reply : null, replyAll: plan.ok ? plan.plan.replyAll : null, ...(plan.ok ? {} : { replyUnavailable: plan.reason }) },
    }));
  }
  const bb = bbThreadSource(id);
  if (bb) {
    // iMessage / SMS (BlueBubbles): members from the local BlueBubbles Server.
    const reader = blueBubblesReader();
    const members = reader ? await readBbMembers(bb.chatGuid, reader, await blueBubblesBook()).catch(() => []) : [];
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    // People (review I4): member person ids, and for a DM the contact (person note + the handle).
    const known = threadMembers(id);
    const people = new Map(known.map((m) => [m.memberId, m.personId]));
    let contact: ReturnType<typeof contactFor> | undefined;
    if (thread.kind === "dm") {
      const note = thread.personId
        ? await loadPerson(g.vaultId, thread.personId).catch((e) => {
            console.warn(`[comms] contact: person read failed: ${e instanceof VaultError ? `vault_${e.status}` : e instanceof Error ? e.name : "error"}`);
            return null;
          })
        : null;
      contact = contactFor(note, known.map((m) => m.memberId));
    }
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    const out = threadOut(thread, g.actor);
    return c.json({
      thread: out, capabilities: out.channels[0]?.capabilities ?? null,
      members: wellFormedDeep(members.map((m) => {
        const personId = people.get(bbMemberId(m.id).toLowerCase());
        return { ...m, avatar: avatarOut(m.avatar, g.actor), ...(personId ? { personId } : {}) };
      })),
      ...(contact ? { contact } : {}),
    });
  }
  // A Telegram forum (comms/forums.ts): its topics, and the members of the newest one.
  const topics = forumTopics(id);
  const src = topics.length ? { roomId: topics[0]!.roomId, network: topics[0]!.network } : threadSource(id);
  const creds = matrixCreds(g.vaultId);
  const live = src && creds ? await readMembers(commsReaderFor(creds), src.roomId, g.actor) : [];
  if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
  const known = threadMembers(id);
  const people = new Map(known.map((m) => [m.memberId, m.personId]));
  const members = live.map((m) => {
    const personId = people.get(m.id.toLowerCase());
    return personId ? { ...m, personId } : m;
  });
  let contact: ReturnType<typeof contactFor> | undefined;
  if (thread.kind === "dm") {
    // One lean person-note read (a person note is optional: ghosts alone still give a phone).
    const note = thread.personId
      ? await loadPerson(g.vaultId, thread.personId).catch((e) => {
          console.warn(`[comms] contact: person read failed: ${e instanceof VaultError ? `vault_${e.status}` : e instanceof Error ? e.name : "error"}`);
          return null;
        })
      : null;
    contact = contactFor(note, known.map((m) => m.memberId));
  }
  const out = threadOut(thread, g.actor);
  return c.json({
    thread: out, capabilities: out.channels[0]?.capabilities ?? null, members, ...(contact ? { contact } : {}),
    ...(topics.length ? { topics: wellFormedDeep(forumTopicsOut(id, topics)) } : {}),
  });
});

// GET /api/comms/people/:personId → {id, name, avatar?, noteId, phones, emails, handles, threads}
// threads = every projected conversation with the person (DMs on every network + groups they are
// in), newest activity first, at most 200. 404 person_unavailable when no such person note.
commsApi.get("/people/:personId", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const personId = c.req.param("personId");
  if (!personId || personId.length > MAX_THREAD_ID) return c.json({ error: "person_unavailable" }, 404);
  let note;
  try {
    note = await loadPerson(g.vaultId, personId);
  } catch (e) {
    // Content-free: the error class (and a vault status) only — never the id or any contact value.
    console.warn(`[comms] person read failed: ${e instanceof VaultError ? `vault_${e.status}` : e instanceof Error ? e.name : "error"}`);
    return c.json({ error: "source_unavailable" }, 503);
  }
  // A merged / superseded note is a tombstone, not a person page.
  if (!note) return c.json({ error: "person_unavailable" }, 404);
  const md = (note.metadata ?? {}) as Record<string, unknown>;
  if (md.merged_into || md.mergedInto || md.superseded_by) return c.json({ error: "person_unavailable" }, 404);
  // The vault resolves a path as well as an id: every lookup below uses the note's own id.
  const threads = threadsOfPerson(note.id);
  const dmGhosts = personMemberIds(note.id);
  const avatar = avatarOut(personAvatar(note), g.actor);
  if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
  return c.json(wellFormedDeep({
    id: note.id, name: personName(note), ...(avatar ? { avatar } : {}), noteId: note.id,
    ...contactFor(note, dmGhosts),
    threads: threads.map((t) => threadOut(t, g.actor)),
  }));
});

function sameActor(c: Context, a: { email: string; vaultId: string; deviceId?: string }): boolean {
  const now = resolveActor(c);
  return now.kind === "user" && now.email === a.email && now.vaultId === a.vaultId && now.deviceId === a.deviceId;
}

// GET /api/comms/threads/:id/messages?before&limit → {messages (newest last), before, hasMore}
commsApi.get("/threads/:id/messages", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const limit = parseLimit(c.req.query("limit"));
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const before = c.req.query("before");
  if (before !== undefined && !cursorShapeOk(before)) return c.json({ error: "invalid_cursor" }, 400);
  const { threadId: id, impliedTopic } = threadAndImpliedTopic(c.req.param("id") ?? "");
  const thread = id.length <= MAX_THREAD_ID ? getThread(id) : null;
  const em = thread ? emailThreadSource(id) : null;
  if (thread && em) {
    let page;
    try {
      page = await readEmailTimeline({ threadId: id, source: em, limit, ...(before ? { before } : {}), getNote: emailNoteReader(g.vaultId), person: () => null });
    } catch {
      return c.json({ error: "source_unavailable", network: "email" }, 503);
    }
    if (!page) return c.json({ error: "invalid_cursor" }, 400);
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    return c.json({ messages: page.messages.map((m) => messageOut(m, g.actor)), before: page.before, hasMore: page.hasMore });
  }
  const bb = thread ? bbThreadSource(id) : null;
  if (thread && bb) {
    // iMessage / SMS (BlueBubbles): read live from the local server (no window cache).
    const reader = blueBubblesReader();
    if (!reader) return c.json({ error: "source_unavailable", network: bb.network }, 503);
    let page;
    try {
      page = await readBbTimeline({ threadId: id, chatGuid: bb.chatGuid, network: bb.network, limit, ...(before ? { before } : {}), reader, book: await blueBubblesBook() });
    } catch {
      return c.json({ error: "source_unavailable", network: bb.network }, 503);
    }
    if (!page) return c.json({ error: "invalid_cursor" }, 400);
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    return c.json({ messages: page.messages.map((m) => messageOut(m, g.actor)), before: page.before, hasMore: page.hasMore });
  }
  // A Telegram forum (comms/forums.ts): `topic=<id>` = that topic's timeline; none / `all` = every
  // topic merged, each message tagged with its topic.
  if (thread && isForumThread(id)) {
    // An old per-topic id (an older client, a deep link) reads that topic, not All Topics.
    const topicRaw = c.req.query("topic") ?? impliedTopic ?? undefined;
    if (topicRaw !== undefined && (topicRaw.length > 100 || !/^[A-Za-z0-9_-]+$/.test(topicRaw))) return c.json({ error: "invalid_topic" }, 400);
    const one = topicRaw && topicRaw !== "all" ? forumTopic(id, topicRaw) : null;
    if (topicRaw && topicRaw !== "all" && !one) return c.json({ error: "topic_unavailable" }, 404);
    const req = {
      limit, ...(before ? { before } : {}),
      reader: (): CommsReader => {
        const creds = matrixCreds(g.vaultId);
        if (!creds) throw new SourceUnavailableError();
        return commsReaderFor(creds);
      },
      stillAllowed: () => sameActor(c, g.actor),
    };
    try {
      const page = one ? await readTopicTimeline(id, one, req) : await readAllTopics({ threadId: id, ...req });
      if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
      const messages = withForumReadState(page.messages);
      return c.json({ messages: messages.map((m) => messageOut(m, g.actor)), before: page.before, hasMore: page.hasMore });
    } catch (e) {
      if (e instanceof CursorNotFoundError) return c.json({ error: "invalid_cursor" }, 400);
      if (e instanceof AccessChangedError) return c.json({ error: "access_changed" }, 403);
      if (e instanceof SourceUnavailableError) return c.json({ error: "source_unavailable", network: "telegram" }, 503);
      throw e;
    }
  }
  const source = thread ? threadSource(id) : null;
  if (!thread || !source) return c.json({ error: "thread_unavailable" }, 404);
  const network = thread.networks[0] ?? source.network;
  try {
    const page = await readTimeline({
      threadId: id, source, limit, before,
      reader: (): CommsReader => {
        const creds = matrixCreds(g.vaultId);
        if (!creds) throw new SourceUnavailableError();
        return commsReaderFor(creds);
      },
      stillAllowed: () => sameActor(c, g.actor),
    });
    if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
    // Read receipts (Task 8): one SQLite read for the page, no Matrix call.
    const messages = withReadState(page.messages, source.roomId);
    return c.json({ messages: messages.map((m) => messageOut(m, g.actor)), before: page.before, hasMore: page.hasMore });
  } catch (e) {
    if (e instanceof CursorNotFoundError) return c.json({ error: "invalid_cursor" }, 400);
    if (e instanceof AccessChangedError) return c.json({ error: "access_changed" }, 403);
    if (e instanceof SourceUnavailableError) return c.json({ error: "source_unavailable", network }, 503);
    throw e;
  }
});

// GET /api/comms/threads/:id/messages/:messageId/original → {subject, from, to, cc, date, text, html}
// "View full email" (email threads only): the whole stored message; `html` (sanitized, comms/email.ts)
// only when the note holds an HTML part — the clients render it with scripts off and remote loads blocked.
commsApi.get("/threads/:id/messages/:messageId/original", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  const mid = c.req.param("messageId");
  const em = id.length <= MAX_THREAD_ID && getThread(id) ? emailThreadSource(id) : null;
  if (!em || !mid || mid.length > 300) return c.json({ error: "not_found" }, 404);
  let out;
  try {
    out = await readEmailOriginal({ source: em, messageId: mid, getNote: emailNoteReader(g.vaultId) });
  } catch {
    return c.json({ error: "source_unavailable", network: "email" }, 503);
  }
  if (!out) return c.json({ error: "not_found" }, 404);
  if (!sameActor(c, g.actor)) return c.json({ error: "access_changed" }, 403);
  c.header("Cache-Control", "private, no-store");
  return c.json(wellFormedDeep(out));
});

/** Email note bodies (primary vault). A 404 reads as "no note". Injectable for tests. */
let emailNoteReaderImpl: (vaultId: string) => (id: string) => Promise<Note | null> = (vaultId) => async (id) => {
  try {
    return await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return null;
    throw e;
  }
};
const emailNoteReader = (vaultId: string) => emailNoteReaderImpl(vaultId);
export function setEmailNoteReaderForTests(f: ((id: string) => Promise<Note | null>) | null): void {
  emailNoteReaderImpl = f ? () => f : (vaultId) => async (id) => {
    try { return await vaultClient(vaultId, { timeoutMs: 10_000 }).getNote(id); } catch (e) { if (e instanceof VaultError && e.status === 404) return null; throw e; }
  };
}

// GET /api/comms/recipients?q=&limit= — the To: field of a new message (comms/recipients.ts):
// people (person notes + Contacts) with E.164 phones / emails and their existing iMessage/SMS
// threads, the threads matching q (any network, any folder), and q itself when it is an address.
commsApi.get("/recipients", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const q = c.req.query("q")?.trim() ?? "";
  if (!q || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) return c.json({ error: "invalid_query" }, 400);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 8 : /^\d{1,2}$/.test(rawLimit) && Number(rawLimit) >= 1 && Number(rawLimit) <= 20 ? Number(rawLimit) : null;
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const r = await searchRecipients(q, limit);
  return c.json(wellFormedDeep({
    ...r,
    people: r.people.map((p) => ({ ...p, avatar: avatarOut(p.avatar, g.actor) })),
    threads: r.threads.map((t) => threadOut(t, g.actor)),
  }));
});

// Full search + contact tidy-up (Task 4): routes/comms-search.ts.
commsApi.get("/search", getSearch);
commsApi.get("/search/media", getSearchMedia);
commsApi.get("/tidy", getTidy);
commsApi.get("/tidy/actions", getTidyActions);
commsApi.get("/tidy/threads/:id", getTidyThread);
commsApi.post("/tidy/link", tidyWrite("link"));
commsApi.post("/tidy/create", tidyWrite("create"));
commsApi.post("/tidy/ignore", tidyWrite("ignore"));
commsApi.post("/tidy/undo", tidyWrite("undo"));

// Sending (Phase 2a): comms/send.ts documents the gates; routes/comms-send.ts the wire.
commsApi.get("/capabilities", getCapabilities);
// Omni in Comms (Phase 4): /threads/:id/omni, /assist, /catch-up (routes/comms-omni.ts).
commsApi.route("/", commsOmniApi);
commsApi.post("/conversations", postConversation);
commsApi.post("/threads/:id/messages", postMessage);
commsApi.post("/threads/:id/attachments", postAttachment);
commsApi.post("/threads/:id/messages/:messageId/reactions", postReaction);
commsApi.delete("/threads/:id/messages/:messageId/reactions/:key", deleteReaction);

// Read state + notifications (Sprint Task 1): routes/comms-notify.ts documents the wire.
commsApi.post("/threads/:id/read", postRead);
commsApi.post("/threads/:id/unread", postUnread);
commsApi.get("/notifications/settings", getSettings);
commsApi.put("/notifications/settings", putSettings);
commsApi.post("/notifications/test", postTestNotification);
commsApi.post("/devices/apns", postDeviceApns);
commsApi.delete("/devices/apns", deleteDeviceApns);
// Pins (sprint Task 8, routes/comms-pins.ts): the owner's grid order, shared by every device.
commsApi.get("/pins", getPins);
commsApi.put("/pins", putPins);
commsApi.post("/threads/:id/pin", postPin);
commsApi.delete("/threads/:id/pin", deletePin);
// Row actions + owner folders (sprint Task 9, routes/comms-thread-actions.ts).
commsApi.post("/threads/:id/mute", postMute);
commsApi.post("/threads/:id/archive", postArchive);
commsApi.post("/threads/:id/status", postStatus);
commsApi.post("/threads/:id/status/undo", postStatusUndo);
commsApi.get("/folders", getFolders);
commsApi.post("/folders", postFolder);
commsApi.put("/folders/order", putFolderOrder);
commsApi.patch("/folders/:id", patchFolder);
commsApi.delete("/folders/:id", removeFolder);
commsApi.post("/folders/:id/threads", postFolderThreads);
commsApi.post("/folders/:id/threads/remove", postFolderThreadsRemove);

// GET /api/comms/stream — live comms_events as SSE (owner only; Last-Event-ID resume, reset,
// 25 s heartbeat). Frame format and the payload schema of every event: comms/stream.ts header.
commsApi.get("/stream", (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  return commsStream(c, g.actor, () => sameActor(c, g.actor));
});

/**
 * Terminal handler for anything under /api/comms that no route matched, so it
 * can never reach the vault gateway. Mounted in app.ts AFTER commsApi (not
 * inside it), so routes added to commsApi later need no ordering care.
 */
export function commsTerminal(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  return c.json({ error: "not_found" }, 404);
}

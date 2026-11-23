/**
 * BlueBubbles → vault ingester: one `message-thread` note per iMessage/SMS chat, in exactly the
 * Matrix ingest's shape (worker/matrix.ts), so every reader of thread notes (the Prism message
 * renderer, triage, Omni, people links) handles iMessage unchanged:
 *
 *   tags ["message-thread"], path vault/messages/<imessage|sms>/<title slug>[-<chat hash>]
 *   body "# <title> — <platform>\n\n[YYYY-MM-DD HH:MM] Sender: body" (UTC stamps, formatStamp)
 *   metadata { type:"message-thread", platform, title, blueBubblesChatGuid, lastMessageAt,
 *              lastMessage* evidence (lastMessageEvidence, self = isFromMe), messageCount,
 *              participants (names), participantIds (addresses) }
 *
 * Differences from Matrix, on purpose:
 *  - D13: a one-time-code message and every message of a short-code chat NEVER reach the vault
 *    (checked here, before a single byte is written). They still show in Comms (read live).
 *  - Tapbacks, stickers, edits and unsends are not vault lines (the Matrix writer skips
 *    relations too); they live in the Comms projection.
 *  - Dedupe is exact: a message GUID whose vault outcome is final is recorded in
 *    bluebubbles_seen (webhook, polling and backfill may all deliver the same message).
 *  - The backfill runs NEWEST FIRST, so an older batch is MERGED into the note in time order
 *    instead of appended (the header and any rollover pointer are kept verbatim).
 *  - People: existing person notes are linked (`messages-with`) by a strong key (E.164 phone /
 *    email, D3); nobody is created from an iMessage handle.
 */
import { createHash } from "node:crypto";
import { personName as sharedPersonName } from "../person-name";
import type { Note, NoteLinkInput } from "../parachute";
import type { PeopleIndex } from "../worker/people";
import { formatStamp, lastMessageAtOf, lastMessageEvidence, sanitizePath, TRIAGE_TAGS, type IngestVault, type MatrixMessage } from "../worker/matrix";
import { byteLen, isTooLarge, parseThread, rolloverLimits, rolloverThread } from "../worker/matrix-rollover";
import { formatHandle } from "../comms/naming";
import type { BbChat, BbMessage } from "./client";
import { bbChatTitle, errorForLog, chatKind, dmAddress, isOneTimeCode, isShortCodeSender, redactRef, SELF_ID, senderOf, tapbackOf, vaultBodyOf } from "./map";
import { chatNetworkOf, markSeen, noteMessageServices, seenGuids } from "./state";
import { OTP_RULE_VERSION } from "./map";

/** The seen outcome of an OTP exclusion: versioned, so a changed rule re-evaluates it. */
export const OTP_OUTCOME = `excluded:otp:v${OTP_RULE_VERSION}`;

/** A body never forges a separate entry: a continuation line that would start like a stamped
 *  entry (`[2026-…] Name: …`) is indented by one space (review M13). */
export function safeBody(body: string): string {
  return body.replace(/\n(?=\[)/g, "\n ");
}

/** The listing keys a pass reads off the lean thread listing. */
export const BB_THREAD_LIST_KEYS = ["blueBubblesChatGuid", "source", "lastMessageAt", "archiveOf"];

export interface BbIngestCtx {
  vault: IngestVault;
  /** Contacts / person-note name for an address, or null. */
  nameOf: (address: string) => string | null;
  /** How the owner's own lines are signed (his person note's name; "Me" when unknown). */
  selfName: string;
  /** Existing people (strong keys only); null = no links this pass. */
  people?: PeopleIndex | null;
  /** The owner's own person note (never linked as a participant). */
  ownerPersonId?: string | null;
  /** Rows of the lean listing, by chat GUID (built once per pass by listBbThreads). */
  rows?: Map<string, Note>;
}

export interface BbIngestResult {
  written: number;
  excluded: number;
  created: number;
  updated: number;
  /** Chats whose write failed (their messages stay unseen: the next pass retries them). */
  failedChats: string[];
  /** chat GUID → thread note id, for every chat written this call. */
  notes: Map<string, string>;
}

/** Lean listing of the BlueBubbles thread notes: chat GUID → row. */
export async function listBbThreads(vault: IngestVault): Promise<Map<string, Note>> {
  const rows = await vault.listNotes({ tags: ["message-thread"], includeContent: false, includeMetadata: BB_THREAD_LIST_KEYS });
  const out = new Map<string, Note>();
  for (const n of rows) {
    const md = (n.metadata ?? {}) as Record<string, unknown>;
    if ((n.tags ?? []).includes("message-archive") || md.archiveOf) continue;
    // Only notes this connector wrote (review I6): a note someone else tagged with a guessed chat
    // GUID is never adopted (the key + source are also reserved for non-admin writes).
    if (md.source !== "bluebubbles") continue;
    if (typeof md.blueBubblesChatGuid === "string" && md.blueBubblesChatGuid) out.set(md.blueBubblesChatGuid, n);
  }
  return out;
}

const chatHash = (guid: string): string => createHash("sha256").update(guid).digest("hex").slice(0, 8);
const isConflict = (e: unknown): boolean => {
  const st = (e as { status?: unknown })?.status;
  return st === 409 || st === 428;
};

/** Why a message never reaches the vault (D13 and non-message items), or null to write it. */
export function vaultExclusion(m: BbMessage, chat: BbChat | null): "short-code" | "one-time-code" | "tapback" | "retracted" | "empty" | "system" | null {
  if (tapbackOf(m)) return "tapback";
  if (typeof m.dateRetracted === "number" && m.dateRetracted > 0) return "retracted";
  if ((m.itemType ?? 0) !== 0) return "system";
  if (chat && chatKind(chat) === "dm" && isShortCodeSender(dmAddress(chat))) return "short-code";
  if (!m.isFromMe && isShortCodeSender(m.handle?.address)) return "short-code";
  if (isOneTimeCode(m.text) || isOneTimeCode(m.subject)) return "one-time-code";
  if (!vaultBodyOf(m)) return "empty";
  return null;
}

/** The chat a message belongs to: its own `chats[0]`, else a known chat. */
export function chatOfMessage(m: BbMessage, known: (guid: string) => BbChat | null): BbChat | null {
  const c = m.chats?.find((x) => x && typeof x.guid === "string");
  if (!c) return null;
  const k = known(c.guid);
  // The webhook's chat may lack participants; the cached one keeps them.
  return k && !(c.participants?.length) ? { ...k, ...c, participants: k.participants } : c;
}

export function threadTitle(chat: BbChat, ctx: Pick<BbIngestCtx, "nameOf" | "people" | "ownerPersonId">, personName?: string | null): string {
  const isSelf = (a: string): boolean => !!ctx.ownerPersonId && personOfAddress(ctx.people, a)?.id === ctx.ownerPersonId;
  return bbChatTitle(chat, { nameOf: ctx.nameOf, isSelf, personOf: (a) => personOfAddress(ctx.people, a)?.id ?? null }, chatNetworkOf(chat), personName).title;
}

const personOfAddress = (people: PeopleIndex | null | undefined, address: string): Note | null => {
  if (!people) return null;
  try {
    return address.includes("@") ? people.find({ email: address }) : people.find({ phone: address });
  } catch {
    return null;
  }
};

const entryTs = (entry: string): number => {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/.exec(entry);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : 0;
};

interface Line { guid: string; ts: number; line: string; key: string; msg: MatrixMessage }

/** Body with `lines` merged in time order after the stored entries (header + pointer kept verbatim). */
function mergedBody(content: string, lines: Line[]): string {
  const all = content.split("\n");
  const first = all.findIndex((l) => /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}|unknown)\] /.test(l));
  const header = (first === -1 ? content : all.slice(0, first).join("\n")).trimEnd();
  const entries = first === -1 ? [] : parseThread(content).entries;
  const merged = [...entries.map((e, i) => ({ e, ts: entryTs(e), i })), ...lines.map((l, i) => ({ e: l.line, ts: l.ts - (l.ts % 60_000), i: entries.length + i }))];
  merged.sort((a, b) => a.ts - b.ts || a.i - b.i);
  return `${header}\n\n${merged.map((x) => x.e).join("\n")}`;
}

/**
 * After a 409 only (review I1 — GUID dedupe is exact, so a normal append never drops a line):
 * which of `lines` did someone else already append since we read `loaded`? Keyed by the WHOLE
 * rendered line (stamp + sender + body): two people saying "ok" in one minute are two lines.
 * When the fresh body is our copy plus a tail, only the tail counts.
 */
function notYetWritten(lines: Line[], loaded: string, fresh: string): Line[] {
  const before = loaded.trimEnd();
  const scope = fresh.startsWith(before) ? fresh.slice(before.length) : fresh;
  const have = new Map<string, number>();
  for (const e of parseThread(scope).entries) {
    const k = e.trimEnd();
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  return lines.filter((l) => {
    const n = have.get(l.key) ?? 0;
    if (n > 0) have.set(l.key, n - 1);
    return n === 0;
  });
}

/**
 * Write a batch of BlueBubbles messages into the vault. Messages already seen are skipped; the
 * rest are grouped by chat, excluded per D13 or written. Never throws for one chat's failure:
 * that chat is reported in `failedChats` and its messages stay unseen (retried next pass).
 */
export async function ingestBlueBubbles(messages: BbMessage[], knownChat: (guid: string) => BbChat | null, ctx: BbIngestCtx): Promise<BbIngestResult> {
  const res: BbIngestResult = { written: 0, excluded: 0, created: 0, updated: 0, failedChats: [], notes: new Map() };
  const fresh = messages.filter((m) => m && typeof m.guid === "string");
  // Every message read (webhook, poll, backfill) is service evidence for its chat (iMessage vs SMS).
  noteMessageServices(fresh);
  const seen = seenGuids(fresh.map((m) => m.guid));
  const byChat = new Map<string, { chat: BbChat; messages: BbMessage[] }>();
  const unplaced: string[] = [];
  for (const m of fresh) {
    if (seen.has(m.guid)) continue;
    const chat = chatOfMessage(m, knownChat);
    if (!chat) { unplaced.push(m.guid); continue; }
    const g = byChat.get(chat.guid) ?? { chat, messages: [] };
    if (!g.chat.participants?.length && chat.participants?.length) g.chat = chat;
    g.messages.push(m);
    byChat.set(chat.guid, g);
  }
  if (unplaced.length) console.warn(`[bluebubbles] ${unplaced.length} message(s) carried no chat — retried when they arrive with one`);
  const rows = ctx.rows ?? (await listBbThreads(ctx.vault));

  for (const [guid, { chat, messages: batch }] of byChat) {
    const excluded: string[] = [];
    const lines: Line[] = [];
    const otp: string[] = [];
    for (const m of batch.sort((a, b) => (a.dateCreated ?? 0) - (b.dateCreated ?? 0))) {
      if (!(typeof m.dateCreated === "number" && m.dateCreated > 0)) continue; // undated (M15): left unseen, written once BlueBubbles dates it
      const why = vaultExclusion(m, chat);
      if (why === "one-time-code") { otp.push(m.guid); continue; }
      if (why) { excluded.push(m.guid); continue; }
      const sender = senderOf(m, chat) ?? "unknown";
      const who = sender === SELF_ID ? ctx.selfName : ctx.nameOf(sender) ?? formatHandle(sender);
      const body = safeBody(vaultBodyOf(m));
      const ts = m.dateCreated ?? 0;
      const line = `${formatStamp(ts)} ${who}: ${body}`;
      lines.push({ guid: m.guid, ts, line, key: line.trimEnd(), msg: { sender, body, ts, eventId: m.guid } });
    }
    markSeen(excluded, "excluded");
    // A heuristic (OTP) exclusion is recorded WITH its rule version: a later rule re-evaluates it.
    markSeen(otp, OTP_OUTCOME);
    excluded.push(...otp);
    res.excluded += excluded.length;
    if (!lines.length) continue;
    try {
      const noteId = await writeChat(chat, lines, rows, ctx, res);
      if (noteId) res.notes.set(guid, noteId);
      markSeen(lines.map((l) => l.guid), "written");
      res.written += lines.length;
    } catch (e) {
      res.failedChats.push(guid);
      console.warn(`[bluebubbles] chat ${redactRef(guid)} write failed (retried next pass): ${errorForLog(e)}`);
    }
  }
  return res;
}

async function readThread(vault: IngestVault, row: Note): Promise<Note> {
  if (vault.getNote) {
    const n = await vault.getNote(row.id);
    if (!n || typeof n.content !== "string") throw new Error("thread could not be read (no body)");
    return n;
  }
  if (typeof row.content === "string") return row;
  throw new Error("the listing is lean and this vault cannot re-read a note");
}

async function writeChat(chat: BbChat, lines: Line[], rows: Map<string, Note>, ctx: BbIngestCtx, res: BbIngestResult): Promise<string | null> {
  const platform = chatNetworkOf(chat);
  const kind = chatKind(chat);
  const addresses = (chat.participants ?? []).map((h) => h.address).filter(Boolean);
  const people = addresses.map((a) => personOfAddress(ctx.people, a)).filter((p): p is Note => !!p && p.id !== ctx.ownerPersonId);
  const counterpart = kind === "dm" ? people[0] ?? null : null;
  const personName = counterpart ? sharedPersonName(counterpart) || null : null;
  const title = threadTitle(chat, ctx, personName as string | null);
  const links: NoteLinkInput[] = [...new Map(people.map((p) => [p.id, { target: p.id, relationship: "messages-with" }])).values()];
  const participants = addresses.map((a) => ctx.nameOf(a) ?? formatHandle(a));
  const lastMessageAt = Math.max(...lines.map((l) => l.ts));
  const msgs = lines.map((l) => l.msg);
  const row = rows.get(chat.guid);

  if (!row) {
    const base = `vault/messages/${platform}/${sanitizePath(title)}`;
    const taken = [...rows.values()].some((n) => n.path === base);
    const params = {
      content: `# ${title} — ${platform}\n\n${lines.map((l) => l.line).join("\n")}`,
      tags: ["message-thread"],
      metadata: {
        type: "message-thread",
        source: "bluebubbles",
        platform,
        title,
        blueBubblesChatGuid: chat.guid,
        lastMessageAt,
        ...lastMessageEvidence(msgs, undefined, [SELF_ID]),
        messageCount: lines.length,
        participants,
        participantIds: addresses,
      },
      ...(links.length ? { links } : {}),
    };
    let made: Note;
    try {
      made = await ctx.vault.createNote({ ...params, path: taken ? `${base}-${chatHash(chat.guid)}` : base });
    } catch (e) {
      if (!isConflict(e) && !/409/.test(String(e))) throw e;
      // A 409 may be THIS chat's note, made meanwhile (review I5): adopt it, never a second note.
      const fresh = await listBbThreads(ctx.vault);
      const mine = fresh.get(chat.guid);
      if (mine) {
        rows.set(chat.guid, mine);
        return appendChat(chat, lines, mine, rows, ctx, res, { platform, kind, title, links, participants, addresses, lastMessageAt });
      }
      if (taken) throw e;
      made = await ctx.vault.createNote({ ...params, path: `${base}-${chatHash(chat.guid)}` });
    }
    res.created++;
    if (made?.id) rows.set(chat.guid, { ...made, path: made.path ?? null, tags: made.tags ?? params.tags, metadata: made.metadata ?? params.metadata });
    return made?.id ?? null;
  }

  return appendChat(chat, lines, row, rows, ctx, res, { platform, kind, title, links, participants, addresses, lastMessageAt });
}

async function appendChat(
  chat: BbChat, lines: Line[], row: Note, rows: Map<string, Note>, ctx: BbIngestCtx, res: BbIngestResult,
  x: { platform: string; kind: "dm" | "group"; title: string; links: NoteLinkInput[]; participants: string[]; addresses: string[]; lastMessageAt: number },
): Promise<string> {
  const { platform, kind, title, links, participants, addresses, lastMessageAt } = x;
  let note = await readThread(ctx.vault, row);
  let pending = lines;
  let advanced = false;
  for (let attempt = 0; ; attempt++) {
    if (!pending.length) return note.id;
    const prev = (note.metadata ?? {}) as Record<string, unknown>;
    const prevParticipants = Array.isArray(prev.participants) ? (prev.participants as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const prevIds = Array.isArray(prev.participantIds) ? (prev.participantIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const metadata = {
      ...prev,
      type: "message-thread",
      source: "bluebubbles",
      platform: typeof prev.platform === "string" && prev.platform ? prev.platform : platform,
      blueBubblesChatGuid: chat.guid,
      lastMessageAt: Math.max(lastMessageAt, lastMessageAtOf(note)),
      ...lastMessageEvidence(pending.map((l) => l.msg), prev, [SELF_ID]),
      messageCount: (typeof prev.messageCount === "number" ? prev.messageCount : 0) + pending.length,
      participants: [...new Set([...prevParticipants, ...participants])],
      participantIds: [...new Set([...prevIds, ...addresses])],
      // A group rename wins; a stored human title otherwise stands.
      ...(kind === "group" && chat.displayName ? { title: chat.displayName } : typeof prev.title === "string" && prev.title ? {} : { title }),
    };
    const stored = note.content ?? "";
    const older = pending.some((l) => l.ts < lastMessageAtOf(note));
    advanced = lastMessageAt > lastMessageAtOf(note);
    const content = older ? mergedBody(stored, pending) : `${stored.trimEnd()}\n${pending.map((l) => l.line).join("\n")}`;
    const cas = note.updatedAt ? { ifUpdatedAt: note.updatedAt } : {};
    const linkAdd = links.length ? { links: { add: links } } : {};
    try {
      if (byteLen(content) > rolloverLimits().maxBytes) {
        const out = await rolloverThread(ctx.vault, older ? { ...note, content } : note, { appendEntries: older ? [] : pending.map((l) => l.line), metadata, noRetry: true, force: older });
        if (out) {
          rows.set(chat.guid, out.note);
          break;
        }
      }
      await ctx.vault.updateNote(note.id, { content, metadata, ...cas, ...linkAdd });
      break;
    } catch (e) {
      if (isTooLarge(e)) {
        const out = await rolloverThread(ctx.vault, { ...note, content }, { appendEntries: [], metadata, force: true, noRetry: true });
        if (!out) throw e;
        rows.set(chat.guid, out.note);
        break;
      }
      if (!isConflict(e) || attempt >= 1) throw e;
      const fresh = await readThread(ctx.vault, row);
      pending = notYetWritten(pending, note.content ?? "", fresh.content ?? "");
      note = fresh;
    }
  }
  res.updated++;
  // Re-triage only for NEW activity (review M5): a backfill page merging older lines is not news.
  const stale = advanced ? TRIAGE_TAGS.filter((t) => note.tags?.includes(t)) : [];
  if (stale.length && ctx.vault.removeTags) await ctx.vault.removeTags(note.id, stale).catch(() => {});
  return note.id;
}

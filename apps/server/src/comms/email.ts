/**
 * Email in Comms (PRD §5.8, DECISIONS D3/D11; COMMS_EMAIL_ENABLED, default off).
 *
 * The vault's `email` notes (one per message, written by the Proton ingest — proton_mail.py or its
 * server port worker/proton.ts — under vault/messages/email, metadata from/to/cc/subject/labels/
 * threadId/messageId/account/lastMessageAt) are projected into Comms conversations:
 *
 *  - one conversation per (account, threadId): id = conversationIdForKey("email:<account>:<threadId>"),
 *    network "email", source_ref = "email:<account>:<threadId>". A DM when the thread has one
 *    correspondent besides the owner, else a group.
 *  - title (D3): the correspondent's person note ONLY on a confident strong key (the people index's
 *    verified email match — never a name), else the sender's display name from the From header,
 *    else the address. The thread is linked to that person (personId, members) so it shows on the
 *    person's page. Merging the email thread INTO another network's display thread is not done
 *    here (see the task report: a merged timeline needs multi-source paging).
 *  - list preview: `subject` (rendered semibold by the clients) + a plain snippet of the body.
 *  - folder: Low when every inbound message carries a newsletter/automated/promotions label
 *    (BULK, AUTOMATED, SOCIAL, CHAT, PROMOTIONS, TRANSACTIONAL) and none is DIRECT, or the note is
 *    tagged `low`; else the inbox. Unread = inbound notes with isUnread (IMAP \Seen: trusted).
 *  - messages render as bubbles: plain-text body (never interpreted as Markdown), quoted history and
 *    signature collapsed into one `quote` span the clients hide behind "…", `email` header facts.
 *
 * The projection reads the vault LEAN (metadata only) every pass; bodies are read only for the
 * snippet of a conversation's newest message (once per note version) and for the page of a timeline
 * being shown. Nothing here sends anything (comms/email-send.ts).
 */
import { decodeHTML } from "entities";
import { db } from "../db";
import { config } from "../config";
import type { Note } from "../parachute";
import { parseAddressList } from "../worker/proton-parse";
import { conversationIdForKey } from "./project";
import { resolveAvatar, resolveTitle } from "./naming";
import { appendEvent, ensureSingleThread, removeConversation, replaceConversationMembers, setThreadPerson, upsertConversation, type Folder } from "./store";
import { commsStatus } from "./triage";
import { mintSourceCursor, sourceCursorPosition } from "./timeline";
import { fromPlainText, type Span } from "./richtext";
import type { Capabilities, Message, MessagePreview, RichText } from "./types";
import { clipText, wellFormed } from "./wire";

export const EMAIL_CAPABILITIES: Capabilities = { react: false, edit: false, unsend: false, reply: false, typing: false, receipts: false, attachments: false };
/** Header labels (proton_mail.py derive_labels) that make a message newsletter / automated / promotional. */
export const LOW_LABELS: ReadonlySet<string> = new Set(["BULK", "AUTOMATED", "SOCIAL", "CHAT", "PROMOTIONS", "TRANSACTIONAL"]);
const SNIPPET_CHARS = 280;
/** Bodies read per projection pass for previews (the rest are read on later passes). */
const SNIPPET_READS_PER_PASS = 200;

const md = (n: Note): Record<string, unknown> => (n.metadata ?? {}) as Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const lc = (v: string): string => v.trim().toLowerCase();

// ── headers ────────────────────────────────────────────────────────────────

export interface Mailbox { name: string; addr: string }

/** Every mailbox in an address header ("A <a@x>, b@y"); groups flattened, invalid ones dropped. */
export function mailboxes(raw: unknown): Mailbox[] {
  const v = Array.isArray(raw) ? raw.filter((x) => typeof x === "string").join(", ") : s(raw);
  if (!v.trim()) return [];
  try {
    return parseAddressList(v).flatMap((it) => it.members)
      .filter((m) => m.addr && m.addr !== "<>" && m.addr.includes("@"))
      .map((m) => ({ name: m.name.replace(/^"|"$/g, "").trim(), addr: lc(m.addr) }));
  } catch {
    return [];
  }
}

/** A message is "low" when it carries a low label and is not DIRECT. */
export function isLowMessage(labels: unknown): boolean {
  const l = Array.isArray(labels) ? labels.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : [];
  return !l.includes("DIRECT") && l.some((x) => LOW_LABELS.has(x));
}

// ── bodies ─────────────────────────────────────────────────────────────────

/** The note's body (after the header block and its `---` rule) and the attachment names it lists. */
export function parseNoteContent(content: string): { body: string; attachments: string[] } {
  const text = content.replace(/\r\n?/g, "\n");
  const i = text.indexOf("\n---\n");
  const head = i >= 0 ? text.slice(0, i) : "";
  let body = i >= 0 ? text.slice(i + 5) : text;
  body = body.replace(/^\n/, "").replace(/\n*\[… truncated …\]\s*$/, "");
  const att = /^\*\*Attachments:\*\*\s*(.+?)\s*$/m.exec(head)?.[1] ?? "";
  return { body: body.trimEnd(), attachments: att ? att.split(/,\s*/).map((a) => a.trim()).filter(Boolean).slice(0, 50) : [] };
}

const QUOTE_HEADER = [
  /^On .{0,300}wrote:\s*$/i, // Gmail / Apple Mail
  /^Am .{0,300}schrieb.{0,80}:\s*$/i,
  /^Le .{0,300}a écrit\s*:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^_{10,}\s*$/, // Outlook rule above "From: … Sent: …"
];

/**
 * Split a plain-text email into what was newly written and the part a Messages-style bubble
 * collapses ("…"): quoted history (an attribution line, or a trailing run of `>` lines) and the
 * signature (`-- ` delimiter). Linear; no backtracking regex over the body.
 */
export function splitEmailBody(text: string): { fresh: string; collapsed: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const two = i + 1 < lines.length ? `${l} ${lines[i + 1]}` : l;
    if (l === "-- " || l === "--") { cut = i; break; }
    if (QUOTE_HEADER.some((re) => re.test(l.trim())) || (/^On\s/i.test(l.trim()) && /wrote:\s*$/i.test(two.trim()) && l.length < 300)) { cut = i; break; }
    if (/^From:\s/i.test(l) && /^(Sent|Date):\s/i.test(lines[i + 1] ?? "")) { cut = i; break; }
    if (/^>/.test(l)) {
      // a block of quoted lines that runs (blank lines allowed) to the end
      let j = i;
      while (j < lines.length && (/^>/.test(lines[j]!) || !lines[j]!.trim())) j++;
      if (j === lines.length) { cut = i; break; }
    }
  }
  const fresh = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
  const collapsed = lines.slice(cut).join("\n").replace(/^\s+|\s+$/g, "");
  // Nothing new above the quote (a bare forward): show it all.
  if (!fresh.trim()) return { fresh: collapsed, collapsed: "" };
  return { fresh, collapsed };
}

/** Bubble body: the new text as plain spans, then the collapsed part as one `quote` span. */
export function emailRichText(body: string): { body: RichText; quotedCollapsed: boolean } {
  const { fresh, collapsed } = splitEmailBody(body);
  const top = fromPlainText(fresh);
  if (!collapsed) return { body: top, quotedCollapsed: false };
  const q = fromPlainText(collapsed);
  const spans: Span[] = [...top.spans, { t: "quote", c: q.spans }];
  return { body: { spans, plain: top.plain, jumboEmoji: false, truncated: top.truncated || q.truncated }, quotedCollapsed: true };
}

export function snippetOf(body: string): string {
  return clipText(splitEmailBody(body).fresh.replace(/\s+/g, " ").trim(), SNIPPET_CHARS);
}

// ── projection ─────────────────────────────────────────────────────────────

export interface EmailProjectDeps {
  /** Every `email` note, LEAN: metadata only (no bodies). */
  listEmailNotes(): Promise<Note[]>;
  /** One note with its body (snippets). */
  getNote(id: string): Promise<Note | null>;
  /** Strong-key person lookup by email address (the people index's VERIFIED match only). */
  personByEmail(addr: string): { id: string; name: string; photo?: string } | null;
  /** The owner's own addresses (lowercased). The note's `account` is always self too. */
  selfAddresses: readonly string[];
}

export interface StoredMeta {
  subject: string;
  from: string;
  to: string;
  cc: string;
  labels: string[];
  account: string | null;
  attachments?: string[];
  hasHtml?: boolean;
  /** Reply-To header when the ingest stores one (it wins over From for a reply). */
  replyTo?: string;
}

interface Msg { note: Note; id: string; at: number; meta: StoredMeta; self: boolean; fromBox: Mailbox | null }

export const emailSourceRef = (account: string | null, threadId: string): string => `email:${lc(account ?? "")}:${threadId}`;
export const emailConversationId = (account: string | null, threadId: string): string => conversationIdForKey(emailSourceRef(account, threadId));

function atOf(m: Record<string, unknown>, n: Note): number {
  const v = typeof m.lastMessageAt === "number" ? m.lastMessageAt : Number(m.lastMessageAt);
  if (Number.isFinite(v) && v > 0) return v;
  const d = Date.parse(s(m.date).replace(" ", "T"));
  return Number.isFinite(d) ? d : Date.parse(n.createdAt) || 0;
}

export interface EmailProjectResult { conversations: number; removed: number; snippetsRead: number }

/** Project every email note. Conversations of threads no longer in the vault (and with no Comms-sent
 *  message) are removed. thread.updated when a row changed; message.created for new inbound notes of a
 *  conversation that was already projected. */
export async function projectEmail(deps: EmailProjectDeps): Promise<EmailProjectResult> {
  const notes = (await deps.listEmailNotes()).filter((n) => (n.tags ?? []).includes("email") && s(md(n).messageId));
  const groups = new Map<string, { account: string | null; threadId: string; msgs: Msg[] }>();
  for (const n of notes) {
    const m = md(n);
    const account = s(m.account) ? lc(s(m.account)) : null;
    const threadId = s(m.threadId) || s(m.messageId);
    const self = new Set([...deps.selfAddresses.map(lc), ...(account ? [account] : [])]);
    const fromBox = mailboxes(m.from)[0] ?? null;
    const meta: StoredMeta = {
      subject: s(m.subject) || "(no subject)", from: s(m.from), to: Array.isArray(m.to) ? (m.to as string[]).join(", ") : s(m.to),
      cc: Array.isArray(m.cc) ? (m.cc as string[]).join(", ") : s(m.cc),
      labels: Array.isArray(m.labels) ? (m.labels as unknown[]).filter((x): x is string => typeof x === "string") : [], account,
      ...(typeof m.html === "string" && m.html ? { hasHtml: true } : {}),
      ...(s(m.replyTo) || Array.isArray(m.replyTo) ? { replyTo: Array.isArray(m.replyTo) ? (m.replyTo as string[]).join(", ") : s(m.replyTo) } : {}),
    };
    const key = emailSourceRef(account, threadId);
    const g = groups.get(key) ?? { account, threadId, msgs: [] };
    g.msgs.push({ note: n, id: s(m.messageId), at: atOf(m, n), meta, self: !!fromBox && self.has(fromBox.addr), fromBox });
    groups.set(key, g);
  }
  let snippetsRead = 0;
  const seen = new Set<string>();
  for (const g of groups.values()) {
    const id = conversationIdForKey(emailSourceRef(g.account, g.threadId));
    seen.add(id);
    const r = await projectThread(id, g, deps, snippetsRead < SNIPPET_READS_PER_PASS);
    snippetsRead += r.read;
  }
  // Gone from the vault (and never written to from Comms): not a conversation any more.
  let removed = 0;
  const rows = db.prepare(`SELECT id FROM comms_conversations WHERE network = 'email'`).all() as { id: string }[];
  // A listing that came back empty or lost more than a fifth of the conversations at once is
  // more likely a vault mid-reindex/restart than mail deleted (final review M8): keep them, and
  // let a later, ordinary pass remove what is really gone.
  const missing = rows.filter((r) => !seen.has(r.id)).length;
  if (missing > 0 && (groups.size === 0 || (missing > 5 && missing > rows.length * 0.2))) {
    console.warn(`[comms] email projection: ${missing} of ${rows.length} conversations missing from the listing — not removed this pass`);
    return { conversations: groups.size, removed: 0, snippetsRead };
  }
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    if (db.prepare(`SELECT 1 FROM comms_email_sent WHERE conversation_id = ? LIMIT 1`).get(r.id)) continue;
    db.prepare(`DELETE FROM comms_email_messages WHERE conversation_id = ?`).run(r.id);
    if (removeConversation(r.id)) removed++;
  }
  return { conversations: groups.size, removed, snippetsRead };
}

async function projectThread(id: string, g: { account: string | null; threadId: string; msgs: Msg[] }, deps: EmailProjectDeps, mayRead: boolean): Promise<{ read: number }> {
  const msgs = g.msgs.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const self = new Set([...deps.selfAddresses.map(lc), ...(g.account ? [g.account] : [])]);
  const known = new Map((db.prepare(`SELECT note_id, note_version, snippet FROM comms_email_messages WHERE conversation_id = ?`).all(id) as { note_id: string; note_version: string | null; snippet: string | null }[])
    .map((r) => [r.note_id, r]));
  const hadRows = known.size > 0;
  // Everyone on the thread but the owner.
  const others = new Map<string, Mailbox>();
  for (const m of msgs) for (const b of [...mailboxes(m.meta.from), ...mailboxes(m.meta.to), ...mailboxes(m.meta.cc)]) {
    if (!self.has(b.addr) && (!others.has(b.addr) || (!others.get(b.addr)!.name && b.name))) others.set(b.addr, b);
  }
  const inbound = msgs.filter((m) => !m.self);
  const lastIn = inbound[inbound.length - 1] ?? null;
  const counterpart: Mailbox | null = lastIn?.fromBox ?? [...others.values()][0] ?? null;
  const kind: "dm" | "group" = others.size <= 1 ? "dm" : "group";
  const person = counterpart ? deps.personByEmail(counterpart.addr) : null;
  const { title, titleSource } = resolveTitle({
    person: kind === "dm" || person ? person : null,
    emailDisplayName: counterpart?.name || counterpart?.addr || null,
    memberDisplayNames: kind === "group" ? [counterpart?.name || counterpart?.addr || ""].filter(Boolean) : [],
    handle: counterpart?.addr ?? null,
    kind: "dm", // D3: an email conversation is titled by its sender, also with others on Cc
    network: "email",
  });
  const avatar = resolveAvatar({ personPhoto: person?.photo ?? null, title });

  // Index rows (+ a snippet for the newest message, read once per note version).
  const latest = msgs[msgs.length - 1]!;
  let read = 0;
  let latestSnippet: string | null = known.get(latest.note.id)?.note_version === (latest.note.updatedAt ?? "") ? known.get(latest.note.id)?.snippet ?? null : null;
  let latestBody: { body: string; attachments: string[] } | null = null;
  if (latestSnippet === null && mayRead) {
    const full = await deps.getNote(latest.note.id).catch(() => null);
    read = 1;
    if (full) {
      latestBody = parseNoteContent(full.content ?? "");
      latestSnippet = snippetOf(latestBody.body);
    }
  }
  const upsert = db.prepare(`INSERT INTO comms_email_messages (conversation_id, note_id, message_id, sent_at, is_self, note_version, meta_json, snippet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, note_id) DO UPDATE SET message_id = excluded.message_id, sent_at = excluded.sent_at,
    is_self = excluded.is_self, note_version = excluded.note_version, meta_json = excluded.meta_json, snippet = COALESCE(excluded.snippet, comms_email_messages.snippet)`);
  const fresh: Msg[] = [];
  db.transaction(() => {
    for (const m of msgs) {
      if (!known.has(m.note.id)) fresh.push(m);
      const snip = m === latest ? latestSnippet : null;
      const meta = m === latest && latestBody ? { ...m.meta, attachments: latestBody.attachments } : m.meta;
      upsert.run(id, m.note.id, m.id, new Date(m.at).toISOString(), m.self ? 1 : 0, m === latest && snip !== null ? m.note.updatedAt ?? "" : known.get(m.note.id)?.note_version ?? null, JSON.stringify(meta), snip);
    }
    const ids = new Set(msgs.map((m) => m.note.id));
    for (const k of known.keys()) if (!ids.has(k)) db.prepare(`DELETE FROM comms_email_messages WHERE conversation_id = ? AND note_id = ?`).run(id, k);
  })();

  // A Comms-sent reply newer than the newest note is the conversation's latest message.
  const sent = db.prepare(`SELECT sent_at, json FROM comms_email_sent WHERE conversation_id = ? ORDER BY sent_at DESC LIMIT 1`).get(id) as { sent_at: string; json: string } | undefined;
  const sentAt = sent ? Date.parse(sent.sent_at) : 0;
  let lastEventAt = new Date(latest.at).toISOString();
  let preview: MessagePreview = {
    text: latestSnippet ?? "", subject: latest.meta.subject, senderName: latest.self ? null : latest.fromBox?.name || latest.fromBox?.addr || null,
    isSelf: latest.self, sentAt: lastEventAt,
  };
  if (sent && sentAt > latest.at) {
    const sm = JSON.parse(sent.json) as Message;
    lastEventAt = sent.sent_at;
    preview = { text: clipText((sm.body?.plain ?? "").replace(/\s+/g, " ").trim(), SNIPPET_CHARS), subject: sm.email?.subject ?? latest.meta.subject, senderName: null, isSelf: true, sentAt: sent.sent_at };
  }
  const tags = latest.note.tags ?? [];
  const lowTagged = msgs.some((m) => (m.note.tags ?? []).includes("low"));
  const ownerWrote = msgs.some((m) => m.self) || !!sent;
  const folder: Folder = lowTagged || (!ownerWrote && inbound.length > 0 && inbound.every((m) => isLowMessage(m.meta.labels))) ? "low" : "inbox";
  const unread = preview.isSelf ? 0 : inbound.filter((m) => md(m.note).isUnread === true).length;
  const rowNow = () => JSON.stringify(db.prepare(`SELECT * FROM comms_conversations WHERE id = ?`).get(id) ?? null);
  const before = rowNow();
  upsertConversation({
    id, network: "email", sourceRef: emailSourceRef(g.account, g.threadId), kind, title, titleSource, avatar, lastEventAt, lastPreview: preview,
    unreadCount: unread, unreadTrusted: true, folder, pinned: false, muted: false, archived: false, triage: null,
    status: commsStatus((lastIn?.note ?? latest.note).tags ?? tags), accountLabel: g.account, capabilities: EMAIL_CAPABILITIES,
    vaultNoteId: (lastIn ?? latest).note.id,
  });
  const threadId = ensureSingleThread(id);
  const members = [...others.values()].map((b) => ({ memberId: `mailto:${b.addr}`, personId: deps.personByEmail(b.addr)?.id ?? null }));
  replaceConversationMembers(id, kind === "dm" ? members : members.filter((m) => m.personId));
  setThreadPerson(threadId, kind === "dm" ? person?.id ?? null : null);
  if (rowNow() !== before) appendEvent("thread.updated", threadId, { threadId });
  if (hadRows) for (const m of fresh) {
    const msg = toMessage(threadId, { note_id: m.note.id, message_id: m.id, sent_at: new Date(m.at).toISOString(), is_self: m.self ? 1 : 0, meta_json: JSON.stringify(m.meta) }, m === latest && latestBody ? latestBody : null, deps.personByEmail);
    appendEvent("message.created", threadId, { threadId, message: msg });
  }
  return { read };
}

// ── the read path ──────────────────────────────────────────────────────────

export interface EmailSource { conversationId: string; sourceRef: string; account: string | null }

/** The email conversation behind a display thread, or null. */
export function emailThreadSource(threadId: string): EmailSource | null {
  const r = db.prepare(`SELECT c.id AS id, c.source_ref AS ref, c.account_label AS account FROM comms_thread_members m
    JOIN comms_conversations c ON c.id = m.conversation_id WHERE m.thread_id = ? AND c.network = 'email' ORDER BY c.last_event_at DESC LIMIT 1`)
    .get(threadId) as { id: string; ref: string; account: string | null } | undefined;
  return r && r.ref.startsWith("email:") && r.id === conversationIdForKey(r.ref) ? { conversationId: r.id, sourceRef: r.ref, account: r.account } : null;
}

interface IndexRow { note_id: string; message_id: string; sent_at: string; is_self: number; meta_json: string }

type PersonLookup = (addr: string) => { id: string; name: string } | null;

function toMessage(threadId: string, r: IndexRow, content: { body: string; attachments: string[] } | null, person: PersonLookup): Message {
  const meta = JSON.parse(r.meta_json) as StoredMeta;
  const from = mailboxes(meta.from)[0] ?? null;
  const p = from && !r.is_self ? person(from.addr) : null;
  const rich = content ? emailRichText(content.body) : { body: null, quotedCollapsed: false };
  const atts = content?.attachments ?? meta.attachments ?? [];
  return {
    id: r.note_id, threadId,
    channel: { network: "email", accountLabel: meta.account },
    source: { network: "email", eventId: r.note_id, ref: r.message_id },
    sender: {
      id: from ? `mailto:${from.addr}` : "mailto:unknown", name: p?.name || from?.name || from?.addr || "Unknown", avatar: null,
      isSelf: r.is_self === 1, isOmni: false, ...(p ? { personId: p.id } : {}),
    },
    sentAt: r.sent_at,
    body: rich.body,
    email: {
      subject: meta.subject, from: meta.from,
      to: mailboxes(meta.to).map((b) => b.addr), cc: mailboxes(meta.cc).map((b) => b.addr),
      quotedCollapsed: rich.quotedCollapsed, hasHtml: meta.hasHtml === true,
    },
    attachments: atts.map((name) => ({ kind: "file" as const, name })),
    linkPreviews: [], reactions: [], delivery: r.is_self === 1 ? "sent" : null, redacted: false,
  };
}

export interface EmailTimelinePage { messages: Message[]; before: string | null; hasMore: boolean }

/** Newest-last page of an email conversation: vault notes (bodies read for this page only) + the
 *  replies sent from Comms. Cursor = a server-side `tc_` id holding "sentAt|id". null = bad cursor. */
export async function readEmailTimeline(q: { threadId: string; source: EmailSource; limit: number; before?: string; getNote(id: string): Promise<Note | null>; person: PersonLookup }): Promise<EmailTimelinePage | null> {
  let at = "￿", key = "￿";
  if (q.before) {
    const pos = sourceCursorPosition(q.before, q.threadId, q.source.sourceRef);
    if (pos === null) return null;
    const i = pos.indexOf("|");
    at = pos.slice(0, i);
    key = pos.slice(i + 1);
  }
  const rows = db.prepare(`SELECT * FROM (
      SELECT 'n' AS k, note_id AS id, sent_at, NULL AS json FROM comms_email_messages WHERE conversation_id = ?
      UNION ALL SELECT 's' AS k, event_id AS id, sent_at, json FROM comms_email_sent WHERE conversation_id = ?)
    WHERE (sent_at < ? OR (sent_at = ? AND id < ?)) ORDER BY sent_at DESC, id DESC LIMIT ?`)
    .all(q.source.conversationId, q.source.conversationId, at, at, key, q.limit + 1) as { k: "n" | "s"; id: string; sent_at: string; json: string | null }[];
  const page = rows.slice(0, q.limit);
  const out = await Promise.all(page.map(async (r): Promise<Message | null> => {
    if (r.k === "s") return JSON.parse(r.json!) as Message;
    const idx = db.prepare(`SELECT note_id, message_id, sent_at, is_self, meta_json FROM comms_email_messages WHERE conversation_id = ? AND note_id = ?`).get(q.source.conversationId, r.id) as IndexRow | undefined;
    if (!idx) return null;
    const note = await q.getNote(r.id).catch(() => null);
    return toMessage(q.threadId, idx, note ? parseNoteContent(note.content ?? "") : null, q.person);
  }));
  const messages = out.filter((m): m is Message => !!m).reverse();
  const oldest = page[page.length - 1];
  const before = rows.length > q.limit && oldest ? mintSourceCursor(q.threadId, q.source.sourceRef, `${oldest.sent_at}|${oldest.id}`) : null;
  return { messages, before, hasMore: !!before };
}

/** "View full email": the whole stored message — plain text, and sanitized HTML when the note holds one. */
export async function readEmailOriginal(q: { source: EmailSource; messageId: string; getNote(id: string): Promise<Note | null> }): Promise<Record<string, unknown> | null> {
  const idx = db.prepare(`SELECT note_id, message_id, sent_at, is_self, meta_json FROM comms_email_messages WHERE conversation_id = ? AND note_id = ?`).get(q.source.conversationId, q.messageId) as IndexRow | undefined;
  if (idx) {
    const note = await q.getNote(idx.note_id);
    if (!note) return null;
    const meta = JSON.parse(idx.meta_json) as StoredMeta;
    const html = s(md(note).html);
    return { subject: meta.subject, from: meta.from, to: meta.to, cc: meta.cc, date: idx.sent_at, text: parseNoteContent(note.content ?? "").body, html: html ? sanitizeEmailHtml(html) : null };
  }
  const sent = db.prepare(`SELECT json FROM comms_email_sent WHERE conversation_id = ? AND event_id = ?`).get(q.source.conversationId, q.messageId) as { json: string } | undefined;
  if (!sent) return null;
  const m = JSON.parse(sent.json) as Message;
  return { subject: m.email?.subject ?? "", from: m.email?.from ?? "", to: (m.email?.to ?? []).join(", "), cc: (m.email?.cc ?? []).join(", "), date: m.sentAt, text: m.body?.plain ?? "", html: null };
}

/**
 * Defence in depth for the "View full email" sheet (the clients ALSO render it with scripts off,
 * every remote load blocked and a `default-src 'none'` CSP): active content and remote references
 * are removed here. Bounded: one pass of linear regexes over at most 1 MB.
 */
export function sanitizeEmailHtml(html: string): string {
  let h = wellFormed(html.slice(0, 1_000_000));
  h = h.replace(/<(script|style|iframe|object|embed|form|frame|frameset|base|meta|link|svg|math|template|noscript|audio|video)\b[\s\S]*?<\/\1\s*>/gi, "");
  h = h.replace(/<\/?(script|style|iframe|object|embed|form|frame|frameset|base|meta|link|svg|math|template|noscript|input|button|textarea|select|audio|video|source|track|picture)\b[^>]*>/gi, "");
  // Attributes are separated by whitespace OR "/" (`<img/src=…>`); values quoted or bare.
  const ATTR = (names: string) => new RegExp(`[\\s/](${names})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi");
  h = h.replace(ATTR("on[a-z]+|ping|formaction|action|xmlns:[a-z]+"), " ");
  // Remote and script URLs: only inline images (cid:/data:image) may load; links only https/mailto.
  h = h.replace(ATTR("src|srcset|background|poster|lowsrc|dynsrc|longdesc|data|codebase|xlink:href"), (m, _a, v: string) =>
    /^["']?\s*(cid:|data:image\/(png|jpeg|gif|webp);)/i.test(v) ? m : " ");
  h = h.replace(ATTR("href"), (m, _a, v: string) => (/^["']?\s*(https:|mailto:)/i.test(v) ? m : " "));
  // Inline styles: entity-decode first (`u&#114;l(` is `url(`); any url/import/expression/behaviour drops the attribute.
  h = h.replace(ATTR("style"), (m, _a, v: string) => {
    const decoded = decodeHTML(v).replace(/\\[0-9a-f]{1,6}\s?/gi, (e) => String.fromCodePoint(parseInt(e.slice(1), 16) || 0x20)).replace(/\/\*[\s\S]*?\*\//g, "");
    return /url\s*\(|@import|expression\s*\(|behavior|-moz-binding|image-set|src\s*\(/i.test(decoded) ? " " : m;
  });
  return h;
}

// ── replies ────────────────────────────────────────────────────────────────

/** What a reply would be sent to: the header the composer shows, echoed on Send. */
export interface ReplyOption { to: string[]; cc: string[]; subject: string }
export interface ReplyPlan {
  /** The email note the reply answers (the newest inbound message of the thread). */
  noteId: string;
  account: string;
  /** Reply (Mail's default): the sender only (Reply-To when the email has one). */
  reply: ReplyOption;
  /** Reply All: plus everyone else on the email's To/Cc. Null when it adds nobody or is too large. */
  replyAll: ReplyOption | null;
}
export type ReplyPlanResult = { ok: true; plan: ReplyPlan } | { ok: false; reason: "no_inbound" | "account" | "too_many_recipients" };
/** The approval payload's cap on To and on Cc (omni/approvals.ts validatePayload). */
export const MAX_REPLY_RECIPIENTS = 20;

/** The account Comms may send email from: the server owner's address (proton_send.py sends as the
 *  Bridge account, which is the owner's). No fallback — a thread of another account is not answerable. */
export const sendingAccount = (): string => lc(config.ownerEmail);

/**
 * Reply-all recipients of one email: To = Reply-To when the email has one, else its sender (else its
 * To when the owner sent it); Cc = everyone else on its To/Cc. The owner is never a recipient.
 */
export function replyRecipients(meta: { from: unknown; to: unknown; cc: unknown; replyTo?: unknown }, self: readonly string[]): { to: string[]; cc: string[] } {
  const me = new Set(self.map(lc));
  const rt = mailboxes(meta.replyTo ?? "").map((b) => b.addr).filter((a) => !me.has(a));
  const from = mailboxes(meta.from)[0]?.addr ?? "";
  let to = rt.length ? rt : from && !me.has(from) ? [from] : mailboxes(meta.to).map((b) => b.addr).filter((a) => !me.has(a));
  to = [...new Set(to)];
  const cc = [...new Set([...mailboxes(meta.to), ...mailboxes(meta.cc)].map((b) => b.addr).filter((a) => !me.has(a) && !to.includes(a) && a !== from))];
  return { to, cc };
}

/** Reply (sender only) and Reply All (null when it adds nobody or passes the cap), as Mail offers them. */
export function replyOptions(meta: { from: unknown; to: unknown; cc: unknown; replyTo?: unknown; subject?: unknown }, self: readonly string[]):
  { reply: ReplyOption; replyAll: ReplyOption | null } {
  const { to, cc } = replyRecipients(meta, self);
  const subject = replySubject(s(meta.subject));
  const fits = to.length <= MAX_REPLY_RECIPIENTS && cc.length <= MAX_REPLY_RECIPIENTS;
  return { reply: { to, cc: [], subject }, replyAll: cc.length && fits ? { to, cc, subject } : null };
}

/** Every address on the thread's emails (From, Reply-To, To, Cc), lowercased: the only people a reply may go to. */
export function threadAddresses(conversationId: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare(`SELECT meta_json FROM comms_email_messages WHERE conversation_id = ?`).all(conversationId) as { meta_json: string }[]) {
    try {
      const m = JSON.parse(r.meta_json) as StoredMeta;
      for (const b of [...mailboxes(m.from), ...mailboxes(m.replyTo ?? ""), ...mailboxes(m.to), ...mailboxes(m.cc)]) out.add(b.addr);
    } catch { /* a corrupt row adds nobody */ }
  }
  return out;
}

export function replySubject(subject: string): string {
  const subj = subject.replace(/[\r\n\0]+/g, " ").trim();
  return /^re:/i.test(subj) ? subj : `Re: ${subj}`.trim();
}

/** The composer header for an email thread (Reply / Reply All), from the index. */
export function emailReplyPlan(source: EmailSource): ReplyPlanResult {
  const r = db.prepare(`SELECT note_id, meta_json FROM comms_email_messages WHERE conversation_id = ? AND is_self = 0 ORDER BY sent_at DESC, note_id DESC LIMIT 1`)
    .get(source.conversationId) as { note_id: string; meta_json: string } | undefined;
  if (!r) return { ok: false, reason: "no_inbound" };
  const meta = JSON.parse(r.meta_json) as StoredMeta;
  const account = sendingAccount();
  if (!meta.account || lc(meta.account) !== account) return { ok: false, reason: "account" };
  const o = replyOptions(meta, [account]);
  if (!o.reply.to.length) return { ok: false, reason: "no_inbound" };
  if (o.reply.to.length > MAX_REPLY_RECIPIENTS) return { ok: false, reason: "too_many_recipients" };
  return { ok: true, plan: { noteId: r.note_id, account, ...o } };
}

// ── production wiring + schedule ───────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inflight: Promise<unknown> | null = null;

/** One projection pass (single-flight). Never throws. */
export function refreshEmailProjection(deps: () => Promise<EmailProjectDeps | null>): Promise<unknown> {
  if (inflight) return inflight;
  inflight = (async () => {
    const d = await deps();
    if (!d) return null;
    const r = await projectEmail(d);
    console.log(`[comms] email projection: ${r.conversations} conversations, ${r.removed} removed, ${r.snippetsRead} previews read`);
    return r;
  })().catch((e) => {
    console.warn(`[comms] email projection failed (${e instanceof Error ? e.name : "error"})`);
    return null;
  }).finally(() => { inflight = null; });
  return inflight;
}

/** Start the periodic projection (COMMS_ENABLED + COMMS_EMAIL_ENABLED). */
export function startEmailProjection(deps: () => Promise<EmailProjectDeps | null>, everyMs = 3 * 60_000): void {
  if (!config.commsEnabled || !config.commsEmailEnabled || timer) return;
  void refreshEmailProjection(deps);
  timer = setInterval(() => void refreshEmailProjection(deps), everyMs);
  timer.unref();
}

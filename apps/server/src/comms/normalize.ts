// Raw Matrix timeline events (mautrix bridges) → the Comms `Message` wire model: one bubble
// per message with edits, reactions, redactions, replies, delivery status, link previews,
// attachments and system events folded in.
//
// Two-pass fold, O(n log n) in the page size:
//   1. index base events (messages, stickers, state changes worth a line) by event_id;
//   2. apply relations (m.replace, m.annotation, redactions, com.beeper.message_send_status)
//      in timestamp order onto those, or onto clones of `ctx.known`;
//   3. resolve reply snippets and thread counts against the folded result.
// A relation whose target is in neither goes to `pendingRelations`; the caller keeps it and
// passes it back in with the older page that holds the target. Re-applying is idempotent:
// a reaction is one per (key, sender), an edit only lands if it is the newest seen.
import { DEFAULT_AGENT_MATRIX_IDS, isBridgeBot, type MatrixEvent } from "../worker/matrix.js";
import { isAgentPuppet } from "./bridge-like.js";
import { displayNameFor } from "./naming.js";
import { fromMatrixContent, type RichText } from "./richtext.js";
import type { Network } from "./room-meta.js";
import type { Attachment, LinkPreview, Message, Reaction } from "./types.js";
import { clipText } from "./wire.js";

export interface NormalizeCtx {
  threadId: string;
  network: Network;
  selfIds: string[];
  agentIds: string[];
  /** The owner's own ids (the account + his stored bridge ghosts). Given, an agent id that is a
   *  bridge puppet and not one of these (Omni's Telegram bot) is shown as Omni, not as the owner. */
  ownerIds?: string[];
  names: Record<string, string>;
  avatars: Record<string, string | null>;
  known?: Map<string, Message>;
}

export interface NormalizeResult {
  /** Base events of this batch, newest-last. */
  messages: Message[];
  /** Relations whose target is not in this batch nor in ctx.known (input objects, unchanged). */
  pendingRelations: MatrixEvent[];
  /** Copies of ctx.known messages that a relation in this batch changed (ctx.known is never mutated). */
  updated: Message[];
}

const SNIPPET_CHARS = 120;
const MAX_LINK_PREVIEWS = 5;
const MAX_REACTION_KEY = 64;
const MAX_SYSTEM_TEXT = 500;
/** pendingRelations keeps at most this many (the newest); older ones are dropped. */
export const MAX_PENDING = 500;
const MAX_TS = 8.64e15; // the largest instant a Date can hold

/** origin_server_ts as a usable instant: a finite number in [0, MAX_TS], else 0. */
const tsOf = (e: MatrixEvent): number => {
  const v = e.origin_server_ts;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), MAX_TS) : 0;
};
const iso = (ts: number) => new Date(ts).toISOString();
/** isBridgeBot calls string methods: only ever hand it a string. */
const isBridgeSender = (v: unknown): boolean => {
  const s = str(v);
  return !!s && isBridgeBot(s);
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** A wire integer (Swift decodes these fields as Int): finite, ≥ 0, rounded, safe; else none. */
const num = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  const r = Math.round(v);
  return Number.isSafeInteger(r) ? r : undefined;
};
/** Grapheme-safe cut, never a lone surrogate (wire.ts). */
const clip = (s: string, n: number) => clipText(s, n);

type Relation =
  | { kind: "edit"; target: string }
  | { kind: "reaction"; target: string; key: string }
  | { kind: "status"; target: string }
  | { kind: "redaction"; target: string };

function relationOf(e: MatrixEvent): Relation | "base" | null {
  const c = asRec(e.content) ?? {};
  const rel = asRec(c["m.relates_to"]);
  const target = str(rel?.event_id);
  switch (e.type) {
    case "m.room.redaction": {
      const t = str((e as Rec).redacts) ?? str(c.redacts);
      return t ? { kind: "redaction", target: t } : null;
    }
    case "m.reaction": {
      const key = str(rel?.key);
      return rel?.rel_type === "m.annotation" && target && key ? { kind: "reaction", target, key: clip(key, MAX_REACTION_KEY) } : null;
    }
    case "com.beeper.message_send_status":
      return target ? { kind: "status", target } : null;
    case "m.room.message":
      if (rel?.rel_type === "m.replace") return target && asRec(c["m.new_content"]) ? { kind: "edit", target } : null;
      return "base";
    case "m.room.encrypted":
      // An encrypted edit or reaction (relation in cleartext) is not a bubble; we cannot read it.
      if (rel?.rel_type === "m.replace" || rel?.rel_type === "m.annotation") return null;
      return "base";
    case "m.sticker":
    case "m.room.member":
    case "m.room.name":
    case "m.room.topic":
    case "m.room.avatar":
      return "base";
    default:
      return null;
  }
}

// ---------- content ----------

const MEDIA = new Map<string, Attachment["kind"]>([["m.image", "image"], ["m.video", "video"], ["m.audio", "audio"], ["m.file", "file"]]);

function attachmentOf(c: Rec, kind: Attachment["kind"]): Attachment {
  const info = asRec(c.info) ?? {};
  const a: Attachment = { kind };
  const mxc = str(c.url);
  if (mxc?.startsWith("mxc://")) a.mxc = mxc; // encrypted `file` media needs keys the proxy does not hold
  const mime = str(info.mimetype);
  if (mime) a.mime = mime;
  const size = num(info.size);
  if (size !== undefined) a.size = size;
  const w = num(info.w), h = num(info.h);
  if (w !== undefined) a.w = w;
  if (h !== undefined) a.h = h;
  const duration = num(info.duration) ?? num(asRec(c["org.matrix.msc1767.audio"])?.duration);
  if (duration !== undefined && (kind === "audio" || kind === "voice" || kind === "video")) a.durationMs = duration;
  return a;
}

function linkPreviewsOf(c: Rec): LinkPreview[] {
  const raw = c["com.beeper.linkpreviews"];
  if (!Array.isArray(raw)) return [];
  const out: LinkPreview[] = [];
  for (const item of raw) {
    if (out.length >= MAX_LINK_PREVIEWS) break;
    const p = asRec(item);
    const url = str(p?.["og:url"]) ?? str(p?.matched_url);
    if (!p || !url || !/^https?:\/\//i.test(url)) continue;
    const lp: LinkPreview = { url: clip(url, 2048) };
    const title = str(p["og:title"]), description = str(p["og:description"]), siteName = str(p["og:site_name"]), image = str(p["og:image"]);
    if (title) lp.title = clip(title, 300);
    if (description) lp.description = clip(description, 1000);
    if (siteName) lp.siteName = clip(siteName, 200);
    if (image?.startsWith("mxc://")) lp.imageMxc = image;
    out.push(lp);
  }
  return out;
}

/** Body, attachments and previews of message content (an original or an edit's m.new_content). */
function contentParts(c: Rec, type: string): { body: RichText | null; attachments: Attachment[]; linkPreviews: LinkPreview[] } {
  const linkPreviews = linkPreviewsOf(c);
  const msgtype = str(c.msgtype);
  const body = str(c.body);
  const mediaKind = type === "m.sticker" ? "sticker" : msgtype ? MEDIA.get(msgtype) : undefined;
  if (mediaKind) {
    const kind = mediaKind === "audio" && c["org.matrix.msc3245.voice"] !== undefined ? "voice" : mediaKind;
    const a = attachmentOf(c, kind);
    const filename = str(c.filename);
    // MSC2530: body is a caption only when a separate filename is given.
    const caption = filename && body && body !== filename && kind !== "sticker";
    const name = filename ?? body;
    if (name) a.name = clip(name, 255);
    return { body: caption ? fromMatrixContent(c) : null, attachments: [a], linkPreviews };
  }
  if (msgtype === "m.location") {
    const a: Attachment = { kind: "location" };
    const geo = str(c.geo_uri);
    if (geo?.startsWith("geo:")) a.geo = clip(geo, 200);
    if (body) a.name = clip(body, 255);
    return { body: null, attachments: [a], linkPreviews };
  }
  return { body: body !== undefined || str(c.formatted_body) ? fromMatrixContent(c) : null, attachments: [], linkPreviews };
}

/** Who a quote quotes (server-only, present only when true; timeline.replyOut names them). */
const quotedFlags = (t: Message): { senderSelf?: true; senderOmni?: true } => ({
  ...(t.sender.isSelf ? { senderSelf: true as const } : {}),
  ...(t.sender.isOmni ? { senderOmni: true as const } : {}),
});

// ---------- the fold ----------

export function normalizeEvents(events: MatrixEvent[], ctx: NormalizeCtx): NormalizeResult {
  const self = new Set(ctx.selfIds.map((s) => s.toLowerCase()));
  const agents = new Set(ctx.agentIds.map((s) => s.toLowerCase()));
  const omni = new Set(DEFAULT_AGENT_MATRIX_IDS.map((s) => s.toLowerCase()));
  // Own keys only: an id like "constructor" or "__proto__" must not reach the prototype.
  const own = <T>(r: Record<string, T>, id: string): T | undefined => (Object.hasOwn(r, id) ? r[id] : undefined);
  // Every name (sender, reactor, actor of a system line) goes through the naming filter.
  const nameOf = (id: string) => {
    const n = own(ctx.names, id);
    return displayNameFor(typeof n === "string" ? n : null, id);
  };
  const omniPuppet = (lower: string) => !!ctx.ownerIds && isAgentPuppet(lower, ctx.agentIds, ctx.ownerIds);
  const senderOf = (id: string): Message["sender"] => {
    const lower = id.toLowerCase();
    const avatar = own(ctx.avatars, id);
    return {
      id,
      name: nameOf(id),
      avatar: typeof avatar === "string" && avatar ? { mxc: avatar } : null,
      // Omni's bridge puppets (OMNI_AGENT_MATRIX_IDS, e.g. its Telegram bot) speak as Omni on the
      // other side of the chat: incoming, isOmni — never the owner's outgoing bubbles.
      isSelf: !omniPuppet(lower) && (self.has(lower) || agents.has(lower) || omni.has(lower)),
      isOmni: omni.has(lower) || omniPuppet(lower),
    };
  };

  // Pass 0: dedupe and split.
  const seen = new Set<string>();
  const bases: { e: MatrixEvent; i: number }[] = [];
  const relations: { e: MatrixEvent; i: number; r: Relation; synthetic: boolean }[] = [];
  const redacted = new Set<string>(); // ids redacted by a redaction in this batch
  const take = (e: MatrixEvent, i: number, synthetic: boolean) => {
    if (!asRec(e) || !str(e.event_id) || seen.has(e.event_id!)) return;
    seen.add(e.event_id!);
    const r = relationOf(e);
    if (r === "base") bases.push({ e, i });
    else if (r) {
      relations.push({ e, i, r, synthetic });
      if (r.kind === "redaction") redacted.add(r.target);
    }
  };
  events.forEach((e, i) => take(e, i, false));
  // Server-bundled latest edits (unsigned["m.relations"]["m.replace"]) count like the edit event itself.
  for (const { e, i } of [...bases]) {
    const bundled = asRec(asRec(asRec(e.unsigned)?.["m.relations"])?.["m.replace"]);
    if (bundled && str(bundled.sender) && asRec(bundled.content)) take({ type: "m.room.message", ...bundled } as MatrixEvent, i, true);
  }
  const byTime = (a: { e: MatrixEvent; i: number }, b: { e: MatrixEvent; i: number }) =>
    tsOf(a.e) - tsOf(b.e) || a.i - b.i;
  bases.sort(byTime);
  relations.sort(byTime);

  // Pass 1: base events.
  const local = new Map<string, Message>();
  const replyTargets = new Map<string, string>();
  const threadCounts = new Map<string, number>();
  const ordered: Message[] = [];
  for (const { e } of bases) {
    const m = baseMessage(e, ctx, senderOf, nameOf);
    if (!m) continue;
    const c = asRec(e.content) ?? {};
    const rel = asRec(c["m.relates_to"]);
    if (rel?.rel_type === "m.thread" && str(rel.event_id)) {
      m.threadRoot = rel.event_id as string;
      threadCounts.set(m.threadRoot, (threadCounts.get(m.threadRoot) ?? 0) + 1);
    }
    const replyTo = str(asRec(rel?.["m.in_reply_to"])?.event_id);
    if (replyTo && !(rel?.rel_type === "m.thread" && rel.is_falling_back === true)) replyTargets.set(m.id, replyTo);
    const bundledThreads = num(asRec(asRec(asRec(e.unsigned)?.["m.relations"])?.["m.thread"])?.count);
    if (bundledThreads) m.replyCount = bundledThreads;
    if (redacted.has(m.id) || asRec(e.unsigned)?.redacted_because) tombstone(m);
    local.set(m.id, m);
    ordered.push(m);
  }

  // Pass 2: relations.
  const updated = new Map<string, Message>();
  const pending: MatrixEvent[] = [];
  const reactionOwner = new Map<string, string>(); // reaction event id → message id (this batch)
  let knownReactions: Map<string, string> | null = null; // same, over ctx.known (built on demand)
  const target = (id: string): Message | undefined => {
    const m = local.get(id) ?? updated.get(id);
    if (m) return m;
    const k = ctx.known?.get(id);
    if (!k) return undefined;
    const copy = structuredClone(k);
    updated.set(id, copy);
    return copy;
  };
  for (const { e, r, synthetic } of relations) {
    if (redacted.has(e.event_id!)) continue; // a relation (or redaction) undone within the batch
    if (r.kind === "redaction") {
      const m = target(r.target);
      if (m) {
        tombstone(m);
        continue;
      }
      const owner = reactionOwner.get(r.target) ?? (knownReactions ??= indexKnownReactions(ctx.known)).get(r.target);
      const om = owner ? target(owner) : undefined;
      if (om) {
        removeReaction(om, r.target, (id) => senderOf(id).isSelf);
        continue;
      }
      if (!seen.has(r.target)) pending.push(e); // else: a relation of this batch, already undone

      continue;
    }
    const m = target(r.target);
    if (!m) {
      if (!synthetic && !seen.has(r.target)) pending.push(e);
      continue;
    }
    if (m.redacted) continue;
    const ts = tsOf(e);
    const c = asRec(e.content) ?? {};
    if (r.kind === "edit") {
      if (e.sender !== m.sender.id || m.system) continue; // only the author edits; never a state line
      if (m.editedAt && Date.parse(m.editedAt) > ts) continue;
      const parts = contentParts(asRec(c["m.new_content"])!, m.attachments[0]?.kind === "sticker" ? "m.sticker" : "m.room.message");
      m.body = parts.body;
      m.attachments = parts.attachments;
      m.linkPreviews = parts.linkPreviews;
      m.editedAt = iso(ts);
    } else if (r.kind === "reaction") {
      const sender = str(e.sender);
      if (!sender) continue;
      addReaction(m, r.key, sender, e.event_id!, nameOf(sender), senderOf(sender).isSelf);
      reactionOwner.set(e.event_id!, m.id);
    } else if (isBridgeSender(e.sender) && m.sender.isSelf) {
      // Send status is the bridge's word about the owner's own message; anyone else's is spoofing.
      applyStatus(m, c);
    }
  }

  // Pass 3: replies and thread counts against the folded result.
  for (const m of ordered) {
    const t = replyTargets.get(m.id);
    if (t && !m.redacted) {
      const target = local.get(t) ?? updated.get(t) ?? ctx.known?.get(t);
      m.replyTo = { messageId: t, snippet: target ? snippetOf(target) : "", senderName: target ? target.sender.name : "",
        ...(target ? quotedFlags(target) : {}) };
    }
    const n = threadCounts.get(m.id);
    if (n) m.replyCount = Math.max(m.replyCount ?? 0, n);
  }

  // Replies already known whose target was not loaded then (senderName "") but is now in this batch.
  if (ctx.known && local.size) {
    const waiting = new Map<string, string[]>(); // reply target → known reply ids (one pass over known)
    for (const k of ctx.known.values()) {
      const t = k.replyTo?.messageId;
      if (t && !k.replyTo!.senderName && local.has(t)) (waiting.get(t) ?? waiting.set(t, []).get(t)!).push(k.id);
    }
    for (const [t, ids] of waiting) {
      const tm = local.get(t)!;
      for (const id of ids) {
        if (local.has(id)) continue; // re-fetched in this batch: already resolved above
        const m = target(id)!;
        if (m.replyTo && !m.redacted) m.replyTo = { messageId: t, snippet: snippetOf(tm), senderName: tm.sender.name, ...quotedFlags(tm) };
      }
    }
  }

  // A relation that turned out a no-op (forged edit, re-applied reaction) is not an update.
  const changed = [...updated.values()].filter((m) => JSON.stringify(m) !== JSON.stringify(ctx.known?.get(m.id)));
  return { messages: ordered, pendingRelations: pending.length > MAX_PENDING ? pending.slice(-MAX_PENDING) : pending, updated: changed };
}

function baseMessage(
  e: MatrixEvent,
  ctx: NormalizeCtx,
  senderOf: (id: string) => Message["sender"],
  nameOf: (id: string) => string,
): Message | null {
  const sender = str(e.sender);
  if (!sender) return null;
  const type = e.type!;
  const c = asRec(e.content) ?? {};
  const s = senderOf(sender);
  const m: Message = {
    id: e.event_id!,
    threadId: ctx.threadId,
    channel: { network: ctx.network, accountLabel: null },
    source: { network: ctx.network, eventId: e.event_id!, ref: e.event_id! },
    sender: s,
    sentAt: iso(tsOf(e)),
    body: null,
    attachments: [],
    linkPreviews: [],
    reactions: [],
    delivery: s.isSelf ? "sent" : null,
    ...(s.isSelf && typeof asRec(e.unsigned)?.transaction_id === "string" && /^comms-[0-9a-f]{32}$/.test(asRec(e.unsigned)!.transaction_id as string)
      ? { sendTxn: asRec(e.unsigned)!.transaction_id as string } : {}),
    redacted: false,
  };
  if (type === "m.room.message" || type === "m.sticker") {
    if (type === "m.room.message" && c.msgtype === "m.notice" && isBridgeBot(sender)) {
      const text = fromMatrixContent(c).plain;
      m.system = { kind: "bridge", text: clip(text, MAX_SYSTEM_TEXT) };
      m.delivery = null;
      return text ? m : null;
    }
    Object.assign(m, contentParts(c, type));
    return m;
  }
  if (type === "m.room.encrypted") {
    m.system = { kind: "undecryptable", text: "This message could not be decrypted" };
    return m;
  }
  const text = systemText(e, sender, nameOf);
  if (!text) return null;
  m.system = { kind: type.slice("m.room.".length), text: clip(text, MAX_SYSTEM_TEXT) };
  m.delivery = null;
  return m;
}

function systemText(e: MatrixEvent, sender: string, nameOf: (id: string) => string): string | null {
  const c = asRec(e.content) ?? {};
  if (typeof e.state_key !== "string") return null;
  const actor = nameOf(sender);
  switch (e.type) {
    case "m.room.member": {
      const who = e.state_key;
      if (!who) return null;
      const own = who === sender ? str(c.displayname) : undefined;
      const whoName = own ? displayNameFor(own, who) : nameOf(who);
      const prev = str(asRec(asRec(e.unsigned as unknown)?.prev_content)?.membership);
      switch (c.membership) {
        case "join":
          return prev === "join" ? null : `${whoName} joined`; // join→join is a profile change
        case "invite":
          return `${actor} invited ${whoName}`;
        case "leave":
          if (who === sender) return prev === "invite" ? `${whoName} declined the invitation` : `${whoName} left`;
          return prev === "ban" ? `${actor} unbanned ${whoName}` : `${actor} removed ${whoName}`;
        case "ban":
          return `${actor} banned ${whoName}`;
        default:
          return null;
      }
    }
    case "m.room.name": {
      const name = str(c.name)?.trim();
      return name ? `${actor} named the conversation “${clip(name, 200)}”` : `${actor} removed the conversation name`;
    }
    case "m.room.topic": {
      const topic = str(c.topic)?.trim();
      return topic ? `${actor} changed the topic to “${clip(topic, 300)}”` : `${actor} removed the topic`;
    }
    case "m.room.avatar":
      return str(c.url) ? `${actor} changed the conversation photo` : `${actor} removed the conversation photo`;
    default:
      return null;
  }
}

function tombstone(m: Message): void {
  m.redacted = true;
  m.body = null;
  m.attachments = [];
  m.linkPreviews = [];
  m.reactions = [];
  delete m.replyTo;
  delete m.system;
  delete m.editedAt;
}

function addReaction(m: Message, key: string, sender: string, eventId: string, name: string, mine: boolean): void {
  let r = m.reactions.find((x) => x.key === key);
  if (!r) {
    r = { key, count: 0, mine: false, senders: [] };
    m.reactions.push(r);
  }
  if (r.senders.some((s) => s.id === sender)) return; // one per (key, sender): re-application is a no-op
  r.senders.push({ id: sender, name, eventId });
  r.count = r.senders.length;
  r.mine ||= mine;
}

function removeReaction(m: Message, eventId: string, isSelf: (id: string) => boolean): void {
  for (const r of m.reactions) {
    const i = r.senders.findIndex((s) => s.eventId === eventId);
    if (i < 0) continue;
    r.senders.splice(i, 1);
    r.count = r.senders.length;
    r.mine = r.senders.some((s) => isSelf(s.id));
  }
  m.reactions = m.reactions.filter((r) => r.count > 0);
}

function indexKnownReactions(known: Map<string, Message> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of known?.values() ?? []) for (const r of m.reactions) for (const s of r.senders) if (s.eventId) out.set(s.eventId, m.id);
  return out;
}

function applyStatus(m: Message, c: Rec): void {
  const status = str(c.status);
  // Monotonic (Task 8): once delivered (a bridgev2 delivery receipt = SUCCESS with
  // delivered_to_users, portal.go handleRemoteDeliveryReceipt) a later plain SUCCESS, a late
  // PENDING / RETRIABLE or FAIL for an earlier attempt never moves the message back.
  const delivered = m.delivery === "delivered" || m.delivery === "read";
  if (status === "SUCCESS") {
    if (delivered) return;
    m.delivery = Array.isArray(c.delivered_to_users) && c.delivered_to_users.length > 0 ? "delivered" : "sent";
    delete m.deliveryError;
  } else if (delivered) {
    return;
  } else if (status === "FAIL") {
    m.delivery = "failed";
    m.deliveryError = clip(str(c.message) ?? str(c.reason) ?? "Not delivered", 300);
  } else if (status === "PENDING" || status === "RETRIABLE") {
    m.delivery = "pending";
    delete m.deliveryError;
  }
}

const ATTACHMENT_LABEL: Record<Attachment["kind"], string> = {
  image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", file: "File", sticker: "Sticker", location: "Location",
};

function snippetOf(m: Message): string {
  if (m.redacted) return "";
  const plain = m.body?.plain.trim();
  if (plain) return clipText(plain, SNIPPET_CHARS);
  const a = m.attachments[0];
  return a ? (a.kind === "file" && a.name ? a.name : ATTACHMENT_LABEL[a.kind]) : clipText(m.system?.text ?? "", SNIPPET_CHARS);
}

// POST /api/comms/threads/:id/messages      {clientId, text, replyTo?, mentions?, channel?}   (JSON)
//      mentions: [{userId, start, length}] (UTF-16 ranges of `text`; bridged groups that declare
//      `capabilities.mentions`), channel: {network, accountLabel?} (the composer's pick).
// POST /api/comms/threads/:id/attachments   clientId, kind, durationMs?, waveform?, w?, h?,
//                                            channel? (JSON), file, thumbnail?    (multipart)
// → 200 {clientId, eventId, status:"sent"}; errors {error, message[, maybeSent]}.
// The gates and their order are documented in comms/send.ts. Mounted in routes/comms.ts, so the
// COMMS_ENABLED 404 and the comms-native client scope (middleware/client-scope.ts: /api/comms/
// is allowed, /api/comms/admin is not) apply unchanged.
import { chooseTopic, resolveThreadRedirect, threadAndImpliedTopic } from "../comms/forums";
import type { Context } from "hono";
import { config } from "../config";
import { requireCommsOwner } from "../comms/guard";
import { loadMatrixCreds } from "../actions/matrix";
import { consumeRateLimit } from "../middleware/ratelimit";
import { actionOrigin, readCapped } from "./actions";
import {
  SendError, auditSend, capabilitiesBody, resolveSendTarget, commsSendEnabled, maxAttachmentBytes, requestHashOf, sendToThread,
  validateChannel, validateClientId, validateMentions, validateReplyTo, validateText, type ChannelPick, type Mention, type SendRequest, type UploadPart,
} from "../comms/send";
import { addReaction, removeReaction, validateKey, validateMessageId } from "../comms/react";
import { ATTACHMENT_KINDS, MediaRefusal, classifyAttachment, classifyThumbnail, type AttachmentKind } from "../comms/send-media";
import { createHash } from "node:crypto";
import { bbThreadSource } from "../bluebubbles/project";
import { parseHandle, startConversation, type Handle, type StartNetwork } from "../comms/conversations";
import { threadOut } from "../comms/timeline";
import { emailThreadSource } from "../comms/email";
import { sendNewEmail, validateEcho, type EmailEcho } from "../comms/email-send";
import { emailSendEnabled } from "../comms/send-policy";
import { normalizeFilenameStar } from "../comms/multipart";

const MAX_JSON_BYTES = 64 * 1024;
/** Multipart overhead allowed above the file cap (fields, boundaries, a thumbnail). */
const MULTIPART_SLACK = 2 * 1024 * 1024;
const THUMB_MAX = 1024 * 1024;
const MAX_DURATION_MS = 24 * 3_600_000;

const err = (c: Context, e: SendError) => c.json(e.body(), e.status);

type Gate = { ok: true; g: { actor: { email: string; deviceId?: string }; vaultId: string }; via: string } | { ok: false; res: Response };

/** Gates 1–4 (comms/send.ts header). */
type Bucket = { action: string; rate: (email: string) => { key: string; max: number; windowMs: number } };
const SEND_BUCKET: Bucket = {
  action: "comms.send",
  rate: (email) => ({ key: `comms-send:${email}`, max: config.commsSendPer10Min, windowMs: 10 * 60_000 }),
};
/** Reactions spend the live-actions `matrix-react` budget (routes/actions.ts: 120 / 10 min). */
const REACT_BUCKET = (action: string): Bucket => ({
  action,
  rate: (email) => ({ key: `actions:matrix-react:${email}`, max: 120, windowMs: 10 * 60_000 }),
});

function gates(c: Context, bucket: Bucket = SEND_BUCKET): Gate {
  const g = requireCommsOwner(c);
  if (!g.ok) return { ok: false, res: g.res };
  const { via, origin } = actionOrigin(c);
  const base = { actor: g.actor, via, origin, vaultId: g.vaultId, clientId: "", action: bucket.action };
  const route = c.req.path.endsWith("/attachments") ? "attachments" : c.req.path.includes("/reactions") ? "reactions" : c.req.path.endsWith("/conversations") ? "conversations" : "messages";
  if (!commsSendEnabled()) {
    auditSend(base, { route }, "refused", "send_disabled");
    return { ok: false, res: err(c, new SendError(403, "send_disabled", "Sending is turned off on this server.")) };
  }
  if (origin !== "human" || via !== "device") {
    auditSend(base, { route }, "refused", "device_required");
    return { ok: false, res: err(c, new SendError(403, "device_required", "Sending needs the owner's signed-in device (the Comms app).")) };
  }
  const rl = bucket.rate(g.actor.email);
  const retry = consumeRateLimit(rl.key, rl.max, rl.windowMs);
  if (retry !== null) {
    auditSend(base, { route }, "refused", "rate_limited");
    c.header("Retry-After", String(retry));
    return { ok: false, res: err(c, new SendError(429, "rate_limited", "Too many messages at once. Wait a moment and try again.")) };
  }
  return { ok: true, g, via };
}

async function run(c: Context, r: SendRequest): Promise<Response> {
  try {
    const out = await sendToThread(r);
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(out.body, 200);
  } catch (e) {
    if (e instanceof SendError) return err(c, e);
    // Never a bare 500: the pipeline's own bookkeeping is guarded, so an unexpected throw here is
    // a bug at an unknown point — possibly after the PUT. Tell the client it may have been sent
    // (it must not resend under a new clientId; Try Again with the same one is safe).
    console.error(`[comms] send failed unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return err(c, new SendError(502, "send_failed", "Something went wrong on the server; the message may have been sent. Try again to make sure (it won't be sent twice).", true));
  }
}

export async function postMessage(c: Context): Promise<Response> {
  const gate = gates(c);
  if (!gate.ok) return gate.res;
  const { g, via } = gate;
  const base = { actor: g.actor, via, vaultId: g.vaultId, clientId: "" };
  const bad = (e: SendError) => {
    auditSend(base, { route: "messages" }, "refused", e.code);
    return err(c, e);
  };
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return bad(new SendError(415, "unsupported_type", "Send the message as application/json."));
  const raw = await readCapped(c.req.raw, MAX_JSON_BYTES);
  if (raw === null) return bad(new SendError(413, "too_large", "The message is too long."));
  let body: Record<string, unknown>;
  try {
    const v = JSON.parse(raw || "null") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    body = v as Record<string, unknown>;
  } catch {
    return bad(new SendError(422, "invalid", "A JSON object body is required."));
  }
  let clientId: string, text: string, replyTo: string | null, mentions: Mention[], channel: ChannelPick | null, email: EmailEcho | null, topic: string | null;
  try {
    const known = new Set(["clientId", "text", "replyTo", "mentions", "channel", "email", "topic"]);
    if (Object.keys(body).some((k) => !known.has(k))) throw new SendError(422, "invalid", "Unknown field in the message.");
    clientId = validateClientId(body.clientId);
    // iMessage/SMS threads and email have no bridge: "!…" is ordinary text there.
    const tid = resolveThreadRedirect(c.req.param("id")!);
    text = validateText(body.text, { bridged: !bbThreadSource(tid) && !emailThreadSource(tid) });
    replyTo = validateReplyTo(body.replyTo);
    email = validateEcho(body.email);
    mentions = validateMentions(text, body.mentions);
    channel = validateChannel(body.channel);
    topic = validateTopic(body.topic);
  } catch (e) {
    if (e instanceof SendError) return bad(e);
    throw e;
  }
  const rawId = c.req.param("id")!;
  const { threadId, impliedTopic } = threadAndImpliedTopic(rawId);
  const chosen = chooseTopic(threadId, topic, impliedTopic);
  if (chosen.mismatch) return bad(topicMismatch());
  return run(c, {
    actor: g.actor, via, vaultId: g.vaultId, threadId, clientId,
    // mentions / channel / email join the hash only when given: an older client's retry keeps its hash.
    // The thread as the CLIENT named it: a send in flight across the forum migration (an old
    // per-topic id) replays instead of being refused as another message (review m6).
    requestHash: requestHashOf({ route: "messages", threadId: rawId, text, replyTo, ...(email ? { email } : {}), ...(mentions.length ? { mentions } : {}), ...(channel ? { channel } : {}), ...(topic ? { topic } : {}) }),
    creds: loadMatrixCreds(g.vaultId),
    text: { body: text, replyTo, mentions },
    ...(email ? { email } : {}),
    channel,
    topic: chosen.topic,
  });
}

/** 409 topic_mismatch: the declared topic is not the one the request otherwise names. */
const topicMismatch = () => new SendError(409, "topic_mismatch", "That topic isn't the one this conversation was opened on. Nothing was sent.");

/** A Telegram forum topic (comms/forums.ts): absent / null = none named; else an opaque id. */
function validateTopic(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new SendError(422, "invalid", "topic is not a topic id.");
  return v;
}

const FIELDS = new Set(["clientId", "kind", "durationMs", "waveform", "w", "h", "channel", "file", "thumbnail"]);

function channelField(v: FormDataEntryValue | null): ChannelPick | null {
  if (v === null) return null;
  let parsed: unknown;
  try {
    if (typeof v !== "string" || v.length > 300) throw new Error("shape");
    parsed = JSON.parse(v);
  } catch {
    throw invalidUpload("channel_invalid", "channel must be {network, accountLabel?}.");
  }
  return validateChannel(parsed);
}

/** A 422 that also names WHY (a fixed reason code: audited and logged, never content). */
function invalidUpload(reason: string, message: string): SendError {
  return Object.assign(new SendError(422, "invalid", message), { reason });
}
const reasonOf = (e: SendError): string => (e as SendError & { reason?: string }).reason ?? e.code;

function intField(v: FormDataEntryValue | null, name: string, max: number): number | null {
  if (v === null) return null;
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v) || Number(v) > max) throw invalidUpload(`${name}_invalid`, `${name} must be a whole number from 0 to ${max}.`);
  return Number(v);
}

function waveformField(v: FormDataEntryValue | null): number[] | null {
  if (v === null) return null;
  let arr: unknown;
  try {
    if (typeof v !== "string" || v.length > 8_000) throw new Error("shape");
    arr = JSON.parse(v);
  } catch {
    throw invalidUpload("waveform_invalid", "waveform must be a JSON array of whole numbers.");
  }
  if (!Array.isArray(arr) || arr.length > 200 || arr.some((x) => !Number.isInteger(x) || x < 0 || x > 1024)) {
    throw invalidUpload("waveform_invalid", "waveform must be at most 200 whole numbers from 0 to 1024.");
  }
  return arr as number[];
}

export async function postAttachment(c: Context): Promise<Response> {
  const gate = gates(c);
  if (!gate.ok) return gate.res;
  const { g, via } = gate;
  const base = { actor: g.actor, via, vaultId: g.vaultId, clientId: "" };
  const bad = (e: SendError) => {
    const reason = reasonOf(e);
    auditSend(base, { route: "attachments", reason }, "refused", e.code);
    // Diagnosable without content: the status, the code and a fixed reason — never a name or byte.
    if (e.status === 422 || e.status === 415 || e.status === 413) console.warn(`[comms] attachment refused: ${e.status} ${e.code} (${reason})`);
    return err(c, e);
  };
  const ctHeader = c.req.header("content-type") ?? "";
  if (ctHeader.split(";")[0]!.trim().toLowerCase() !== "multipart/form-data") return bad(new SendError(415, "unsupported_type", "Send the attachment as multipart/form-data."));
  const { threadId, impliedTopic } = threadAndImpliedTopic(c.req.param("id")!);
  // The thread / network / encryption / attachments checks need no body: answer them BEFORE
  // reading (and buffering) up to 50 MB. sendToThread repeats them (and audits).
  let topic: string | null;
  try {
    const chosen = chooseTopic(threadId, validateTopic(c.req.query("topic")), impliedTopic);
    if (chosen.mismatch) throw topicMismatch();
    topic = chosen.topic;
    resolveSendTarget(threadId, { attachment: true }, topic);
  } catch (e) {
    if (e instanceof SendError) return bad(e);
    throw e;
  }
  // At most UPLOADS_IN_FLIGHT uploads per owner at once (each is buffered while parsed).
  const slot = `${g.actor.email}`;
  if ((inFlight.get(slot) ?? 0) >= UPLOADS_IN_FLIGHT) {
    c.header("Retry-After", "5");
    return bad(new SendError(429, "busy", "Other attachments are still uploading. Try again in a moment."));
  }
  inFlight.set(slot, (inFlight.get(slot) ?? 0) + 1);
  try {
    return await receiveAttachment(c, g, via, threadId, ctHeader, bad, topic);
  } finally {
    const n = (inFlight.get(slot) ?? 1) - 1;
    if (n > 0) inFlight.set(slot, n);
    else inFlight.delete(slot);
  }
}

const UPLOADS_IN_FLIGHT = 3;
const inFlight = new Map<string, number>();

async function receiveAttachment(
  c: Context, g: { actor: { email: string; deviceId?: string }; vaultId: string }, via: string, threadId: string, ctHeader: string,
  bad: (e: SendError) => Response, topic: string | null = null,
): Promise<Response> {

  // The cap: config (lowered by the homeserver's limit when known). Checked on the declared
  // length before anything is read, then while streaming — the body is never buffered past it.
  const creds = loadMatrixCreds(g.vaultId);
  // iMessage/SMS go to BlueBubbles, not the homeserver: the config cap only.
  const max = bbThreadSource(threadId) ? config.commsSendMaxBytes : await maxAttachmentBytes(creds);
  let raw = await readCappedBytes(c.req.raw, max + MULTIPART_SLACK);
  if (raw === null) return bad(new SendError(413, "too_large", `Attachments can be at most ${Math.floor(max / (1024 * 1024))} MB.`));

  const parse = (body: Buffer) => new Request("http://comms.invalid/", { method: "POST", headers: { "content-type": ctHeader }, body }).formData();
  let form: FormData;
  try {
    form = await parse(raw);
  } catch {
    // undici refuses a part header with an RFC 5987 `filename*` (Comms ≤ 0.2.x sends one for
    // every non-ASCII file name): fold it into `filename` and read the body once more.
    const fixed = normalizeFilenameStar(raw, ctHeader);
    try {
      if (fixed === raw) throw new Error("unchanged");
      form = await parse(fixed);
    } catch {
      return bad(invalidUpload("multipart_unreadable", "The upload could not be read. Try attaching the file again."));
    }
  }
  raw = null; // the parsed parts hold the bytes now; drop the raw copy early
  let clientId: string, kind: AttachmentKind, durationMs: number | null, waveform: number[] | null, w: number | null, h: number | null;
  let file: UploadPart, thumbnail: UploadPart | null = null, channel: ChannelPick | null;
  try {
    const keys: string[] = [];
    form.forEach((_v, k) => keys.push(k));
    if (keys.some((k) => !FIELDS.has(k)) || new Set(keys).size !== keys.length) throw invalidUpload("unknown_or_repeated_field", "Unknown or repeated field in the upload.");
    try { clientId = validateClientId(form.get("clientId")); } catch (e) { throw e instanceof SendError ? Object.assign(e, { reason: "client_id_invalid" }) : e; }
    const k = form.get("kind");
    if (typeof k !== "string" || !ATTACHMENT_KINDS.has(k)) throw invalidUpload("kind_invalid", "kind must be image, video, file or voice.");
    kind = k as AttachmentKind;
    durationMs = intField(form.get("durationMs"), "durationMs", MAX_DURATION_MS);
    waveform = waveformField(form.get("waveform"));
    w = intField(form.get("w"), "w", 65_535);
    h = intField(form.get("h"), "h", 65_535);
    channel = channelField(form.get("channel"));
    if (durationMs !== null && kind !== "voice" && kind !== "video") throw invalidUpload("duration_kind", "durationMs is only for voice and video.");
    if (waveform !== null && kind !== "voice") throw invalidUpload("waveform_kind", "waveform is only for voice messages.");
    if ((w !== null || h !== null) && kind !== "image" && kind !== "video") throw invalidUpload("size_kind", "w and h are only for images and videos.");
    const f = form.get("file");
    if (!(f instanceof File)) throw invalidUpload("file_missing", "The file is missing.");
    if (f.size > max) throw new SendError(413, "too_large", `Attachments can be at most ${Math.floor(max / (1024 * 1024))} MB.`);
    const bytes = Buffer.from(await f.arrayBuffer());
    file = { bytes, facts: classifyAttachment(kind, bytes, f.name) };
    const t = form.get("thumbnail");
    if (t !== null) {
      if (!(t instanceof File) || (kind !== "image" && kind !== "video")) throw invalidUpload("thumbnail_invalid", "A thumbnail is only for images and videos.");
      if (t.size > THUMB_MAX) throw new SendError(413, "too_large", "The thumbnail is too large.");
      const tb = Buffer.from(await t.arrayBuffer());
      thumbnail = { bytes: tb, facts: { ...classifyThumbnail(tb), filename: "thumbnail" } };
    }
  } catch (e) {
    if (e instanceof SendError) return bad(e);
    if (e instanceof MediaRefusal) return bad(Object.assign(new SendError(415, "unsupported_type", `This file can't be sent: ${e.message}.`), { reason: "media_refused" }));
    throw e;
  }
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return run(c, {
    actor: g.actor, via, vaultId: g.vaultId, threadId, clientId, creds,
    requestHash: requestHashOf({
      route: "attachments", threadId, kind, durationMs, waveform, w, h,
      file: sha(file.bytes), name: file.facts.filename, thumbnail: thumbnail ? sha(thumbnail.bytes) : null,
      ...(channel ? { channel } : {}),
      ...(topic ? { topic } : {}),
    }),
    attachment: { kind, file, thumbnail, durationMs, waveform, w, h },
    channel,
    topic,
  });
}

/** Like readCapped, for bytes. Null once the body passes `max`. */
async function readCappedBytes(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** GET /api/comms/capabilities (same body as /api/integrations/comms/capabilities). */
export async function getCapabilities(c: Context): Promise<Response> {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  return c.json(await capabilitiesBody(loadMatrixCreds(g.vaultId)));
}

// ── reactions (comms/react.ts) ──────────────────────────────────────────────

/** POST /api/comms/threads/:id/messages/:messageId/reactions {clientId, key} */
export async function postReaction(c: Context): Promise<Response> {
  const gate = gates(c, REACT_BUCKET("comms.react"));
  if (!gate.ok) return gate.res;
  const { g, via } = gate;
  const base = { actor: g.actor, via, vaultId: g.vaultId, clientId: "", action: "comms.react" };
  const bad = (e: SendError) => {
    auditSend(base, { route: "reactions" }, "refused", e.code);
    return err(c, e);
  };
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return bad(new SendError(415, "unsupported_type", "Send the reaction as application/json."));
  const raw = await readCapped(c.req.raw, 4 * 1024);
  if (raw === null) return bad(new SendError(413, "too_large", "The reaction is too large."));
  let clientId: string, key: string, messageId: string, topic: string | null;
  try {
    let body: Record<string, unknown>;
    try {
      const v = JSON.parse(raw || "null") as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
      body = v as Record<string, unknown>;
    } catch {
      throw new SendError(422, "invalid", "A JSON object body is required.");
    }
    if (Object.keys(body).some((k) => k !== "clientId" && k !== "key" && k !== "topic")) throw new SendError(422, "invalid", "Unknown field in the reaction.");
    clientId = validateClientId(body.clientId);
    topic = validateTopic(body.topic);
    key = validateKey(body.key);
    messageId = validateMessageId(c.req.param("messageId"));
  } catch (e) {
    if (e instanceof SendError) return bad(e);
    throw e;
  }
  const { threadId, impliedTopic } = threadAndImpliedTopic(c.req.param("id")!);
  const chosen = chooseTopic(threadId, topic, impliedTopic);
  if (chosen.mismatch) return bad(topicMismatch());
  topic = chosen.topic;
  try {
    const out = await addReaction({
      actor: g.actor, via, vaultId: g.vaultId, threadId, messageId, clientId, key, creds: loadMatrixCreds(g.vaultId), topic,
      requestHash: requestHashOf({ route: "reaction", threadId, messageId, key }),
    });
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(out.body, 200);
  } catch (e) {
    return unexpected(c, e, "reaction");
  }
}

/** DELETE /api/comms/threads/:id/messages/:messageId/reactions/:key */
export async function deleteReaction(c: Context): Promise<Response> {
  const gate = gates(c, REACT_BUCKET("comms.unreact"));
  if (!gate.ok) return gate.res;
  const { g, via } = gate;
  const base = { actor: g.actor, via, vaultId: g.vaultId, clientId: "", action: "comms.unreact" };
  let key: string, messageId: string, topic: string | null;
  try {
    topic = validateTopic(c.req.query("topic"));
    key = validateKey(c.req.param("key"));
    messageId = validateMessageId(c.req.param("messageId"));
  } catch (e) {
    if (e instanceof SendError) {
      auditSend(base, { route: "reactions" }, "refused", e.code);
      return err(c, e);
    }
    throw e;
  }
  try {
    const { threadId, impliedTopic } = threadAndImpliedTopic(c.req.param("id")!);
    const chosen = chooseTopic(threadId, topic, impliedTopic);
    if (chosen.mismatch) {
      auditSend(base, { route: "reactions" }, "refused", "topic_mismatch");
      return err(c, topicMismatch());
    }
    const out = await removeReaction({ actor: g.actor, via, vaultId: g.vaultId, threadId, messageId, key, creds: loadMatrixCreds(g.vaultId), topic: chosen.topic });
    return c.json({ status: out.status }, 200);
  } catch (e) {
    return unexpected(c, e, "reaction removal");
  }
}

/** SendError → its answer; anything else → 502 maybeSent:true (never a bare 500). */
function unexpected(c: Context, e: unknown, what: string): Response {
  if (e instanceof SendError) return err(c, e);
  console.error(`[comms] ${what} failed unexpectedly: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  return err(c, new SendError(502, "send_failed", "Something went wrong on the server; it may have gone through. Try again to make sure.", true));
}

// ── new conversations (comms/conversations.ts) ──────────────────────────────

const START_KEYS = new Set(["clientId", "handle", "network", "text", "subject"]);

/** POST /api/comms/conversations {clientId, handle, network: "imessage"|"sms", text} */
export async function postConversation(c: Context): Promise<Response> {
  const gate = gates(c);
  if (!gate.ok) return gate.res;
  const { g, via } = gate;
  const base = { actor: g.actor, via, vaultId: g.vaultId, clientId: "" };
  const bad = (e: SendError) => {
    auditSend(base, { route: "conversations" }, "refused", e.code);
    return err(c, e);
  };
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return bad(new SendError(415, "unsupported_type", "Send the message as application/json."));
  const raw = await readCapped(c.req.raw, MAX_JSON_BYTES);
  if (raw === null) return bad(new SendError(413, "too_large", "The message is too long."));
  let clientId: string, text: string, handle: Handle, network: StartNetwork;
  try {
    let body: Record<string, unknown>;
    try {
      const v = JSON.parse(raw || "null") as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("shape");
      body = v as Record<string, unknown>;
    } catch {
      throw new SendError(422, "invalid", "A JSON object body is required.");
    }
    if (Object.keys(body).some((k) => !START_KEYS.has(k))) throw new SendError(422, "invalid", "Unknown field in the message.");
    clientId = validateClientId(body.clientId);
    if (body.network === "email") return await postNewEmail(c, g, via, clientId, body, bad);
    if (body.subject !== undefined) throw new SendError(422, "invalid", "subject is only for email.");
    if (body.network !== "imessage" && body.network !== "sms") throw new SendError(422, "invalid", "network must be imessage, sms or email.");
    network = body.network;
    const h = parseHandle(body.handle);
    if (!h) throw new SendError(422, "invalid_handle", "Use a phone number with its country code (+1 …) or an email address.");
    if (network === "sms" && h.kind !== "phone") throw new SendError(422, "invalid_handle", "SMS needs a phone number.");
    handle = h;
    text = validateText(body.text, { bridged: false });
  } catch (e) {
    if (e instanceof SendError) return bad(e);
    throw e;
  }
  try {
    const out = await startConversation({
      actor: g.actor, via, vaultId: g.vaultId, clientId, handle, network, text,
      requestHash: requestHashOf({ route: "conversations", network, handle: handle.value, text }),
    });
    const thread = out.thread ? threadOut(out.thread, g.actor) : null;
    if (out.existing) return c.json({ existing: true, threadId: out.threadId, ...(thread ? { thread } : {}) }, 200);
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    // `handle` (review M6): a pending thread may land under another chat GUID than predicted; the
    // client can match the stream's thread.updated / re-ask /recipients?q=<handle> by it.
    return c.json({ existing: false, threadId: out.threadId, ...out.body, pending: out.pending, handle: { kind: handle.kind, value: handle.value }, ...(thread ? { thread } : {}) }, 200);
  } catch (e) {
    return unexpected(c, e, "new conversation");
  }
}

/** POST /api/comms/conversations {clientId, network:"email", handle:<address>, subject, text} (D11):
 *  a new email through the Omni approval executor (comms/email-send.ts). */
async function postNewEmail(
  c: Context, g: { actor: { email: string; deviceId?: string }; vaultId: string }, via: string, clientId: string, body: Record<string, unknown>,
  bad: (e: SendError) => Response,
): Promise<Response> {
  if (!emailSendEnabled()) return bad(new SendError(403, "send_disabled", "Sending email is turned off on this server."));
  const h = parseHandle(body.handle);
  if (!h || h.kind !== "email") return bad(new SendError(422, "invalid_handle", "Use an email address."));
  if (typeof body.subject !== "string" || !body.subject.trim() || body.subject.length > 998) return bad(new SendError(422, "invalid", "A new email needs a subject."));
  const text = validateText(body.text, { bridged: false });
  const subject = body.subject;
  const r = {
    actor: g.actor, via, vaultId: g.vaultId, threadId: "new-email", clientId, creds: null,
    requestHash: requestHashOf({ route: "conversations", network: "email", handle: h.value, subject, text }),
    text: { body: text, replyTo: null },
  };
  const target: Record<string, unknown> = { threadId: null, kind: "text", network: "email", route: "conversations" };
  try {
    const out = await sendNewEmail({ ...r, newEmail: { to: h.value, subject } }, target, (e, status = "refused") => {
      auditSend(r, target, status, e.code);
      throw e;
    });
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    const { getThread } = await import("../comms/store");
    const thread = out.threadId ? getThread(out.threadId) : null;
    return c.json({ existing: false, threadId: out.threadId ?? null, ...out.body, pending: false, handle: { kind: "email", value: h.value }, ...(thread ? { thread: threadOut(thread, g.actor) } : {}) }, 200);
  } catch (e) {
    return unexpected(c, e, "new email");
  }
}

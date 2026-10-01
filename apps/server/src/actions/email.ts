/**
 * Live email actions via Proton Mail Bridge (Arch v2 WP1.5).
 *
 * The account's mail is Proton (Bridge on loopback: IMAP 1143, SMTP 1025, both
 * STARTTLS with Bridge's self-signed cert) — there is no Gmail. Every action
 * uses the SAME `proton-bridge` credential the ingest uses (worker/proton.ts),
 * with the same guarantees:
 *   - the host must be loopback (the password never leaves the machine);
 *   - TLS is required (STARTTLS is demanded, or implicit TLS);
 *   - the server certificate's SHA-256 is compared with the pin AFTER the TLS
 *     handshake and BEFORE any AUTH/LOGIN — a mismatch closes the socket with
 *     zero credential bytes sent (SMTP: `smtpSend`, proved by a stub-server test;
 *     IMAP: `connectPinnedImap`, shared with the ingest).
 *
 * Messages are composed with nodemailer's MailComposer (RFC 5322 / MIME /
 * RFC 2047), but every header input is validated here first: no CR/LF/NUL in any
 * header field, plain addresses only, a recipient cap and size caps.
 *
 * Transports are injectable (`configureEmailActions`) — tests never reach Bridge.
 */
import crypto from "node:crypto";
import tls from "node:tls";
import { config } from "../config";
import { connectPinnedImap, isLoopbackHost, scrubProtonError, smtpSettingsOf, type ProtonCredential } from "../worker/proton";
import { addresses, messageIdOf, parseMime } from "../worker/proton-parse";

// ── limits + validation ─────────────────────────────────────────────────────

export const EMAIL_LIMITS = {
  maxRecipients: 20,
  maxSubject: 500,
  maxTextBytes: 200_000,
  maxHtmlBytes: 500_000,
  maxMessageIdLen: 500,
  maxReferences: 50,
} as const;

/** A validation failure: always BEFORE anything is sent. */
export class ActionInputError extends Error {
  readonly code = "bad_request";
}

/**
 * A transport failure. `sent: false` = provably nothing left the server for
 * this message (connect / TLS / pin / login / envelope refused) so the
 * idempotency key may be retried; `sent: "unknown"` = DATA may have been
 * transmitted, so the key is burned and replays the failure.
 */
export class ActionTransportError extends Error {
  constructor(
    message: string,
    readonly sent: false | "unknown",
  ) {
    super(message);
  }
}

const HEADER_BAD = /[\r\n\0]/;
export function assertHeaderSafe(field: string, v: string): void {
  if (HEADER_BAD.test(v)) throw new ActionInputError(`${field}: line breaks are not allowed`);
}

// Deliberately strict: a plain addr-spec, ASCII local part, no quoting/comments.
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function validateAddress(field: string, v: unknown): string {
  if (typeof v !== "string") throw new ActionInputError(`${field}: an email address is required`);
  assertHeaderSafe(field, v);
  const a = v.trim();
  if (a.length > 254 || !ADDRESS_RE.test(a)) throw new ActionInputError(`${field}: not a valid email address`);
  return a;
}

function addressList(field: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x, i) => validateAddress(`${field}[${i}]`, x));
}

/** Normalize one Message-ID to `<id>`; refuses anything header-unsafe. */
export function normalizeMessageId(field: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new ActionInputError(`${field}: a Message-ID is required`);
  assertHeaderSafe(field, v);
  const id = v.trim().replace(/^<|>$/g, "");
  if (!id || id.length > EMAIL_LIMITS.maxMessageIdLen || !/^[\x21-\x7e]+$/.test(id) || /[<>]/.test(id)) {
    throw new ActionInputError(`${field}: not a valid Message-ID`);
  }
  return `<${id}>`;
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

export interface SendInput {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

/** Validate a `send` body (also the core of `reply`). Throws ActionInputError. */
export function validateSendInput(b: Record<string, unknown>): SendInput {
  const to = addressList("to", b.to);
  const cc = addressList("cc", b.cc);
  if (!to.length) throw new ActionInputError("to: at least one recipient is required");
  if (to.length + cc.length > EMAIL_LIMITS.maxRecipients) throw new ActionInputError(`too many recipients (max ${EMAIL_LIMITS.maxRecipients})`);
  if (b.bcc !== undefined) throw new ActionInputError("bcc is not supported");
  const subject = typeof b.subject === "string" ? b.subject : "";
  assertHeaderSafe("subject", subject);
  if (subject.length > EMAIL_LIMITS.maxSubject) throw new ActionInputError(`subject: too long (max ${EMAIL_LIMITS.maxSubject})`);
  const text = typeof b.body === "string" ? b.body : "";
  if (!text.trim()) throw new ActionInputError("body: required");
  if (byteLen(text) > EMAIL_LIMITS.maxTextBytes) throw new ActionInputError("body: too large");
  let html: string | undefined;
  if (b.html !== undefined && b.html !== null) {
    if (typeof b.html !== "string") throw new ActionInputError("html: must be a string");
    if (byteLen(b.html) > EMAIL_LIMITS.maxHtmlBytes) throw new ActionInputError("html: too large");
    html = b.html;
  }
  const out: SendInput = { to, cc, subject, text, ...(html !== undefined ? { html } : {}) };
  if (b.inReplyTo !== undefined && b.inReplyTo !== null && b.inReplyTo !== "") out.inReplyTo = normalizeMessageId("inReplyTo", b.inReplyTo);
  if (b.references !== undefined && b.references !== null) {
    const refs = Array.isArray(b.references) ? b.references : String(b.references).split(/\s+/).filter(Boolean);
    if (refs.length > EMAIL_LIMITS.maxReferences) throw new ActionInputError("references: too many");
    out.references = refs.map((r, i) => normalizeMessageId(`references[${i}]`, r));
  }
  return out;
}

// ── reply threading ─────────────────────────────────────────────────────────

/** The stored email note fields a reply is built from (worker/proton-parse noteMetadata). */
export interface ReplySource {
  subject?: unknown;
  from?: unknown;
  to?: unknown;
  messageId?: unknown;
  threadId?: unknown;
  /** Honoured when present (the Proton ingest does not store it today). */
  replyTo?: unknown;
}

/** Addresses in a stored header value, via the ingest's RFC 5322 parser
 *  (`getaddresses` semantics: quoted display names, comments, groups — never a
 *  naive first-`<…>` scan, which `"a <x@evil>" <real@example>` would fool). */
const addrsOf = (v: unknown): string[] => (typeof v === "string" ? addresses(v).filter((a) => a.includes("@")) : []);

/**
 * Build the threading headers + recipients for a reply to a stored message:
 *   In-Reply-To = <messageId>; References = <threadId> <messageId> (the thread
 *   root first — the ingest stores the References root as threadId — collapsed
 *   when they are the same); Subject = "Re: " unless it already starts with a
 *   reply prefix; To = Reply-To if stored, else the original sender, or
 *   (replying to our own message) the original recipients.
 */
export function buildReply(src: ReplySource, self: string): { to: string[]; subject: string; inReplyTo: string; references: string[] } {
  const messageId = normalizeMessageId("messageId", src.messageId);
  const refs: string[] = [];
  if (typeof src.threadId === "string" && src.threadId.trim()) {
    try {
      const root = normalizeMessageId("threadId", src.threadId);
      if (root !== messageId) refs.push(root);
    } catch {
      // an unusable stored threadId just shortens References
    }
  }
  refs.push(messageId);
  const subj = typeof src.subject === "string" ? src.subject.replace(/[\r\n\0]+/g, " ").trim() : "";
  const subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`.trim();
  const me = self.toLowerCase();
  const notMe = (a: string) => a.toLowerCase() !== me;
  const replyTo = addrsOf(src.replyTo).filter(notMe);
  const fromAddr = addrsOf(src.from)[0] ?? "";
  let to: string[];
  if (replyTo.length) to = replyTo;
  else if (fromAddr && notMe(fromAddr)) to = [fromAddr];
  else to = addrsOf(src.to).filter(notMe);
  to = [...new Map(to.map((a) => [a.toLowerCase(), a])).values()];
  if (!to.length) throw new ActionInputError("the stored message has no usable reply address");
  return { to: to.map((a, i) => validateAddress(`replyTo[${i}]`, a)), subject: subject.slice(0, EMAIL_LIMITS.maxSubject), inReplyTo: messageId, references: refs };
}

// ── composition ─────────────────────────────────────────────────────────────

/** Compose the RFC 5322 message. Returns the raw bytes and its Message-ID. */
export async function composeMessage(from: string, m: SendInput, now: Date = new Date()): Promise<{ raw: Buffer; messageId: string }> {
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
  const domain = from.split("@")[1] || "localhost";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const node = new MailComposer({
    from,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc } : {}),
    subject: m.subject,
    text: m.text,
    ...(m.html !== undefined ? { html: m.html } : {}),
    messageId,
    date: now,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references?.length ? { references: m.references } : {}),
    // Never let nodemailer fetch a URL or read a file for content.
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  const raw = await new Promise<Buffer>((resolve, reject) => node.build((err, buf) => (err ? reject(err) : resolve(buf))));
  return { raw, messageId };
}

// ── transports (injectable) ─────────────────────────────────────────────────

export interface SmtpSender {
  send(cred: ProtonCredential, envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: number; rejected: number }>;
}

/** ok = acted on exactly one message; not_found = no exact match; ambiguous = several exact matches (nothing done). */
export type MailboxResult = "ok" | "not_found" | "ambiguous";

export interface MailboxOps {
  /** Move the ONE message whose Message-ID is exactly `messageId` from `mailbox` to `target`. */
  move(cred: ProtonCredential, mailbox: string, messageId: string, target: string): Promise<MailboxResult>;
  /** Add/remove \Seen on the ONE message whose Message-ID is exactly `messageId`. */
  setSeen(cred: ProtonCredential, mailbox: string, messageId: string, seen: boolean): Promise<MailboxResult>;
}

/**
 * IMAP `SEARCH HEADER Message-ID x` is a SUBSTRING match, so a short or crafted
 * id (`<a>`) can hit unrelated messages. Candidates are therefore re-checked
 * against their own fetched Message-ID header, normalized the same way, and we
 * act only when EXACTLY one equals the wanted id.
 */
export function pickExactUid(candidates: Array<{ uid: number; messageId: string }>, wanted: string): { uid: number } | "not_found" | "ambiguous" {
  const want = wanted.trim().replace(/^<|>$/g, "");
  const hits = candidates.filter((c) => c.messageId.trim().replace(/^<|>$/g, "") === want);
  if (!hits.length) return "not_found";
  if (new Set(hits.map((h) => h.uid)).size > 1) return "ambiguous";
  return { uid: hits[0]!.uid };
}

/**
 * The real SMTP path: nodemailer's SMTPConnection driven step by step so the pin
 * check sits between the TLS handshake and AUTH. `connect()` completes only
 * after STARTTLS (demanded via requireTLS) and the post-TLS EHLO; nothing but
 * EHLO/STARTTLS has been written at that point. Then: the socket must be a
 * TLSSocket whose cert SHA-256 equals the pin, else close — AUTH never sent.
 */
export function smtpSend(opts: { timeoutMs?: number } = {}): SmtpSender {
  return {
    async send(cred, envelope, raw) {
      const s = smtpSettingsOf(cred);
      if (!isLoopbackHost(s.host)) throw new ActionTransportError("proton-bridge smtp: refusing a non-loopback host", false);
      const { default: SMTPConnection } = await import("nodemailer/lib/smtp-connection/index.js");
      const timeout = opts.timeoutMs ?? config.actionsSmtpTimeoutMs;
      const conn = new SMTPConnection({
        host: s.host,
        port: s.port,
        secure: s.security === "tls",
        requireTLS: s.security === "starttls",
        // Self-signed loopback cert: verified by the pin below instead of a CA.
        tls: { rejectUnauthorized: false },
        name: "localhost",
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout * 4,
        logger: false,
      });
      // SMTPConnection reports connection-level failures (TLS upgrade refused,
      // socket errors, timeouts) ONLY as 'error'/'end' events, not through the
      // step callbacks — so every step races this, or a refusal would hang.
      let fail!: (e: Error) => void;
      const failed = new Promise<never>((_, reject) => (fail = reject));
      failed.catch(() => {});
      conn.on("error", (e) => fail(e));
      conn.once("end", () => fail(new Error("connection closed by the server")));
      const step = <T>(fn: (cb: (err?: Error | null, v?: T) => void) => void): Promise<T> =>
        Promise.race([new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T)))), failed]);
      const scrub = (m: string) => scrubProtonError(m, cred);
      try {
        await step<void>((cb) => conn.connect((err) => cb(err)));
      } catch (e) {
        conn.close();
        throw new ActionTransportError(scrub(`proton-bridge smtp: cannot connect to Bridge at ${s.host}:${s.port} (${(e as Error).message})`), false);
      }
      const sock = conn._socket as unknown;
      if (!conn.secure || !(sock instanceof tls.TLSSocket)) {
        conn.close();
        throw new ActionTransportError("proton-bridge smtp: connection is not TLS-protected — refusing to send credentials", false);
      }
      const rawCert = sock.getPeerCertificate()?.raw;
      const seen = rawCert ? crypto.createHash("sha256").update(rawCert).digest("hex") : "";
      if (seen !== s.certSha256) {
        conn.close();
        throw new ActionTransportError(
          `proton-bridge smtp: TLS certificate fingerprint mismatch (pinned ${s.certSha256.slice(0, 16)}…, seen ${seen.slice(0, 16) || "none"}…) — refusing to log in`,
          false,
        );
      }
      try {
        await step<void>((cb) => conn.login({ user: cred.username, pass: cred.password }, (err) => cb(err)));
      } catch {
        conn.close();
        throw new ActionTransportError("proton-bridge smtp: Bridge rejected the login", false);
      }
      try {
        const info = await step<{ accepted: unknown[]; rejected: unknown[] }>((cb) =>
          conn.send(envelope, raw, (err, i) => cb(err, i as unknown as { accepted: unknown[]; rejected: unknown[] })),
        );
        return { accepted: info.accepted?.length ?? 0, rejected: info.rejected?.length ?? 0 };
      } catch (e) {
        // EENVELOPE = MAIL FROM / RCPT TO refused: no DATA was transmitted.
        const code = (e as { code?: string }).code;
        throw new ActionTransportError(scrub(`proton-bridge smtp: send failed (${code ?? ""} ${(e as Error).message})`), code === "EENVELOPE" ? false : "unknown");
      } finally {
        try {
          conn.quit();
        } catch {
          conn.close();
        }
      }
    },
  };
}

/** The slice of imapflow the mailbox actions use (injectable for tests). */
export type ActionImapClient = Pick<
  import("imapflow").ImapFlow,
  "mailboxOpen" | "search" | "fetch" | "messageMove" | "messageFlagsAdd" | "messageFlagsRemove" | "logout" | "close"
>;

/**
 * The real IMAP path for archive / mark-read: pinned connect, READ-WRITE select,
 * a Message-ID SEARCH to find candidates, then an exact re-check of each
 * candidate's own Message-ID header (`pickExactUid`) — never "the highest UID
 * that matched a substring".
 */
export function imapMailboxOps(opts: { timeoutMs?: number; connect?: (cred: ProtonCredential) => Promise<ActionImapClient> } = {}): MailboxOps {
  const MAX_CANDIDATES = 50;
  const withUid = async (cred: ProtonCredential, mailbox: string, messageId: string, fn: (client: ActionImapClient, uid: number) => Promise<void>): Promise<MailboxResult> => {
    let client: ActionImapClient;
    try {
      client = opts.connect ? await opts.connect(cred) : await connectPinnedImap(cred, opts);
    } catch (e) {
      throw new ActionTransportError((e as Error).message, false);
    }
    try {
      await client.mailboxOpen(mailbox);
      const bare = messageId.replace(/^<|>$/g, "");
      const found = await client.search({ header: { "message-id": bare } }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-MAX_CANDIDATES);
      if (!uids.length) return "not_found";
      const candidates: Array<{ uid: number; messageId: string }> = [];
      for await (const m of client.fetch(uids.join(","), { uid: true, headers: ["message-id"] }, { uid: true })) {
        const hdrs = m.headers ? Buffer.concat([m.headers, Buffer.from("\r\n")]) : Buffer.from("\r\n");
        candidates.push({ uid: m.uid, messageId: messageIdOf(parseMime(hdrs)) });
      }
      const pick = pickExactUid(candidates, messageId);
      if (pick === "not_found" || pick === "ambiguous") return pick;
      await fn(client, pick.uid);
      return "ok";
    } catch (e) {
      if (e instanceof ActionTransportError) throw e;
      throw new ActionTransportError(scrubProtonError(`proton-bridge imap: ${(e as Error).message}`, cred), "unknown");
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  };
  return {
    move: (cred, mailbox, messageId, target) =>
      withUid(cred, mailbox, messageId, async (client, uid) => {
        await client.messageMove(String(uid), target, { uid: true });
      }),
    setSeen: (cred, mailbox, messageId, seen) =>
      withUid(cred, mailbox, messageId, async (client, uid) => {
        if (seen) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      }),
  };
}

let smtpImpl: SmtpSender | null = null;
let mailboxImpl: MailboxOps | null = null;
/** Inject fake transports (tests). `null` restores the real ones. */
export function configureEmailActions(o: { smtp?: SmtpSender | null; mailbox?: MailboxOps | null }): void {
  if ("smtp" in o) smtpImpl = o.smtp ?? null;
  if ("mailbox" in o) mailboxImpl = o.mailbox ?? null;
}
export const smtpSender = (): SmtpSender => smtpImpl ?? smtpSend();
export const mailboxOps = (): MailboxOps => mailboxImpl ?? imapMailboxOps();

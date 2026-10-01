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
}

const addrOf = (s: string): string => {
  const a = s.indexOf("<");
  const b = s.indexOf(">", a + 1);
  return (a >= 0 && b > a ? s.slice(a + 1, b) : s).trim();
};

/**
 * Build the threading headers + recipients for a reply to a stored message:
 *   In-Reply-To = <messageId>; References = <threadId> <messageId> (the thread
 *   root first — the ingest stores the References root as threadId — collapsed
 *   when they are the same); Subject = "Re: " unless it already starts with a
 *   reply prefix; To = the original sender, or (replying to our own message) the
 *   original recipients.
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
  const fromAddr = typeof src.from === "string" ? addrOf(src.from) : "";
  let to: string[];
  if (fromAddr && fromAddr.toLowerCase() !== self.toLowerCase()) to = [fromAddr];
  else
    to = (typeof src.to === "string" ? src.to.split(",") : [])
      .map((s) => addrOf(s))
      .filter((a) => a && a.toLowerCase() !== self.toLowerCase());
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

export interface MailboxOps {
  /** Move the message with this Message-ID from `mailbox` to `target`. false = not found. */
  move(cred: ProtonCredential, mailbox: string, messageId: string, target: string): Promise<boolean>;
  /** Add/remove \Seen. false = not found. */
  setSeen(cred: ProtonCredential, mailbox: string, messageId: string, seen: boolean): Promise<boolean>;
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

/** The real IMAP path for archive / mark-read: pinned connect, READ-WRITE select, search by Message-ID. */
export function imapMailboxOps(opts: { timeoutMs?: number } = {}): MailboxOps {
  const withUid = async <T>(cred: ProtonCredential, mailbox: string, messageId: string, fn: (client: import("imapflow").ImapFlow, uid: number) => Promise<T>): Promise<T | false> => {
    let client: import("imapflow").ImapFlow;
    try {
      client = await connectPinnedImap(cred, opts);
    } catch (e) {
      throw new ActionTransportError((e as Error).message, false);
    }
    try {
      await client.mailboxOpen(mailbox);
      const bare = messageId.replace(/^<|>$/g, "");
      const found = await client.search({ header: { "message-id": bare } }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (!uids.length) return false;
      return await fn(client, Math.max(...uids));
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
    async move(cred, mailbox, messageId, target) {
      const r = await withUid(cred, mailbox, messageId, async (client, uid) => {
        await client.messageMove(String(uid), target, { uid: true });
        return true;
      });
      return r === true;
    },
    async setSeen(cred, mailbox, messageId, seen) {
      const r = await withUid(cred, mailbox, messageId, async (client, uid) => {
        if (seen) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
        return true;
      });
      return r === true;
    },
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

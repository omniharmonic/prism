/**
 * Live actions — `/api/actions/*` (Arch v2 WP1.5, docs/live-actions.md).
 *
 * The server acting AS THE OWNER toward the outside world: send/reply/archive/
 * mark-read email (Proton Bridge), RSVP/create calendar events (gog), send/react
 * in Matrix. Mounted BEFORE the gateway so the owner short-circuit never proxies
 * these to the vault.
 *
 * GATES, in order (each route):
 *   1. SERVER OWNER only (`kind: "user"` with email === OWNER_EMAIL) — not a vault
 *      admin/owner of another vault, never a member/guest/capability/anon: 403.
 *      These act with the owner's identity (mailbox, calendar, Matrix account).
 *   2. The family's flag (ACTIONS_EMAIL_ENABLED / _CALENDAR_ / _MATRIX_, all
 *      default off): 503 `actions_disabled`.
 *   3. A per-owner, per-family rate limit: 429.
 *   4. Input validation (header-injection, recipient cap, sizes, ids): 400.
 *   5. ORIGIN: how the request authenticated (`requestVia`) decides human vs
 *      agent. session / device = HUMAN; mcp (in-process Prism MCP dispatch) and
 *      local-token (loopback owner token: desktop or a host script) = AGENT. A
 *      client may DOWNGRADE itself with `X-Prism-Action-Origin: agent`, never
 *      upgrade. Agent origin: email + calendar refused (403 `agent_origin_refused`
 *      — outward agent actions need a confirmation design first); Matrix only in
 *      ACTIONS_MATRIX_AGENT_ROOMS. Human origin: Matrix in any JOINED room.
 *   6. Idempotency (`Idempotency-Key` header, or body `idempotencyKey`) — REQUIRED
 *      for the sending actions (email send/reply, calendar create, matrix send),
 *      optional for the naturally idempotent ones. Same key + same request →
 *      the first outcome is replayed (`Idempotent-Replayed: true`), nothing is
 *      sent again; same key + different request → 422; still running → 409.
 * Every attempt past gate 1 writes an `action_audit` row (store.ts) — ids and
 * hashes only, never a body/subject/address.
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { getSecret } from "../secrets";
import { resolveVaultEntry } from "../db";

/**
 * Live actions use ONLY the PRIMARY vault's credentials and email notes
 * (security review M2), whatever X-Prism-Vault the owner is browsing: another
 * vault's admins can write that vault's integration secrets, and must never be
 * able to steer the owner's sends (an attacker homeserver, a chosen gog
 * account). The primary vault's matrix/google/proton-bridge credentials are
 * themselves server-owner-only to write (routes/integrations.ts).
 */
const primaryVaultId = (): string => resolveVaultEntry(undefined).id;
import { vaultClient, VaultError } from "../parachute";
import { consumeRateLimit } from "../middleware/ratelimit";
import { PROTON_CREDENTIAL, validateProtonCredential, type ProtonCredential } from "../worker/proton";
import type { MatrixCreds } from "../worker/matrix";
import {
  ActionInputError,
  ActionTransportError,
  buildReply,
  composeMessage,
  mailboxOps,
  normalizeMessageId,
  smtpSender,
  validateSendInput,
  type MailboxResult,
  type SendInput,
} from "../actions/email";
import {
  classifyCalendarWriteRefusal,
  classifyRsvpRefusal,
  GogError,
  createArgs,
  deleteArgs,
  eventGetArgs,
  resolveScope,
  ScopeRefusal,
  validateScopeField,
  type CalendarScope,
  parseCreated,
  parseEvent,
  rsvpArgs,
  runGog,
  updateArgs,
  validateCreateInput,
  validateEventId as validateCalEventId,
  validateUpdateInput,
} from "../actions/calendar";
import { reflectLiveCalendarChange } from "../worker/calendar";
import { isJoined, matrixActionClient, txnIdFor, validateBody, validateEventId as validateMxEventId, validateReactionKey, validateRoomId } from "../actions/matrix";
import {
  IDEMPOTENCY_KEY_RE,
  claimIdempotency,
  completeIdempotency,
  recipientsHash,
  recordAction,
  releaseIdempotency,
  requestHash,
  scrubActionError,
  shortHash,
  type ActionOrigin,
} from "../actions/store";

export const actionsApi = new Hono();

type Family = "email" | "calendar" | "matrix";
const enabled = (f: Family): boolean =>
  f === "email" ? config.actionsEmailEnabled : f === "calendar" ? config.actionsCalendarEnabled : config.actionsMatrixEnabled;

type OwnerActor = Extract<Actor, { kind: "user" }>;
const isServerOwner = (a: Actor): a is OwnerActor => a.kind === "user" && a.email === config.ownerEmail;

actionsApi.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (!isServerOwner(actor)) return c.json({ error: "forbidden" }, 403);
  const expectedActor = c.req.header("X-Prism-Write-Actor");
  if (expectedActor && expectedActor !== `user:${actor.email}`) return c.json({ error: "write_actor_changed" }, 409);
  await next();
});

/** Human vs agent, from HOW the request authenticated (see header comment). */
export function actionOrigin(c: Context): { via: string; origin: ActionOrigin } {
  const via = requestVia(c);
  const human = via === "session" || via === "device";
  const downgrade = (c.req.header("x-prism-action-origin") ?? "").toLowerCase() === "agent";
  return { via, origin: human && !downgrade ? "human" : "agent" };
}

const MAX_BODY_BYTES = 1_200_000;

/**
 * CSRF guard (security review M1). Refuses:
 *  - any body that is not `Content-Type: application/json` (415) — a simple
 *    cross-site form can only send text/plain / urlencoded / multipart;
 *  - for anything but a native bearer device token (not an ambient credential):
 *    `Sec-Fetch-Site: cross-site|same-site` (a sibling subdomain is same-site
 *    and rides a SameSite=Lax cookie), and an `Origin` that is neither
 *    APP_ORIGIN nor a NATIVE_ORIGINS entry (403 `csrf_refused`).
 * The PWA is same-origin (`Sec-Fetch-Site: same-origin`), so it is unaffected.
 * Dev gotcha: a Vite dev server on another port is `same-site` — use its proxy.
 */
export function csrfRefusal(c: Context, via: string): Response | null {
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return c.json({ error: "unsupported_media_type", detail: "Content-Type must be application/json" }, 415);
  if (via === "device") return null;
  const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return c.json({ error: "csrf_refused", detail: "cross-site request refused" }, 403);
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    const o = origin.replace(/\/+$/, "");
    if (o !== config.appOrigin && !config.nativeOrigins.includes(o)) return c.json({ error: "csrf_refused", detail: "request origin not allowed" }, 403);
  }
  return null;
}

/** Read a request body, giving up (null) as soon as it passes `max` bytes —
 *  the whole body is never buffered first (security review L7). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  if (!req.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

interface RunCtx {
  actor: OwnerActor;
  body: Record<string, unknown>;
  origin: ActionOrigin;
  via: string;
  key: string | null;
  /** Merge more ids/hashes into this attempt's audit target. */
  target: Record<string, unknown>;
}

interface Spec {
  action: string;
  family: Family;
  rate: () => { name: string; max: number; windowMs: number };
  requireKey: boolean;
  /** Pure validation + origin rules, BEFORE the idempotency claim. Throw ActionInputError / Refusal. */
  prepare?: (ctx: RunCtx) => Promise<void> | void;
  run: (ctx: RunCtx) => Promise<Record<string, unknown>>;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 404 | 409 | 422 = 403,
    /** Set when the refusal is a provable "nothing was sent" (echoed as `sent: false`). */
    readonly sent?: false,
  ) {
    super(message);
  }
}

function route(spec: Spec) {
  return async (c: Context) => {
    const actor = resolveActor(c);
    if (!isServerOwner(actor)) return c.json({ error: "forbidden" }, 403);
    if (!enabled(spec.family)) {
      return c.json({ error: "actions_disabled", detail: `set ACTIONS_${spec.family.toUpperCase()}_ENABLED=true on the server` }, 503);
    }
    const rate = spec.rate();
    const retry = consumeRateLimit(`actions:${rate.name}:${actor.email}`, rate.max, rate.windowMs);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited", retryAfter: retry }, 429);
    }
    const { via, origin } = actionOrigin(c);
    // CSRF (security review M1): a JSON content type and a custom header are
    // both mandatory, so a browser can only send this after a CORS preflight —
    // a cross-site/sibling-subdomain `text/plain` form riding the SameSite=Lax
    // session cookie is refused before its body is even read.
    const csrf = csrfRefusal(c, via);
    if (csrf) return csrf;
    const raw = await readCapped(c.req.raw, MAX_BODY_BYTES);
    if (raw === null) return c.json({ error: "too_large" }, 413);
    let body: Record<string, unknown>;
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "bad_request", detail: "a JSON object body is required" }, 400);
    }
    // The key comes ONLY from the header (a custom header forces a preflight).
    const keyRaw = c.req.header("idempotency-key");
    const reqBody = body;
    const ctx: RunCtx = { actor, body: reqBody, origin, via, key: keyRaw ?? null, target: {} };
    const audit = (status: "ok" | "failed" | "refused" | "replayed", error?: string) =>
      recordAction({ actorEmail: actor.email, via, origin, action: spec.action, vaultId: primaryVaultId(), target: ctx.target, idempotencyKey: ctx.key, status, error });

    if (keyRaw !== undefined && !IDEMPOTENCY_KEY_RE.test(keyRaw)) {
      ctx.key = null;
      audit("refused", "bad idempotency key");
      return c.json({ error: "bad_request", detail: "Idempotency-Key must be 8-200 chars of [A-Za-z0-9._:-]" }, 400);
    }
    if (spec.requireKey && !keyRaw) {
      audit("refused", "missing idempotency key");
      return c.json({ error: "idempotency_key_required", detail: "send an Idempotency-Key header (a fresh UUID per user action)" }, 400);
    }

    try {
      await spec.prepare?.(ctx);
    } catch (e) {
      return refusalResponse(c, e, audit);
    }

    if (ctx.key) {
      const claim = claimIdempotency(actor.email, ctx.key, spec.action, requestHash(spec.action, reqBody));
      if (claim.kind === "replay") {
        audit("replayed");
        c.header("Idempotent-Replayed", "true");
        return c.json(claim.response as Record<string, unknown>, claim.status as 200);
      }
      if (claim.kind === "mismatch") {
        audit("refused", "idempotency key reused for a different request");
        return c.json({ error: "idempotency_key_reused", detail: "this key was already used for a different request" }, 422);
      }
      if (claim.kind === "in_progress") return c.json({ error: "in_progress", detail: "the first request with this key is still running" }, 409);
      if (claim.kind === "unknown_outcome") {
        audit("refused", "earlier attempt with this key ended in an unknown state");
        return c.json({ error: "outcome_unknown", detail: "an earlier attempt with this key did not finish; check before retrying with a new key" }, 409);
      }
    }

    try {
      const out = await spec.run(ctx);
      const resp = { ok: true, ...out };
      if (ctx.key) completeIdempotency(actor.email, ctx.key, 200, resp);
      audit("ok");
      return c.json(resp);
    } catch (e) {
      if (e instanceof ActionTransportError) {
        const resp = { error: "upstream_failed", detail: scrubActionError(e.message), sent: e.sent === false ? false : "unknown" };
        if (ctx.key) {
          if (e.sent === false) releaseIdempotency(actor.email, ctx.key);
          else completeIdempotency(actor.email, ctx.key, 502, resp);
        }
        audit("failed", e.message);
        return c.json(resp, 502);
      }
      if (ctx.key) releaseIdempotency(actor.email, ctx.key);
      if (e instanceof ActionInputError || e instanceof Refusal) return refusalResponse(c, e, audit);
      const msg = scrubActionError(e);
      audit("failed", msg);
      console.error(`[actions] ${spec.action} failed: ${msg}`);
      return c.json({ error: "internal_error" }, 500);
    }
  };
}

function refusalResponse(c: Context, e: unknown, audit: (s: "refused", err?: string) => void) {
  if (e instanceof ActionInputError) {
    audit("refused", e.message);
    return c.json({ error: "bad_request", detail: scrubActionError(e.message) }, 400);
  }
  if (e instanceof Refusal) {
    audit("refused", e.code);
    return c.json(e.sent === false ? { error: e.code, detail: e.message, sent: false } : { error: e.code, detail: e.message }, e.status);
  }
  throw e;
}

// ── credentials ─────────────────────────────────────────────────────────────

function protonCred(actor: OwnerActor): ProtonCredential {
  const raw = getSecret(primaryVaultId(), config.ownerEmail, PROTON_CREDENTIAL);
  if (!raw) throw new Refusal("not_configured", "no proton-bridge credential is stored for this vault", 409);
  try {
    return validateProtonCredential(JSON.parse(raw));
  } catch {
    throw new Refusal("not_configured", "the stored proton-bridge credential is invalid; re-save it", 409);
  }
}

function googleAccount(actor: OwnerActor): string {
  const raw = getSecret(primaryVaultId(), config.ownerEmail, "google");
  let account = "";
  try {
    account = (JSON.parse(raw ?? "{}") as { account?: string }).account ?? "";
  } catch {
    account = "";
  }
  if (!account || /[\s\0]/.test(account) || account.startsWith("-")) throw new Refusal("not_configured", "no google credential ({account}) is stored for this vault", 409);
  return account;
}

function matrixCreds(actor: OwnerActor): MatrixCreds {
  const raw = getSecret(primaryVaultId(), config.ownerEmail, "matrix");
  try {
    const c = JSON.parse(raw ?? "null") as MatrixCreds | null;
    if (c?.homeserver && c.accessToken) return c;
  } catch {
    // fall through
  }
  throw new Refusal("not_configured", "no matrix credential is stored for this vault", 409);
}

const agentRefused = (ctx: RunCtx, what: string) => {
  if (ctx.origin === "agent") throw new Refusal("agent_origin_refused", `${what} can only be started by the owner from the Prism UI`);
};

// ── status ──────────────────────────────────────────────────────────────────

actionsApi.get("/", (c) => {
  const actor = resolveActor(c) as OwnerActor;
  const has = (k: string) => !!getSecret(primaryVaultId(), config.ownerEmail, k);
  return c.json({
    email: { enabled: config.actionsEmailEnabled, configured: has(PROTON_CREDENTIAL) },
    calendar: { enabled: config.actionsCalendarEnabled, configured: has("google") },
    matrix: { enabled: config.actionsMatrixEnabled, configured: has("matrix"), agentRooms: config.actionsMatrixAgentRooms.length },
  });
});

// ── email (Proton Bridge) ───────────────────────────────────────────────────

const EMAIL_SEND_RATE = () => ({ name: "email-send", max: config.actionsEmailSendPerHour, windowMs: 3_600_000 });
const EMAIL_MBOX_RATE = { name: "email-mailbox", max: 120, windowMs: 10 * 60_000 };

async function deliver(ctx: RunCtx, m: SendInput): Promise<Record<string, unknown>> {
  const cred = protonCred(ctx.actor);
  const { raw, messageId } = await composeMessage(cred.username, m);
  ctx.target.messageIdHash = shortHash(messageId);
  ctx.target.sizeBytes = raw.length;
  const res = await smtpSender().send(cred, { from: cred.username, to: [...m.to, ...m.cc] }, raw);
  return { messageId, accepted: res.accepted, rejected: res.rejected };
}

const sendTarget = (ctx: RunCtx, m: SendInput) => {
  ctx.target.recipients = m.to.length + m.cc.length;
  ctx.target.recipientsHash = recipientsHash([...m.to, ...m.cc]);
  if (m.inReplyTo) ctx.target.inReplyToHash = shortHash(m.inReplyTo);
};

actionsApi.post(
  "/email/send",
  route({
    action: "email.send",
    family: "email",
    rate: EMAIL_SEND_RATE,
    requireKey: true,
    prepare: (ctx) => {
      agentRefused(ctx, "sending email");
      sendTarget(ctx, validateSendInput(ctx.body));
    },
    run: async (ctx) => deliver(ctx, validateSendInput(ctx.body)),
  }),
);

/** The stored email note a reply / archive / mark-read refers to. */
async function findEmailNote(ctx: RunCtx): Promise<{ id: string; updatedAt?: string | null; metadata: Record<string, unknown> }> {
  const v = vaultClient(primaryVaultId());
  // By note id only (security review L4): a Message-ID lookup would mean a full
  // email-note list per call. Archive / mark-read by bare Message-ID go straight
  // to IMAP and never come here.
  const { noteId } = ctx.body;
  if (typeof noteId === "string" && noteId) {
    if (noteId.length > 300 || /[\0\r\n]/.test(noteId)) throw new ActionInputError("noteId: invalid");
    ctx.target.noteId = noteId;
    try {
      const n = await v.getNote(noteId);
      if (!(n.tags ?? []).includes("email") || typeof n.metadata?.messageId !== "string") throw new Refusal("not_an_email", "that note is not a stored email message", 422);
      return { id: n.id, updatedAt: n.updatedAt, metadata: n.metadata as Record<string, unknown> };
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) throw new Refusal("not_found", "note not found", 404);
      throw e;
    }
  }
  throw new ActionInputError("noteId is required");
}

/** Recipient sets equal, case-insensitively, order-free. */
const sameRecipients = (a: string[], b: string[]): boolean => {
  const n = (x: string[]) => [...new Set(x.map((s) => s.trim().toLowerCase()))].sort().join(",");
  return n(a) === n(b);
};

actionsApi.post(
  "/email/reply",
  route({
    action: "email.reply",
    family: "email",
    rate: EMAIL_SEND_RATE,
    requireKey: true,
    prepare: (ctx) => {
      agentRefused(ctx, "sending email");
      // Validate the user-supplied part now; recipients come from the stored note.
      validateSendInput({ ...ctx.body, to: ["placeholder@example.invalid"], subject: "x" });
      if (typeof ctx.body.noteId !== "string" || !ctx.body.noteId) throw new ActionInputError("noteId is required");
      // L1: the recipients the UI SHOWED the user; the send is refused if the
      // server derives anything else (note changed, Reply-To, parser difference).
      if (!Array.isArray(ctx.body.expectTo) || !ctx.body.expectTo.length || ctx.body.expectTo.some((x) => typeof x !== "string")) {
        throw new ActionInputError("expectTo: the recipient addresses shown to the user are required");
      }
    },
    run: async (ctx) => {
      const note = await findEmailNote(ctx);
      const cred = protonCred(ctx.actor);
      const r = buildReply(note.metadata, cred.username);
      if (!sameRecipients(r.to, ctx.body.expectTo as string[])) {
        ctx.target.expectedRecipients = (ctx.body.expectTo as string[]).length;
        ctx.target.derivedRecipients = r.to.length;
        throw new Refusal("target_changed", "the reply would go to different recipients than shown — reload and check", 409);
      }
      const extraCc = Array.isArray(ctx.body.cc) ? ctx.body.cc : [];
      const m = validateSendInput({ to: r.to, cc: extraCc, subject: r.subject, body: ctx.body.body, html: ctx.body.html, inReplyTo: r.inReplyTo, references: r.references });
      sendTarget(ctx, m);
      return { ...(await deliver(ctx, m)), inReplyTo: r.inReplyTo };
    },
  }),
);

const MAILBOX_RE = /^[A-Za-z0-9 ._/&-]{1,100}$/;
/** M3: act only on exactly one exact Message-ID match. */
function mailboxResult(r: MailboxResult, mailbox: string): void {
  if (r === "not_found") throw new Refusal("not_found", `no message with exactly that Message-ID in ${mailbox}`, 404);
  if (r === "ambiguous") throw new Refusal("ambiguous", `several messages in ${mailbox} carry that Message-ID — nothing was changed`, 409);
}
async function mailboxTarget(ctx: RunCtx): Promise<{ mailbox: string; messageId: string; note: Awaited<ReturnType<typeof findEmailNote>> | null }> {
  if (typeof ctx.body.noteId === "string" && ctx.body.noteId) {
    const note = await findEmailNote(ctx);
    const mailbox = typeof note.metadata.mailbox === "string" && MAILBOX_RE.test(note.metadata.mailbox) ? note.metadata.mailbox : "INBOX";
    return { mailbox, messageId: normalizeMessageId("messageId", note.metadata.messageId), note };
  }
  const messageId = normalizeMessageId("messageId", ctx.body.messageId);
  ctx.target.messageIdHash = shortHash(messageId);
  const mailbox = ctx.body.mailbox === undefined ? "INBOX" : String(ctx.body.mailbox);
  if (!MAILBOX_RE.test(mailbox)) throw new ActionInputError("mailbox: invalid name");
  return { mailbox, messageId, note: null };
}

actionsApi.post(
  "/email/archive",
  route({
    action: "email.archive",
    family: "email",
    rate: () => EMAIL_MBOX_RATE,
    requireKey: false,
    prepare: (ctx) => agentRefused(ctx, "archiving email"),
    run: async (ctx) => {
      const { mailbox, messageId } = await mailboxTarget(ctx);
      const target = config.actionsEmailArchiveMailbox;
      if (mailbox === target) return { archived: false, detail: "already archived" };
      const cred = protonCred(ctx.actor);
      mailboxResult(await mailboxOps().move(cred, mailbox, messageId, target), mailbox);
      return { archived: true };
    },
  }),
);

actionsApi.post(
  "/email/mark-read",
  route({
    action: "email.mark-read",
    family: "email",
    rate: () => EMAIL_MBOX_RATE,
    requireKey: false,
    prepare: (ctx) => {
      agentRefused(ctx, "changing mail flags");
      if (typeof ctx.body.read !== "boolean") throw new ActionInputError("read: true or false is required");
    },
    run: async (ctx) => {
      const read = ctx.body.read as boolean;
      ctx.target.read = read;
      const { mailbox, messageId, note } = await mailboxTarget(ctx);
      const cred = protonCred(ctx.actor);
      mailboxResult(await mailboxOps().setSeen(cred, mailbox, messageId, read), mailbox);
      // Reflect it on the stored note now (best-effort) instead of waiting for
      // the ingest's next flag refresh. if_updated_at, never force.
      if (note && note.updatedAt && note.metadata.isUnread !== !read) {
        const labels = (Array.isArray(note.metadata.labels) ? note.metadata.labels : []).filter((l) => l !== "UNREAD");
        if (!read) labels.splice(Math.min(1, labels.length), 0, "UNREAD");
        await vaultClient(primaryVaultId())
          .updateNote(note.id, { metadata: { isUnread: !read, labels }, ifUpdatedAt: note.updatedAt })
          .catch(() => {});
      }
      return { read };
    },
  }),
);

// ── calendar (gog) ──────────────────────────────────────────────────────────

const CAL_RATE = () => ({ name: "calendar", max: config.actionsCalendarPer10Min, windowMs: 10 * 60_000 });

actionsApi.post(
  "/calendar/rsvp",
  route({
    action: "calendar.rsvp",
    family: "calendar",
    rate: CAL_RATE,
    requireKey: false,
    prepare: (ctx) => {
      agentRefused(ctx, "responding to invitations");
      // L3: validate fully BEFORE anything client-supplied reaches the audit target.
      rsvpArgs("x@example.invalid", validateCalEventId(ctx.body.eventId), String(ctx.body.response));
      ctx.target.eventId = ctx.body.eventId;
      ctx.target.response = ctx.body.response;
    },
    run: async (ctx) => {
      const account = googleAccount(ctx.actor);
      try {
        await runGog(rsvpArgs(account, ctx.body.eventId as string, String(ctx.body.response)));
      } catch (e) {
        // gog's pre-send validation refusals: nothing changed upstream, so release the key.
        // Classified from gog's STDERR only (never err.message, which carries argv) — H2.
        const friendly = e instanceof GogError && e.stderr ? classifyRsvpRefusal(e.stderr) : null;
        if (friendly) throw new Refusal("rsvp_not_applicable", friendly, 409, false);
        throw e;
      }
      return { eventId: ctx.body.eventId, response: ctx.body.response };
    },
  }),
);

actionsApi.post(
  "/calendar/create",
  route({
    action: "calendar.create",
    family: "calendar",
    rate: CAL_RATE,
    requireKey: true,
    prepare: (ctx) => {
      agentRefused(ctx, "creating events");
      const input = validateCreateInput(ctx.body);
      ctx.target.attendees = input.attendees.length;
      if (input.attendees.length) ctx.target.attendeesHash = recipientsHash(input.attendees);
      ctx.target.start = input.start;
    },
    run: async (ctx) => {
      const account = googleAccount(ctx.actor);
      const out = parseCreated(await runGog(createArgs(account, validateCreateInput(ctx.body))));
      if (out.eventId) ctx.target.eventId = out.eventId;
      return out;
    },
  }),
);

/**
 * A gog write failure → a provable "nothing changed upstream" Refusal (key
 * released, `sent: false`) when gog/Google said so; else rethrown unchanged
 * (outcome unknown: the key is kept and replayed). Classified ONLY from gog's
 * stderr (never err.message, which starts with the full argv incl. the owner's
 * title/description — security review H2); a killed / timed-out run has no
 * classifiable stderr. A missing gog binary stays as runGog reported it (502,
 * `sent: false`).
 */
function classifyWriteFailure(e: unknown): never {
  if (e instanceof GogError && e.stderr) {
    const r = classifyCalendarWriteRefusal(e.stderr);
    if (r) throw new Refusal(r.code, r.detail, r.status, false);
  }
  throw e;
}

/**
 * Read the event and decide the gog `--scope` (security review H1, see
 * actions/calendar.ts resolveScope). A READ changes nothing upstream, so any
 * failure here is `sent: false` (key released); a recurring series without an
 * explicit `scope: "all"` is refused (409 `recurring_series`).
 */
async function scopeFor(ctx: RunCtx, account: string, eventId: string): Promise<CalendarScope> {
  const requested = validateScopeField(ctx.body.scope);
  let out: string;
  try {
    out = await runGog(eventGetArgs(account, eventId));
  } catch (e) {
    if (e instanceof GogError && e.stderr && classifyCalendarWriteRefusal(e.stderr)?.code === "event_not_found") {
      throw new Refusal("event_not_found", "That event no longer exists in Google Calendar (it may already be deleted).", 404, false);
    }
    throw new ActionTransportError(`could not read the event before changing it (${(e as Error).message})`, false);
  }
  const ev = parseEvent(out);
  if (!ev) throw new ActionTransportError("gog returned no event for the scope check", false);
  try {
    const scope = resolveScope(eventId, ev, requested);
    ctx.target.scope = scope.scope;
    return scope;
  } catch (e) {
    if (e instanceof ScopeRefusal) throw new Refusal(e.code, e.message, 409, false);
    throw e;
  }
}

actionsApi.post(
  "/calendar/update",
  route({
    action: "calendar.update",
    family: "calendar",
    rate: CAL_RATE,
    // Updating notifies guests (`notify`, default on): a lost response must never
    // become a second round of update emails.
    requireKey: true,
    prepare: (ctx) => {
      agentRefused(ctx, "editing events");
      const u = validateUpdateInput(ctx.body);
      ctx.target.eventId = u.eventId;
      ctx.target.fields = [u.title !== undefined && "title", u.start !== undefined && "time", u.location !== undefined && "location", u.description !== undefined && "description", u.attendees !== undefined && "attendees"].filter(Boolean);
      if (u.attendees?.length) ctx.target.attendeesHash = recipientsHash(u.attendees);
      ctx.target.notify = u.notify;
      validateScopeField(ctx.body.scope);
    },
    run: async (ctx) => {
      const u = validateUpdateInput(ctx.body);
      const account = googleAccount(ctx.actor);
      const scope = await scopeFor(ctx, account, u.eventId);
      let stdout: string;
      try {
        stdout = await runGog(updateArgs(account, u, scope));
      } catch (e) {
        classifyWriteFailure(e);
      }
      const event = parseEvent(stdout);
      // Reflect it on the meeting note now (best-effort, never fails the action:
      // Google already changed). The ingest's next pass converges anything missed.
      const reflected = await reflectLiveCalendarChange(vaultClient(primaryVaultId()), primaryVaultId(), u.eventId, {
        kind: "update",
        event,
        fields: { title: u.title, start: u.start, end: u.end, location: u.location, attendees: u.attendees },
      });
      ctx.target.note = reflected.outcome;
      const htmlLink = event && typeof event.htmlLink === "string" && /^https:\/\//.test(event.htmlLink) ? event.htmlLink : null;
      return { eventId: u.eventId, htmlLink, note: reflected };
    },
  }),
);

actionsApi.post(
  "/calendar/delete",
  route({
    action: "calendar.delete",
    family: "calendar",
    rate: CAL_RATE,
    requireKey: true,
    prepare: (ctx) => {
      agentRefused(ctx, "deleting events");
      ctx.target.eventId = validateCalEventId(ctx.body.eventId);
      if (ctx.body.notify !== undefined && typeof ctx.body.notify !== "boolean") throw new ActionInputError("notify: true or false");
      ctx.target.notify = ctx.body.notify !== false;
      validateScopeField(ctx.body.scope);
    },
    run: async (ctx) => {
      const eventId = ctx.body.eventId as string;
      const account = googleAccount(ctx.actor);
      const scope = await scopeFor(ctx, account, eventId);
      try {
        await runGog(deleteArgs(account, eventId, ctx.body.notify !== false, scope));
      } catch (e) {
        classifyWriteFailure(e);
      }
      // Soft-cancel the meeting note (never a hard delete: it may hold notes).
      const reflected = await reflectLiveCalendarChange(vaultClient(primaryVaultId()), primaryVaultId(), eventId, { kind: "delete" });
      ctx.target.note = reflected.outcome;
      return { eventId, deleted: true, note: reflected };
    },
  }),
);

// ── matrix ──────────────────────────────────────────────────────────────────

/** Origin rule for a Matrix target room (see header comment, gate 5). */
async function assertRoomAllowed(ctx: RunCtx, roomId: string, creds: MatrixCreds, client: ReturnType<typeof matrixActionClient>): Promise<void> {
  if (ctx.origin === "agent" && !config.actionsMatrixAgentRooms.includes(roomId)) {
    throw new Refusal("room_not_allowlisted", "agent-originated Matrix actions may only target rooms in ACTIONS_MATRIX_AGENT_ROOMS");
  }
  let joined: boolean;
  try {
    joined = await isJoined(client, creds, roomId);
  } catch (e) {
    throw new ActionTransportError(`matrix: cannot list joined rooms (${(e as Error).message})`, false);
  }
  if (!joined) throw new Refusal("room_not_joined", "the account is not joined to that room");
}

async function sendMx(ctx: RunCtx, roomId: string, type: "m.room.message" | "m.reaction", content: Record<string, unknown>): Promise<string> {
  const creds = matrixCreds(ctx.actor);
  const client = matrixActionClient(creds);
  await assertRoomAllowed(ctx, roomId, creds, client);
  try {
    return await client.sendEvent(roomId, type, txnIdFor(ctx.key), content);
  } catch (e) {
    const status = (e as { status?: number }).status;
    // A 4xx answer means the homeserver refused it: nothing was posted.
    throw new ActionTransportError(`matrix send failed (${status ?? "network"})`, typeof status === "number" && status >= 400 && status < 500 ? false : "unknown");
  }
}

const MX_SEND_RATE = () => ({ name: "matrix-send", max: config.actionsMatrixSendPer10Min, windowMs: 10 * 60_000 });

actionsApi.post(
  "/matrix/send",
  route({
    action: "matrix.send",
    family: "matrix",
    rate: MX_SEND_RATE,
    requireKey: true,
    prepare: (ctx) => {
      ctx.target.roomId = validateRoomId(ctx.body.roomId);
      validateBody(ctx.body.body);
    },
    run: async (ctx) => {
      const roomId = ctx.body.roomId as string;
      const eventId = await sendMx(ctx, roomId, "m.room.message", { msgtype: "m.text", body: ctx.body.body as string });
      ctx.target.eventId = eventId;
      return { roomId, eventId };
    },
  }),
);

actionsApi.post(
  "/matrix/react",
  route({
    action: "matrix.react",
    family: "matrix",
    rate: () => ({ name: "matrix-react", max: 120, windowMs: 10 * 60_000 }),
    requireKey: false,
    prepare: (ctx) => {
      ctx.target.roomId = validateRoomId(ctx.body.roomId);
      ctx.target.relatesTo = validateMxEventId(ctx.body.eventId);
      validateReactionKey(ctx.body.key);
    },
    run: async (ctx) => {
      const roomId = ctx.body.roomId as string;
      const eventId = await sendMx(ctx, roomId, "m.reaction", {
        "m.relates_to": { rel_type: "m.annotation", event_id: ctx.body.eventId as string, key: ctx.body.key as string },
      });
      ctx.target.eventId = eventId;
      return { roomId, eventId };
    },
  }),
);

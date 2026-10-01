/**
 * Proton Mail (via Proton Mail Bridge IMAP) → vault ingest, server-side
 * (Architecture v2 WP1.2b). The port of the omniharmonic_agent script
 * `scripts/proton_mail.py sync` (launchd `com.omniharmonic.proton-mail`, every
 * 300 s), so email keeps flowing with no launchd job — and without the vault
 * load that script causes.
 *
 * WHAT THE SCRIPT DOES (ported faithfully unless listed under deviations):
 *   - Bridge: IMAP on 127.0.0.1:1143, STARTTLS, Bridge's self-signed cert PINNED
 *     by SHA-256 of the DER (trust-on-first-use in its state file; a mismatch
 *     fails closed). Password from the macOS Keychain (service
 *     "omniharmonic-proton-bridge"), login user = the Bridge account address.
 *   - Mailboxes: INBOX only (`--mailbox` repeatable), opened READ-ONLY (EXAMINE);
 *     bodies fetched with BODY.PEEK[] — the mailbox is never mutated.
 *   - Window, not a cursor: every run `UID SEARCH SINCE <UTC today − 7d>`
 *     (`--since-days 7`), minus the UIDs already in its state file (`syncedUids`,
 *     cap 20 000). More than `--max 200` new → the 200 HIGHEST UIDs this run.
 *     UIDVALIDITY change → forget the synced UIDs (re-fetch the window).
 *   - One note PER MESSAGE (not per thread), tag `email`, path
 *     `vault/messages/email/<slugify(subject)[:80] | no-subject>-<sha256(messageId)[:8]>`.
 *   - Content: `# <subject>`, `**From:**`, `**To:**` (if any), `**Cc:**` (if any),
 *     `**Date:** <local YYYY-MM-DD HH:MM>`, `**Attachments:** <names>` (if any),
 *     `---`, then the body (text/plain parts joined, else stripped HTML; capped at
 *     20 000 chars + "[… truncated …]"). Attachments are listed by name only.
 *   - Metadata (in this order): type "email", subject, from, to, date (local),
 *     isUnread, labels (folder, UNREAD, + header-derived BULK / AUTOMATED / SOCIAL
 *     / CHAT / PROMOTIONS / TRANSACTIONAL / DIRECT — see proton-parse.ts
 *     deriveLabels), messageCount 1, threadId (References root, skipping
 *     `@protonmail.internalid`), messageId, lastMessageAt (epoch ms), source
 *     "proton-bridge", account, mailbox, uid. No cc / starred key.
 *   - Write: GET by path → exists ? PATCH content+metadata (force) : POST. No tags
 *     on the update path, so `triaged` + importance tags survive.
 *   - Flag refresh: for the 500 most recently synced UIDs, `UID FETCH (FLAGS)`,
 *     then ONE GET PER NOTE (≈500 GETs every 5 min) and a PATCH of
 *     {isUnread, labels} where `\Seen` changed. Only read/unread is tracked —
 *     `\Flagged` (starred) is parsed but never stored.
 *   - Never: deletes notes, reflects moves/deletes in the mailbox, links people,
 *     sets triage tags, downloads attachments.
 *   - Other subcommands (setup / health / search, and `sent_thread_ids()` used by
 *     the agent's inbound triage) are NOT ingest and stay in the script.
 *
 * DELIBERATE DEVIATIONS (every one writes less, reads less, or fails closed):
 *   1. State lives in the vault, not a state file: existing notes are found with
 *      ONE lean list per pass (`include_content=false`, `include_metadata` = just
 *      the keys dedupe + flag diffing need) and matched by Message-ID — which is
 *      what the path hash is built from. No per-note GETs, no get-by-path.
 *   2. The window's Message-IDs + flags come from one header-only FETCH
 *      (`BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]`); full sources are fetched only
 *      for messages with no note. A UIDVALIDITY change therefore costs nothing
 *      (the script re-fetched AND rewrote every message in the window).
 *   3. Flag refresh covers every message in the SINCE window (≈ the script's
 *      500-UID index at this inbox's volume), matched by Message-ID instead of a
 *      UID→path map, and PATCHes `{isUnread, labels}` with `if_updated_at` (one
 *      refetch + retry on 409) instead of `force`. Same label rule. When the
 *      same Message-ID sits under two UIDs, the highest UID represents it (the
 *      script let them fight over one note).
 *   4. A known note whose stored `uid` (same mailbox) no longer matches gets
 *      `uid` corrected in the same PATCH (what the script's post-UIDVALIDITY
 *      rewrite achieved), nothing else.
 *   5. Creates use `if_exists: "ignore"` — never a 409, and never overwrite: a
 *      path held by a note we cannot identify as this message is left alone
 *      (intent `skip-collision`); the script would have overwritten it.
 *   6. Existing notes' content is NEVER rewritten (the script only did so after
 *      a hand-cleared state file, as a parser-fix backfill — run the script's
 *      `sync` for that, or a dedicated backfill, not the 5-minute worker).
 *   7. Person linking is OFF by default (the script never linked). With
 *      PROTON_LINK_PEOPLE=true a NEW note gets an `email-from` link to an
 *      EXISTING person note (people.ts index, loaded once per pass) — it never
 *      creates person notes.
 *   8. The Bridge cert pin is REQUIRED in the credential (`certSha256`, same
 *      format as the script's `certFingerprint`): no trust-on-first-use, so a
 *      lost pin fails closed instead of open. The host must be loopback.
 *
 * GATES: PROTON_SYNC_ENABLED (default off) runs it; PROTON_SHADOW=true connects,
 * fetches and diffs but makes ZERO vault writes (it wins over ENABLED) and
 * records every intended write (create / update-flags / skip-collision) for the
 * overseer to compare against what the script wrote:
 * `GET /acl/workers/proton/intents[?verify=1]`. This WP never deletes anything.
 */
import crypto from "node:crypto";
import tls from "node:tls";
import type { IfExists, Note, NoteLinkInput } from "../parachute";
import { vaultClient } from "../parachute";
import { config, type VaultEntry } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { getSecret } from "../secrets";
import { PeopleIndex, type PeopleVault } from "./people";
import { EMAIL_FROM, extractDisplayName, extractEmailAddress } from "./gmail";
import { isUnreadFlags, messageIdOf, noteContent, noteMetadata, notePath, parseMessage, parseMime, relabelUnread, SOURCE, NOTE_DIR } from "./proton-parse";

export const PROTON_CREDENTIAL = "proton-bridge";

// ── credential ───────────────────────────────────────────────────────────────

export type ProtonSecurity = "starttls" | "tls";

/** Stored encrypted under credential kind `proton-bridge` (SECRETS_KEY). */
export interface ProtonCredential {
  host: string;
  port: number;
  username: string;
  password: string;
  security: ProtonSecurity;
  /** SHA-256 of Bridge's DER certificate, 64 hex chars (the script's `certFingerprint`). */
  certSha256: string;
}

export const isLoopbackHost = (h: string): boolean => ["127.0.0.1", "::1", "localhost"].includes(h.trim().toLowerCase());
export const normalizeFingerprint = (s: string): string => s.replace(/:/g, "").trim().toLowerCase();

/**
 * Validate a credential object. Throws a message that never contains the
 * password. Bridge is loopback-only, so a non-loopback host is refused: the
 * password must never leave the machine.
 */
export function validateProtonCredential(v: unknown): ProtonCredential {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const host = typeof o.host === "string" && o.host ? o.host : "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("proton-bridge credential: host must be a loopback address (127.0.0.1, ::1 or localhost)");
  const port = Number(o.port ?? 1143);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("proton-bridge credential: port must be an integer 1-65535");
  if (typeof o.username !== "string" || !o.username) throw new Error("proton-bridge credential: username required");
  if (typeof o.password !== "string" || !o.password) throw new Error("proton-bridge credential: password required");
  const security = (o.security ?? "starttls") as string;
  if (security !== "starttls" && security !== "tls") throw new Error('proton-bridge credential: security must be "starttls" or "tls"');
  const fp = typeof o.certSha256 === "string" ? normalizeFingerprint(o.certSha256) : "";
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error("proton-bridge credential: certSha256 (64 hex chars, SHA-256 of Bridge's DER certificate) required");
  return { host, port, username: o.username, password: o.password, security, certSha256: fp };
}

/** Remove the password (and any long opaque token) from an error message. */
export function scrubProtonError(msg: string, cred?: Pick<ProtonCredential, "password"> | null): string {
  let s = String(msg ?? "");
  if (cred?.password) s = s.split(cred.password).join("[redacted]");
  return s.replace(/\b[A-Za-z0-9+/_-]{24,}={0,2}/g, "[redacted]").slice(0, 300);
}

// ── IMAP seam ────────────────────────────────────────────────────────────────

export interface ImapRef {
  uid: number;
  flags: string[];
  /** Normalized like the script (`.strip().strip("<>")`); "" when absent. */
  messageId: string;
}

export interface ImapSession {
  /** EXAMINE (read-only). null when the mailbox cannot be selected. */
  openMailbox(name: string): Promise<{ uidValidity: string } | null>;
  /** `UID SEARCH SINCE <dd-Mon-yyyy>` (UTC date). */
  searchSince(since: Date): Promise<number[]>;
  /** One header-only fetch for the window: UID, FLAGS, Message-ID. */
  fetchRefs(uids: number[]): Promise<ImapRef[]>;
  /** BODY.PEEK[] + FLAGS for one message (never sets \Seen). */
  fetchSource(uid: number): Promise<{ source: Buffer; flags: string[] } | null>;
  close(): Promise<void>;
}

/** One connection per pass. Tests inject a fake; production uses imapflow. */
export interface ImapSource {
  connect(): Promise<ImapSession>;
}

const toFlags = (f: unknown): string[] => (f instanceof Set ? [...f] : Array.isArray(f) ? f : []).map(String);

/**
 * The real Bridge connection, via imapflow (actively maintained, promise API,
 * STARTTLS + direct TLS, connection/greeting/socket timeouts, BODY.PEEK by
 * default, EXAMINE via `readOnly`). Bridge's certificate is self-signed, so CA
 * validation is off for THIS loopback socket only and replaced by the pin: the
 * fingerprint is checked in `authenticate()` — after the TLS handshake and
 * BEFORE the LOGIN that carries the password — and a mismatch aborts the
 * connection without ever sending it.
 */
export function imapflowSource(cred: ProtonCredential, opts: { timeoutMs?: number } = {}): ImapSource {
  return {
    async connect() {
      if (!isLoopbackHost(cred.host)) throw new Error("proton-bridge: refusing a non-loopback host");
      const { ImapFlow } = await import("imapflow");
      const timeout = opts.timeoutMs ?? config.protonImapTimeoutMs;
      let pinChecked = false;
      class PinnedImapFlow extends ImapFlow {
        async authenticate(): Promise<boolean> {
          const sock = (this as unknown as { socket?: unknown }).socket;
          if (!(sock instanceof tls.TLSSocket)) throw new Error("proton-bridge: connection is not TLS-protected — refusing to send credentials");
          const raw = sock.getPeerCertificate()?.raw;
          const seen = raw ? crypto.createHash("sha256").update(raw).digest("hex") : "";
          if (seen !== cred.certSha256) {
            throw new Error(`proton-bridge: TLS certificate fingerprint mismatch (pinned ${cred.certSha256.slice(0, 16)}…, seen ${seen.slice(0, 16) || "none"}…) — refusing to log in`);
          }
          pinChecked = true;
          // imapflow's authenticate() is internal; typed loosely on purpose.
          return (ImapFlow.prototype as unknown as { authenticate(this: unknown): Promise<boolean> }).authenticate.call(this);
        }
      }
      const client = new PinnedImapFlow({
        host: cred.host,
        port: cred.port,
        secure: cred.security === "tls",
        ...(cred.security === "starttls" ? { doSTARTTLS: true } : {}),
        auth: { user: cred.username, pass: cred.password },
        // Self-signed loopback cert: verified by the pin above instead of a CA.
        tls: { rejectUnauthorized: false },
        logger: false,
        emitLogs: false,
        disableAutoIdle: true,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout * 4,
      } as ConstructorParameters<typeof ImapFlow>[0]);
      client.on("error", () => {}); // surfaced through the awaited calls; never crash the worker
      try {
        await client.connect();
      } catch (e) {
        client.close();
        const err = e as { authenticationFailed?: boolean; code?: string; message?: string };
        // The pin / TLS refusals are ours and already safe to surface verbatim.
        if (/^proton-bridge: (TLS certificate fingerprint mismatch|connection is not TLS-protected)/.test(err.message ?? "")) throw new Error(err.message);
        if (err.authenticationFailed) throw new Error("proton-bridge: Bridge rejected the login (the Bridge password changes when the account is re-added in Bridge)");
        throw new Error(scrubProtonError(`proton-bridge: cannot connect to Bridge at ${cred.host}:${cred.port} (${err.code ?? ""} ${err.message ?? ""})`, cred));
      }
      if (!pinChecked) {
        client.close();
        throw new Error("proton-bridge: certificate pin was not verified before login — refusing to continue");
      }
      return {
        async openMailbox(name) {
          try {
            const box = await client.mailboxOpen(name, { readOnly: true });
            return { uidValidity: String(box.uidValidity) };
          } catch {
            return null;
          }
        },
        async searchSince(since) {
          const r = await client.search({ since }, { uid: true });
          return Array.isArray(r) ? r : [];
        },
        async fetchRefs(uids) {
          if (!uids.length) return [];
          const out: ImapRef[] = [];
          for await (const m of client.fetch(uids.join(","), { uid: true, flags: true, headers: ["message-id"] }, { uid: true })) {
            const hdrs = m.headers ? Buffer.concat([m.headers, Buffer.from("\r\n")]) : Buffer.from("\r\n");
            out.push({ uid: m.uid, flags: toFlags(m.flags), messageId: messageIdOf(parseMime(hdrs)) });
          }
          return out;
        },
        async fetchSource(uid) {
          const m = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
          if (!m || !m.source) return null;
          return { source: m.source, flags: toFlags(m.flags) };
        },
        async close() {
          try {
            await client.logout();
          } catch {
            client.close();
          }
        },
      };
    },
  };
}

// ── intents ──────────────────────────────────────────────────────────────────

export type ProtonIntentAction = "create" | "update-flags" | "skip-collision";
/** `shadow` (nothing written), `applied`, `logged` (decided not to write), `failed`. */
export type ProtonIntentEffect = "shadow" | "applied" | "logged" | "failed";

export interface ProtonIntent {
  at: string;
  mode: "shadow" | "live";
  action: ProtonIntentAction;
  effect: ProtonIntentEffect;
  mailbox: string;
  uid: number;
  noteId?: string;
  path?: string;
  /** create: SHA-256 of the content we would write / wrote (never the text). */
  contentSha256?: string;
  /** create: per-metadata-key short hashes, so verify can name a differing KEY
   *  without the intent ever holding a value. */
  metadataHashes?: Record<string, string>;
  /** update-flags: the change. */
  change?: { isUnread?: boolean; uid?: number };
  reason?: string;
}

const sha = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const keyHashes = (md: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(md).map(([k, v]) => [k, sha(JSON.stringify(v ?? null)).slice(0, 12)]));

// ── the pass ─────────────────────────────────────────────────────────────────

export interface ProtonVault extends PeopleVault {
  listNotes(opts: { tags?: string[]; pathPrefix?: string; includeMetadata?: string[]; includeLinks?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    links?: NoteLinkInput[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
}

/** The metadata keys the lean listing asks for — dedupe + flag diffing only. */
export const LIST_METADATA_KEYS = ["source", "messageId", "mailbox", "uid", "isUnread", "labels"];

export interface ProtonPassOptions {
  mailboxes: string[];
  sinceDays: number;
  maxPerMailbox: number;
  shadow: boolean;
  account: string;
  /** IANA zone for the `date` field / `**Date:**` line (the script used the host's). */
  tz?: string;
  linkPeople?: boolean;
  now?: number;
  /** Last UIDVALIDITY seen per mailbox (in/out; informational). */
  uidValidity?: Record<string, string>;
  log?: (line: string) => void;
}

export interface ProtonPassResult {
  mode: "shadow" | "live";
  window: { since: string };
  mailboxes: Array<{ name: string; window: number; new: number; known: number; skipped?: string; uidValidityChanged?: boolean }>;
  /** Vault list calls made (always ≤ 1). */
  lists: number;
  created: number;
  flagUpdates: number;
  unchanged: number;
  collisions: number;
  failed: number;
  deferred: number;
  linked: number;
  intents: ProtonIntent[];
}

const isConflict = (e: unknown): boolean => /\b409\b|conflict/i.test(String((e as Error)?.message ?? e)) || (e as { status?: number })?.status === 409;

/** UTC midnight of (now − days): the script's `strftime("%d-%b-%Y")` on a UTC datetime. */
export function sinceDate(now: number, days: number): Date {
  const d = new Date(now - days * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * One pass: one IMAP connection, one lean vault list (only when a window is
 * non-empty), a header-only fetch per mailbox, full sources only for messages
 * with no note, PATCHes only where read/unread (or the stored uid) changed.
 * Throws when the connection or the listing fails; one bad message never aborts
 * the pass (counted in `failed`).
 */
export async function syncProton(source: ImapSource, vault: ProtonVault, opts: ProtonPassOptions): Promise<ProtonPassResult> {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const mode = opts.shadow ? "shadow" : "live";
  const since = sinceDate(now, opts.sinceDays);
  const res: ProtonPassResult = {
    mode,
    window: { since: since.toISOString().slice(0, 10) },
    mailboxes: [],
    lists: 0,
    created: 0,
    flagUpdates: 0,
    unchanged: 0,
    collisions: 0,
    failed: 0,
    deferred: 0,
    linked: 0,
    intents: [],
  };
  const log = opts.log ?? (() => {});
  const intent = (i: Omit<ProtonIntent, "at" | "mode">) => res.intents.push({ at, mode, ...i });

  let index: { byMid: Map<string, Note>; byPath: Map<string, Note> } | null = null;
  const loadIndex = async () => {
    if (index) return index;
    res.lists++;
    const notes = await vault.listNotes({ tags: ["email"], pathPrefix: `${NOTE_DIR}/`, includeMetadata: LIST_METADATA_KEYS });
    const byMid = new Map<string, Note>();
    const byPath = new Map<string, Note>();
    for (const n of notes) {
      const mid = n.metadata?.messageId;
      if (typeof mid === "string" && mid) {
        const prev = byMid.get(mid);
        // Prefer the Bridge-written note if anything else ever carried the same id.
        if (!prev || (prev.metadata?.source !== SOURCE && n.metadata?.source === SOURCE)) byMid.set(mid, n);
      }
      if (n.path && !byPath.has(n.path)) byPath.set(n.path, n);
    }
    index = { byMid, byPath };
    return index;
  };
  let people: PeopleIndex | null = null;

  const session = await source.connect();
  try {
    for (const mailbox of opts.mailboxes) {
      const box = await session.openMailbox(mailbox);
      if (!box) {
        log(`${mailbox}: cannot select — skipped`);
        res.mailboxes.push({ name: mailbox, window: 0, new: 0, known: 0, skipped: "cannot select" });
        continue;
      }
      const prevValidity = opts.uidValidity?.[mailbox];
      const uidValidityChanged = prevValidity !== undefined && prevValidity !== box.uidValidity;
      if (uidValidityChanged) log(`${mailbox}: UIDVALIDITY changed — notes are matched by Message-ID, nothing is re-fetched`);
      if (opts.uidValidity) opts.uidValidity[mailbox] = box.uidValidity;

      const window = [...new Set(await session.searchSince(since))].sort((a, b) => a - b);
      const stat = { name: mailbox, window: window.length, new: 0, known: 0, ...(uidValidityChanged ? { uidValidityChanged } : {}) };
      res.mailboxes.push(stat);
      if (!window.length) continue;
      const idx = await loadIndex();

      // One ref per Message-ID: the highest UID represents duplicates.
      const refs = new Map<string, ImapRef>();
      for (const r of await session.fetchRefs(window)) {
        const mid = r.messageId || `${mailbox}-uid-${r.uid}`;
        const prev = refs.get(mid);
        if (!prev || r.uid > prev.uid) refs.set(mid, r);
      }

      let fresh: number[] = [];
      for (const [mid, ref] of refs) {
        const known = idx.byMid.get(mid);
        if (!known) {
          fresh.push(ref.uid);
          continue;
        }
        stat.known++;
        try {
          await refreshFlags(known, ref, mailbox);
        } catch (e) {
          res.failed++;
          intent({ action: "update-flags", effect: "failed", mailbox, uid: ref.uid, noteId: known.id, path: known.path ?? undefined, reason: String((e as Error).message ?? e).slice(0, 200) });
        }
      }

      fresh.sort((a, b) => a - b);
      if (opts.maxPerMailbox > 0 && fresh.length > opts.maxPerMailbox) {
        log(`${mailbox}: ${fresh.length} new in window, taking the ${opts.maxPerMailbox} newest (next pass picks up the rest)`);
        res.deferred += fresh.length - opts.maxPerMailbox;
        fresh = fresh.sort((a, b) => b - a).slice(0, opts.maxPerMailbox);
      }
      stat.new = fresh.length;
      for (const uid of fresh) {
        try {
          await ingestNew(uid, mailbox, idx);
        } catch (e) {
          res.failed++;
          intent({ action: "create", effect: "failed", mailbox, uid, reason: String((e as Error).message ?? e).slice(0, 200) });
          log(`${mailbox}/${uid}: write failed — ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
      }
    }
  } finally {
    await session.close().catch(() => {});
  }
  return res;

  /** Read/unread (and a stale uid) → one metadata PATCH, or nothing. */
  async function refreshFlags(known: Note, ref: ImapRef, mailbox: string): Promise<void> {
    const diff = (md: Record<string, unknown>): Record<string, unknown> => {
      const patch: Record<string, unknown> = {};
      const unread = isUnreadFlags(ref.flags);
      if (Boolean(md.isUnread) !== unread) {
        patch.isUnread = unread;
        patch.labels = relabelUnread(md.labels, unread);
      }
      if (md.mailbox === mailbox && typeof md.uid === "number" && md.uid !== ref.uid) patch.uid = ref.uid;
      return patch;
    };
    let patch = diff(known.metadata ?? {});
    if (!Object.keys(patch).length) {
      res.unchanged++;
      return;
    }
    const change = { ...(patch.isUnread !== undefined ? { isUnread: patch.isUnread as boolean } : {}), ...(patch.uid !== undefined ? { uid: patch.uid as number } : {}) };
    const base = { action: "update-flags" as const, mailbox, uid: ref.uid, noteId: known.id, path: known.path ?? undefined, change };
    if (opts.shadow) {
      res.flagUpdates++;
      intent({ ...base, effect: "shadow" });
      return;
    }
    try {
      await vault.updateNote(known.id, { metadata: patch, ...(known.updatedAt ? { ifUpdatedAt: known.updatedAt } : {}) });
    } catch (e) {
      if (!isConflict(e)) throw e;
      // Someone (triage) wrote the note since the listing: re-read, re-diff, retry once.
      const freshNote = await vault.getNote(known.id);
      patch = diff(freshNote.metadata ?? {});
      if (!Object.keys(patch).length) {
        res.unchanged++;
        return;
      }
      await vault.updateNote(known.id, { metadata: patch, ...(freshNote.updatedAt ? { ifUpdatedAt: freshNote.updatedAt } : {}) });
    }
    res.flagUpdates++;
    intent({ ...base, effect: "applied" });
  }

  async function ingestNew(uid: number, mailbox: string, idx: { byMid: Map<string, Note>; byPath: Map<string, Note> }): Promise<void> {
    const fetched = await session.fetchSource(uid);
    if (!fetched) return;
    const m = parseMessage(fetched.source, fetched.flags, mailbox, uid, now);
    if (idx.byMid.has(m.messageId)) return; // header fetch disagreed with the full parse; the note exists
    const path = notePath(m);
    const content = noteContent(m, opts.tz);
    const metadata = noteMetadata(m, opts.account, opts.tz);
    const hashes = { contentSha256: sha(content), metadataHashes: keyHashes(metadata) };

    const atPath = idx.byPath.get(path);
    if (atPath) {
      res.collisions++;
      intent({ action: "skip-collision", effect: opts.shadow ? "shadow" : "logged", mailbox, uid, noteId: atPath.id, path, reason: "path held by a note without this Message-ID" });
      return;
    }

    let links: NoteLinkInput[] | undefined;
    if (opts.linkPeople) {
      people ??= await PeopleIndex.load(vault);
      const name = extractDisplayName(m.from);
      const addr = extractEmailAddress(m.from);
      const hit = name ? await people.findOrCreate(vault, name, { email: addr.includes("@") ? addr : null, allowCreate: false }) : null;
      if (hit) links = [{ target: hit.id, relationship: EMAIL_FROM }];
    }

    if (opts.shadow) {
      res.created++;
      intent({ action: "create", effect: "shadow", mailbox, uid, path, ...hashes });
      return;
    }
    const note = await vault.createNote({ content, path, metadata, tags: ["email"], ...(links ? { links } : {}), ifExists: "ignore" });
    if (note.existed) {
      // Lost a race (e.g. the script still running): the note at the path stands.
      res.collisions++;
      intent({ action: "skip-collision", effect: "logged", mailbox, uid, noteId: note.id, path, reason: "created concurrently by another writer" });
    } else {
      res.created++;
      if (links) res.linked++;
      intent({ action: "create", effect: "applied", mailbox, uid, noteId: note.id, path, ...hashes });
    }
    idx.byMid.set(m.messageId, note);
    idx.byPath.set(path, note);
  }
}

// ── modes, persistence, runner ───────────────────────────────────────────────

export type ProtonMode = "off" | "shadow" | "live";

/** Shadow wins over enabled: PROTON_SHADOW=true can never write. */
export function protonMode(): ProtonMode {
  if (config.protonShadow) return "shadow";
  return config.protonSyncEnabled ? "live" : "off";
}

const INTENTS_KEY = "proton-intents";
const LAST_PASS_KEY = "proton-last-pass";
const UIDVALIDITY_KEY = "proton-uidvalidity";

export function readProtonIntents(vaultId: string): ProtonIntent[] {
  try {
    const raw = getWorkerCursor(vaultId, INTENTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as ProtonIntent[]) : [];
  } catch {
    return [];
  }
}

export function readProtonLastPass(vaultId: string): unknown {
  try {
    const raw = getWorkerCursor(vaultId, LAST_PASS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistPass(vaultId: string, res: ProtonPassResult): void {
  const keep = Math.max(0, config.protonIntentsKeep);
  if (res.intents.length && keep) {
    setWorkerCursor(vaultId, INTENTS_KEY, JSON.stringify([...readProtonIntents(vaultId), ...res.intents].slice(-keep)));
  }
  const { intents, ...summary } = res;
  setWorkerCursor(vaultId, LAST_PASS_KEY, JSON.stringify({ at: new Date().toISOString(), ...summary, intentCount: intents.length }));
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(vaultId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(vaultId, next);
  try {
    return await next;
  } finally {
    if (locks.get(vaultId) === next) locks.delete(vaultId);
  }
}

let testSource: ((cred: ProtonCredential) => ImapSource) | null = null;
/** Tests only: route the worker/route through a fake IMAP source. Never Bridge in tests. */
export function setProtonSourceForTests(f: ((cred: ProtonCredential) => ImapSource) | null): void {
  testSource = f;
}

const loggedNoCred = new Set<string>();

export function summarizeProton(tag: string, res: ProtonPassResult): string {
  const boxes = res.mailboxes.map((b) => `${b.name} ${b.window}w/${b.new}n/${b.known}k${b.skipped ? ` (${b.skipped})` : ""}`).join(", ");
  return (
    `[proton] ${tag} since ${res.window.since} [${res.mode}]: ${boxes || "no mailboxes"} → +${res.created} created ~${res.flagUpdates} flags =${res.unchanged} unchanged` +
    (res.collisions ? `, ${res.collisions} collisions` : "") +
    (res.deferred ? `, ${res.deferred} deferred` : "") +
    (res.linked ? `, ${res.linked} linked` : "") +
    (res.failed ? ` !${res.failed} FAILED` : "") +
    ` (${res.lists} vault list)`
  );
}

/**
 * One background pass for a vault (worker tick). No-op when PROTON_SYNC_ENABLED
 * and PROTON_SHADOW are both off, or the vault has no `proton-bridge` credential.
 * Throttled to one pass per PROTON_INTERVAL_MS slot; `force` bypasses that.
 * Throws (with a scrubbed message) when Bridge or the vault listing fails, or
 * every new message failed, so the health registry sees it.
 */
export async function runProtonOnce(entry: VaultEntry, opts: { force?: boolean; source?: ImapSource; now?: number } = {}): Promise<number> {
  const mode = protonMode();
  if (mode === "off") return 0;
  const raw = getSecret(entry.id, config.ownerEmail, PROTON_CREDENTIAL);
  if (!raw) {
    if (!loggedNoCred.has(entry.id)) {
      loggedNoCred.add(entry.id);
      console.log(`[proton] ${entry.id}: no proton-bridge credential — proton ingest idle`);
    }
    return 0;
  }
  if (config.protonIntervalMs <= 0 && !opts.force) return 0;
  const now = opts.now ?? Date.now();
  const slot = Math.floor(now / Math.max(1, config.protonIntervalMs));
  if (!opts.force) {
    if (getWorkerCursor(entry.id, "proton-slot") === String(slot)) return 0;
    setWorkerCursor(entry.id, "proton-slot", String(slot)); // claim up front
  }
  let cred: ProtonCredential | null = null;
  try {
    cred = validateProtonCredential(JSON.parse(raw));
    const c = cred;
    const source = opts.source ?? testSource?.(c) ?? imapflowSource(c);
    const uidValidity = (() => {
      try {
        return JSON.parse(getWorkerCursor(entry.id, UIDVALIDITY_KEY) ?? "{}") as Record<string, string>;
      } catch {
        return {};
      }
    })();
    const res = await withLock(entry.id, () =>
      syncProton(source, vaultClient(entry.id) as unknown as ProtonVault, {
        mailboxes: config.protonMailboxes,
        sinceDays: config.protonSinceDays,
        maxPerMailbox: config.protonMaxPerPass,
        shadow: mode === "shadow",
        account: c.username,
        tz: config.protonTimezone || undefined,
        linkPeople: config.protonLinkPeople,
        now,
        uidValidity,
        log: (l) => console.log(`[proton] ${entry.id}: ${scrubProtonError(l, c)}`),
      }),
    );
    setWorkerCursor(entry.id, UIDVALIDITY_KEY, JSON.stringify(uidValidity));
    persistPass(entry.id, res);
    console.log(summarizeProton(entry.id, res));
    const attempted = res.created + res.failed;
    if (res.failed && res.failed === attempted) throw new Error(`proton: all ${res.failed} message write(s) failed`);
    return res.created + res.flagUpdates;
  } catch (e) {
    throw new Error(scrubProtonError((e as Error)?.message ?? String(e), cred));
  }
}

/**
 * For the overseer's shadow comparison: re-read what the script actually wrote
 * for each intent and report — never content or values, only whether it
 * matches. `create` → the note at that path: `match` (content + every metadata
 * key identical), `differs` (+ which: "content" and/or metadata KEY names),
 * `missing` (the script has not written it). `update-flags` → `match` when the
 * note's isUnread now equals the intended value. Read-only. Newest first.
 */
export async function verifyProtonIntents(
  vaultId: string,
  intents: ProtonIntent[],
  vault: Pick<ProtonVault, "getNote"> = vaultClient(vaultId),
  limit = 100,
): Promise<Array<{ action: ProtonIntentAction; effect: ProtonIntentEffect; at: string; uid: number; path?: string; noteId?: string; now: "match" | "differs" | "missing" | "unknown"; differs?: string[] }>> {
  const out: Awaited<ReturnType<typeof verifyProtonIntents>> = [];
  const done = new Set<string>();
  for (const i of [...intents].reverse()) {
    if (out.length >= limit) break;
    const key = i.action === "create" ? `c:${i.path}` : `u:${i.noteId}`;
    if ((i.action !== "create" && i.action !== "update-flags") || done.has(key) || (i.action === "create" && !i.path) || (i.action === "update-flags" && !i.noteId)) continue;
    done.add(key);
    const row = { action: i.action, effect: i.effect, at: i.at, uid: i.uid, path: i.path, noteId: i.noteId };
    try {
      const n = await vault.getNote(i.action === "create" ? i.path! : i.noteId!);
      if (i.action === "create") {
        const differs: string[] = [];
        if (i.contentSha256 && sha(n.content ?? "") !== i.contentSha256) differs.push("content");
        const theirs = keyHashes((n.metadata ?? {}) as Record<string, unknown>);
        for (const [k, h] of Object.entries(i.metadataHashes ?? {})) if (theirs[k] !== h) differs.push(k);
        out.push({ ...row, now: differs.length ? "differs" : "match", ...(differs.length ? { differs } : {}) });
      } else {
        const want = i.change?.isUnread;
        const ok = want === undefined || Boolean(n.metadata?.isUnread) === want;
        const okUid = i.change?.uid === undefined || n.metadata?.uid === i.change.uid;
        const differs = [...(ok ? [] : ["isUnread"]), ...(okUid ? [] : ["uid"])];
        out.push({ ...row, now: differs.length ? "differs" : "match", ...(differs.length ? { differs } : {}) });
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      out.push({ ...row, now: status === 404 || /\b404\b/.test(String(e)) ? "missing" : "unknown" });
    }
  }
  return out;
}

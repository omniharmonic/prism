/**
 * The BlueBubbles connector's runtime: the worker pass (poll fallback + bounded backfill +
 * projection refresh), the webhook queue, and the per-process caches (contacts book, thread
 * listing). One BlueBubbles Server (the Mac this server runs on) → the PRIMARY vault only.
 *
 * Cursors (worker cursors in settings, per vault — no secrets):
 *   bluebubbles-after     epoch ms: the poll reads messages created after it (minus an overlap)
 *   bluebubbles-backfill  JSON {floor, before, done}: newest-first backfill, one page a pass,
 *                         from the first run back to `floor` (= first run − BLUEBUBBLES_BACKFILL_DAYS)
 *
 * Every message's vault outcome is recorded once (bluebubbles_seen), so the webhook, the poll
 * and the backfill can all deliver the same message without a duplicate line.
 */
import { config, type VaultEntry } from "../config";
import { db, getWorkerCursor, resolveVaultEntry, setWorkerCursor } from "../db";
import { recordEchoClientId } from "../comms/send-ledger";
import { vaultClient, type Note } from "../parachute";
import { PeopleIndex, titleOf } from "../worker/people";
import { PERSON_IDENTITY_KEYS } from "../people-metadata";
import { ownerProfile } from "../identity";
import { ownerConfigFor } from "../people-owner";
import { passSkipped } from "../worker/pass-skip";
import type { IngestVault } from "../worker/matrix";
import type { BbChat, BbMessage, BlueBubblesClient } from "./client";
import { blueBubblesActive, blueBubblesClient } from "./config";
import { EMPTY_BOOK, loadContacts, makeContactBook, type ContactBook } from "./contacts";
import { chatOfMessage, ingestBlueBubbles, listBbThreads, type BbIngestResult } from "./ingest";
import { errorForLog, redactRef } from "./map";
import { chatFor, projectChat, publishLive } from "./project";
import { commsStatus } from "../comms/triage";
import { noteBlueBubblesReachable, noteBlueBubblesUnreachable } from "./ready";
import { getChatCached, pruneSeen, putChat, seenGuids, staleOtpGuids } from "./state";

export const AFTER_CURSOR = "bluebubbles-after";
export const BACKFILL_CURSOR = "bluebubbles-backfill";
/** GUIDs whose chat write failed (review M8): re-read and retried first thing every pass. */
export const RETRY_CURSOR = "bluebubbles-retry";
const RETRY_MAX = 500;
const IDENTITY_EVERY_MS = 60 * 60_000;
/** The poll re-reads this much before its cursor (a message stamped just before the last pass). */
const POLL_OVERLAP_MS = 2 * 60_000;
const POLL_PAGE = 500;
const POLL_MAX_PAGES = 5;
const PROJECT_EVERY_MS = 30 * 60_000;
const BOOK_TTL_MS = 30 * 60_000;
const ROWS_TTL_MS = 10 * 60_000;
const MAX_CHATS = 5000;
const MAX_QUEUE = 200;

export type BbClient = Pick<BlueBubblesClient, "ping" | "serverInfo" | "queryChats" | "getChat" | "getMessage" | "queryMessages" | "allContacts">;

export interface BbDeps {
  client: BbClient;
  vault: IngestVault;
  /** Person notes (lean), for strong-key names and links; null = none. */
  people: () => Promise<Note[] | null>;
  now?: () => number;
}

let depsOverride: ((vaultId: string) => BbDeps | null) | null = null;
/** Tests: inject the client, the vault and the people listing. */
export function setBlueBubblesDepsForTests(f: typeof depsOverride): void {
  depsOverride = f;
  resetBlueBubblesCachesForTests();
}

function liveDeps(vaultId: string): BbDeps | null {
  if (depsOverride) return depsOverride(vaultId);
  const client = blueBubblesClient(vaultId);
  if (!client) return null;
  const vault = vaultClient(vaultId, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  return {
    client,
    vault: vault as unknown as IngestVault,
    people: () => vault.listNotes({ tags: ["person"], includeContent: false, includeMetadata: [...PERSON_IDENTITY_KEYS, "title", "photo", "avatar"] }).catch(() => null),
  };
}

// ── caches ──────────────────────────────────────────────────────────────────

interface Context { book: ContactBook; people: PeopleIndex | null; selfName: string; ownerPersonId: string | null }
let ctxCache: { at: number; ctx: Promise<Context> } | null = null;
let rowsCache: { at: number; rows: Promise<Map<string, Note>> } | null = null;
let lastProjectAt = 0;
let lastIdentityAt = 0;

export function resetBlueBubblesCachesForTests(): void {
  ctxCache = null;
  lastIdentityAt = 0;
  rowsCache = null;
  lastProjectAt = 0;
  queue = Promise.resolve();
  queued = 0;
}

async function buildContext(vaultId: string, deps: BbDeps): Promise<Context> {
  const notes = await deps.people();
  const people = notes ? new PeopleIndex(notes) : null;
  const owner = people ? ownerProfile(people.identity, ownerConfigFor(vaultId)) : null;
  const ownerPersonId = owner?.person?.id ?? null;
  const selfName = (owner?.person && ((typeof owner.person.metadata?.name === "string" && owner.person.metadata.name.trim()) || titleOf(owner.person))) || "Me";
  const contacts = await loadContacts(deps.client).catch((e) => {
    console.warn(`[bluebubbles] contacts unavailable (${errorForLog(e)}): names fall back to handles`);
    return [];
  });
  return { book: makeContactBook(contacts, people, ownerPersonId), people, selfName: String(selfName), ownerPersonId };
}

function context(vaultId: string, deps: BbDeps): Promise<Context> {
  const now = deps.now?.() ?? Date.now();
  if (!ctxCache || now - ctxCache.at > BOOK_TTL_MS) {
    const p = buildContext(vaultId, deps);
    ctxCache = { at: now, ctx: p };
    p.catch(() => { if (ctxCache?.ctx === p) ctxCache = null; });
  }
  return ctxCache.ctx;
}

function threadRows(deps: BbDeps): Promise<Map<string, Note>> {
  const now = deps.now?.() ?? Date.now();
  if (!rowsCache || now - rowsCache.at > ROWS_TTL_MS) {
    const p = listBbThreads(deps.vault);
    rowsCache = { at: now, rows: p };
    p.catch(() => { if (rowsCache?.rows === p) rowsCache = null; });
  }
  return rowsCache.rows;
}

/** The contacts book for the read routes (EMPTY when the connector is off or not ready). */
export async function blueBubblesBook(): Promise<ContactBook> {
  const vaultId = resolveVaultEntry(undefined).id;
  const deps = liveDeps(vaultId);
  if (!deps) return EMPTY_BOOK;
  return (await context(vaultId, deps).catch(() => null))?.book ?? EMPTY_BOOK;
}

/** The read-side client (routes): null when the connector is off / unconfigured. */
export function blueBubblesReader(): BbDeps["client"] | null {
  const deps = liveDeps(resolveVaultEntry(undefined).id);
  return deps?.client ?? null;
}

// ── ingest + live ───────────────────────────────────────────────────────────

const knownChat = (guid: string): BbChat | null => getChatCached(guid)?.chat ?? null;

async function ingestAndPublish(vaultId: string, deps: BbDeps, messages: BbMessage[], live: { kind: "new" | "updated" } | null): Promise<BbIngestResult> {
  const ctx = await context(vaultId, deps);
  // Chats with participants first (the cache, else one read each).
  for (const g of new Set(messages.map((m) => m.chats?.[0]?.guid).filter((x): x is string => !!x))) {
    const inline = messages.find((m) => m.chats?.[0]?.guid === g)?.chats?.[0];
    if (inline?.participants?.length) putChat(inline);
    else await chatFor(g, deps.client);
  }
  const unseen = new Set(messages.map((m) => m.guid));
  for (const g of seenGuids([...unseen])) unseen.delete(g);
  const res = await ingestBlueBubbles(messages, knownChat, {
    vault: deps.vault,
    nameOf: (a) => ctx.book.nameOf(a),
    selfName: ctx.selfName,
    people: ctx.people,
    ownerPersonId: ctx.ownerPersonId,
    rows: await threadRows(deps),
  });
  // The live stream hears what it has not heard yet (a polled message the webhook already
  // delivered was "seen" before this call) — updated messages always.
  for (const m of messages) {
    if (!live && !unseen.has(m.guid)) continue;
    const chat = chatOfMessage(m, knownChat);
    if (!chat) continue;
    try {
      await publishLive(live?.kind ?? "new", m, chat, ctx.book, deps.client, res.notes.get(chat.guid) ?? null);
    } catch (e) {
      console.warn(`[bluebubbles] live publish for ${redactRef(chat.guid)} failed: ${errorForLog(e)}`);
    }
  }
  return res;
}

// ── webhook queue ───────────────────────────────────────────────────────────

let queue: Promise<void> = Promise.resolve();
let queued = 0;
let lastWebhookAt = 0;
export const lastBlueBubblesWebhookAt = (): number => lastWebhookAt;

/** The webhook event types this connector acts on (the rest are acknowledged and ignored). */
export const HANDLED_EVENTS = new Set(["new-message", "updated-message"]);

/**
 * Queue one verified webhook event. Processed one at a time, in order; an over-full queue
 * drops the event (the poll fallback picks the message up on the next pass). Never throws.
 */
export function enqueueWebhook(type: string, data: unknown): { accepted: boolean } {
  if (!HANDLED_EVENTS.has(type)) return { accepted: true };
  const m = data as BbMessage | null;
  if (!m || typeof m !== "object" || typeof m.guid !== "string" || !m.guid) return { accepted: false };
  if (queued >= MAX_QUEUE) {
    console.warn("[bluebubbles] webhook queue full — event dropped (the poll fallback will pick it up)");
    return { accepted: true };
  }
  lastWebhookAt = Date.now();
  queued++;
  queue = queue.then(async () => {
    try {
      await processWebhook(type, m);
    } catch (e) {
      console.warn(`[bluebubbles] webhook ${type} failed: ${errorForLog(e)}`);
    } finally {
      queued--;
    }
  });
  return { accepted: true };
}

/** Tests: resolves when every queued webhook event has been processed. */
export const webhookQueueSettled = (): Promise<void> => queue;

// One writer at a time (review I5): the webhook queue and the worker pass both write thread
// notes; run concurrently they could both create the first note of a new chat.
let writeLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => {});
  return run;
}

async function processWebhook(type: string, raw: BbMessage): Promise<void> {
  if (!blueBubblesActive() && !depsOverride) return;
  const vaultId = resolveVaultEntry(undefined).id;
  const deps = liveDeps(vaultId);
  if (!deps) return;
  // BlueBubbles is the source of truth (review M3): the payload only NAMES a message; its content
  // is read back over loopback, so a forged webhook can at most trigger a fetch.
  const m = await deps.client.getMessage(raw.guid);
  if (!m?.chats?.length) return; // not (yet) readable with its chat: the poll will see it
  noteEchoTempGuid(raw, m);
  await exclusive(() => ingestAndPublish(vaultId, deps, [m], { kind: type === "updated-message" ? "updated" : "new" }).then(() => undefined));
}

const TEMP_GUID_RE = /^prism-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const addressOf = (chatGuid: string): string => chatGuid.slice(chatGuid.lastIndexOf(";") + 1).toLowerCase();

/** A webhook for a message Prism sent carries BlueBubbles' `tempGuid` (`prism-<clientId>`,
 *  server/index.ts emitMessageMatch) and can arrive BEFORE the send's answer: record the echo's
 *  clientId so the published message carries it. The payload is only believed when the re-read
 *  message is the owner's, the transport ledger knows that clientId, and it was sent to the same
 *  chat (same address, any service prefix — a new conversation may land under `any;-;`). */
function noteEchoTempGuid(raw: BbMessage, m: BbMessage): void {
  try {
    const t = typeof raw.tempGuid === "string" ? TEMP_GUID_RE.exec(raw.tempGuid.toLowerCase()) : null;
    if (!t || !m.isFromMe) return;
    const clientId = t[1]!;
    const row = db.prepare(`SELECT chat_guid FROM bluebubbles_send WHERE client_id = ?`).get(clientId) as { chat_guid: string } | undefined;
    const chat = m.chats?.[0]?.guid;
    if (!row || !chat) return;
    const same = row.chat_guid === chat || (row.chat_guid.includes(";-;") && chat.includes(";-;") && addressOf(row.chat_guid) === addressOf(chat));
    if (same) recordEchoClientId(m.guid, clientId);
  } catch (e) {
    console.warn(`[bluebubbles] echo clientId not recorded: ${errorForLog(e)}`);
  }
}

// ── worker pass ─────────────────────────────────────────────────────────────

interface Backfill { floor: number; before: number; done: boolean }
function readBackfill(vaultId: string): Backfill | null {
  try {
    const v = JSON.parse(getWorkerCursor(vaultId, BACKFILL_CURSOR) ?? "null");
    return v && typeof v.floor === "number" && typeof v.before === "number" ? { floor: v.floor, before: v.before, done: !!v.done } : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<number> | null = null;
export const blueBubblesPassRunning = (): boolean => !!inFlight;

/** One pass for the primary vault (the worker tick). Joins a running pass. */
export function runBlueBubblesOnce(entry: VaultEntry): Promise<number> {
  if (inFlight) return inFlight;
  const p = exclusive(() => runPass(entry)).finally(() => { if (inFlight === p) inFlight = null; });
  inFlight = p;
  return p;
}

function readRetry(vaultId: string): string[] {
  try {
    const v = JSON.parse(getWorkerCursor(vaultId, RETRY_CURSOR) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RETRY_MAX) : [];
  } catch {
    return [];
  }
}

/** The GUIDs of `messages` that sit in a chat whose write failed. */
const failedGuids = (messages: BbMessage[], res: BbIngestResult): string[] =>
  res.failedChats.length ? messages.filter((m) => res.failedChats.includes(m.chats?.[0]?.guid ?? "")).map((m) => m.guid) : [];

async function runPass(entry: VaultEntry): Promise<number> {
  await Promise.resolve();
  if (entry.id !== resolveVaultEntry(undefined).id) return passSkipped(entry.id, "bluebubbles");
  const deps = liveDeps(entry.id);
  if (!deps) return passSkipped(entry.id, "bluebubbles");
  const now = deps.now?.() ?? Date.now();
  // It must BE BlueBubbles (review C1/I8): "pong" every pass, the server/info shape hourly.
  try {
    await deps.client.ping();
    if (now - lastIdentityAt >= IDENTITY_EVERY_MS) {
      const info = await deps.client.serverInfo();
      if (info.privateApi) console.warn("[bluebubbles] the server reports the Private API ON — decision D6 says off (SIP stays on); Prism does not use it");
      lastIdentityAt = now;
    }
  } catch (e) {
    noteBlueBubblesUnreachable(); // the iMessage send capability goes off until it answers again
    throw e;
  }
  noteBlueBubblesReachable();
  const ctx = await context(entry.id, deps);
  let written = 0;
  const failed = new Set<string>();

  // 0. Retries: messages whose chat write failed earlier, and OTP verdicts of an older rule (I2).
  const retry = readRetry(entry.id);
  let carried = retry; // still owed if this pass stops before retrying them
  try {
    const again = [...retry, ...staleOtpGuids(50).filter((g) => !retry.includes(g))];
    if (again.length) {
      const msgs = (await Promise.all(again.map((g) => deps.client.getMessage(g).catch(() => null)))).filter((m): m is BbMessage => !!m?.chats?.length);
      const res = await ingestBlueBubbles(msgs, knownChat, await ingestCtx(entry.id, deps));
      written += res.written;
      for (const g of failedGuids(msgs, res)) failed.add(g);
      // A retried GUID BlueBubbles no longer returns is dropped (deleted message).
    }
    carried = [];

    // 1. Projection: every chat (bounded), every 30 minutes (live events keep touched chats current).
    if (now - lastProjectAt >= PROJECT_EVERY_MS) {
      const rows = await threadRows(deps).catch(() => new Map<string, Note>());
      let offset = 0;
      for (;;) {
        const page = await deps.client.queryChats({ offset, limit: 500, withLastMessage: true });
        for (const chat of page) {
          putChat(chat);
          try {
            const note = rows.get(chat.guid);
          await projectChat(chat, ctx.book, { reader: deps.client, vaultNoteId: note?.id ?? null, ...(note ? { status: commsStatus(note.tags) } : {}) });
          } catch (e) {
            console.warn(`[bluebubbles] projection of ${redactRef(chat.guid)} failed: ${errorForLog(e)}`);
          }
        }
        offset += page.length;
        if (page.length < 500 || offset >= MAX_CHATS) break;
      }
      lastProjectAt = now;
    }

    // 2. Poll fallback: everything created since the cursor (ASC). Paged by OFFSET from one fixed
    //    lower bound (review M9), so a burst larger than a page inside the overlap never stalls it.
    const stored = Number(getWorkerCursor(entry.id, AFTER_CURSOR));
    const first = !Number.isFinite(stored) || stored <= 0;
    let after = first ? now - POLL_OVERLAP_MS : stored;
    if (first) {
      const days = config.blueBubblesBackfillDays;
      setWorkerCursor(entry.id, BACKFILL_CURSOR, JSON.stringify({ floor: now - days * 86_400_000, before: now, done: days <= 0 }));
    }
    const from = Math.max(0, after - POLL_OVERLAP_MS);
    for (let page = 0; page < POLL_MAX_PAGES; page++) {
      const { messages } = await deps.client.queryMessages({ after: from, sort: "ASC", limit: POLL_PAGE, offset: page * POLL_PAGE });
      if (!messages.length) break;
      const res = await ingestAndPublish(entry.id, deps, messages, null);
      written += res.written;
      for (const g of failedGuids(messages, res)) failed.add(g);
      after = Math.max(after, ...messages.map((m) => m.dateCreated ?? 0));
      if (messages.length < POLL_PAGE) break;
    }
    setWorkerCursor(entry.id, AFTER_CURSOR, String(after));

    // 3. Backfill: one page, newest first, until the floor.
    const bf = readBackfill(entry.id);
    if (bf && !bf.done) {
      const { messages } = await deps.client.queryMessages({ after: bf.floor, before: bf.before, sort: "DESC", limit: config.blueBubblesBackfillPage });
      // Vault only: the live stream is for what happens now, not history.
      const res = messages.length ? await ingestBlueBubbles(messages, knownChat, await ingestCtx(entry.id, deps)) : null;
      if (res) for (const g of failedGuids(messages, res)) failed.add(g);
      written += res?.written ?? 0;
      const oldest = Math.min(...messages.map((m) => m.dateCreated ?? bf.before));
      const done = messages.length < config.blueBubblesBackfillPage || !(oldest > bf.floor);
      // `before` is exclusive: step to the oldest stamp seen (+1 ms keeps same-ms siblings; the seen
      // table dedupes them). A page that did not move the bound (all one ms) steps past it.
      const next = oldest + 1 < bf.before ? oldest + 1 : oldest;
      setWorkerCursor(entry.id, BACKFILL_CURSOR, JSON.stringify({ floor: bf.floor, before: next, done }));
      if (done) console.log(`[bluebubbles] backfill complete (${config.blueBubblesBackfillDays} days)`);
    }

  } finally {
    // A failing chat no longer halts the poll or the backfill (review M8): its messages wait in
    // the retry list (bounded) and the pass reports the failure to health.
    setWorkerCursor(entry.id, RETRY_CURSOR, JSON.stringify([...new Set([...carried, ...failed])].slice(0, RETRY_MAX)));
  }
  if (now % 100 === 0) pruneSeen();
  if (failed.size) throw new Error(`${failed.size} message(s) could not be written (retried next pass)`);
  return written;
}

async function ingestCtx(vaultId: string, deps: BbDeps) {
  const ctx = await context(vaultId, deps);
  // Make sure every chat in reach has participants cached (names, DM counterpart).
  return { vault: deps.vault, nameOf: (a: string) => ctx.book.nameOf(a), selfName: ctx.selfName, people: ctx.people, ownerPersonId: ctx.ownerPersonId, rows: await threadRows(deps) };
}

/** State for /acl/workers (counts and times only). */
export function blueBubblesStatus(vaultId: string): { retrying: number; backfill: "pending" | "running" | "done"; lastWebhookAt: string | null; pollAfter: string | null } {
  const bf = readBackfill(vaultId);
  const after = Number(getWorkerCursor(vaultId, AFTER_CURSOR));
  return {
    retrying: readRetry(vaultId).length,
    backfill: !bf ? "pending" : bf.done ? "done" : "running",
    lastWebhookAt: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
    pollAfter: Number.isFinite(after) && after > 0 ? new Date(after).toISOString() : null,
  };
}

/**
 * The conversion service: every Markdown / HTML / ProseMirror conversion of NOTE
 * CONTENT the server does outside import/export goes through here.
 *
 * Why: the server is one process. `marked` is quadratic on emphasis runs,
 * turndown and the ProseMirror DOM parser recurse per nesting level, and even
 * ordinary content costs seconds per megabyte in TipTap's generateJSON /
 * generateHTML over happy-dom. Run on the event loop, one note a member authored
 * stalls collab, ingest, sign-in and the gateway for everyone.
 *
 * How:
 *  - a LINEAR pre-check (precheck.ts) classifies the input;
 *  - small, plainly-shaped inputs are converted inline (same code as the worker —
 *    convert/core.ts — so results are byte-identical, and a typical note costs no
 *    thread hop);
 *  - everything else runs in the conversion worker (the transfer worker,
 *    generalised: transfer/worker.ts + worker-pool.ts) under a hard wall-clock
 *    limit — past it the thread is terminated and respawned;
 *  - the queue is bounded (`busy`), an input that failed is remembered by hash
 *    for a while (no re-burning the worker on every reconnect), and
 *  - a failure is a typed `ConversionError`. CALLERS OWN THE FALLBACK and it must
 *    be deterministic and safe: collab seeds a read-only plain-text view that is
 *    never persisted (collab.ts), the MCP resource returns the raw body.
 *
 * Never import `marked` / `turndown` / `generateJSON` / `generateHTML` anywhere
 * else in the server (test/conversion-guard.test.ts enforces it).
 */
import { createHash } from "node:crypto";
import { TaskWorker, WorkerFailedError, WorkerTimeoutError } from "../transfer/worker-pool";
import { complexityOf, docJsonWeight, type Complexity } from "./precheck";
import * as core from "./core";
import type { DocJson } from "./core";

export type { DocJson } from "./core";
/**
 * Why a conversion did not happen.
 *  - `too_large` / `too_complex` / `too_many_nodes`: the PRE-CHECK refused the
 *    input — deterministic, the same input is refused every time;
 *  - `timeout`: the worker did not finish in its wall clock — depends on load;
 *  - `busy`: no slot (queue full, or this actor's lane is full) — says nothing
 *    about the input;
 *  - `failed`: the worker crashed, ran out of memory or never came up.
 */
export type ConversionFailure = "too_large" | "too_complex" | "too_many_nodes" | "timeout" | "busy" | "failed";
/** A refusal that is a property of the INPUT (the pre-check), not of the server's load. */
export const isDeterministicFailure = (reason: ConversionFailure): boolean => reason === "too_large" || reason === "too_complex" || reason === "too_many_nodes";

/** Who a conversion is for, and whether it is part of SAVING a live document. */
export interface ConvertOptions {
  /** A stable key for the account / link behind the request: bounds how many conversions it has in flight. */
  actor?: string | null;
  /** `store`: rendering / folding for a store — a reserved thread (or the head of the queue), never behind opens and agent writes. */
  lane?: "store" | "default";
}

/** A conversion that was refused or did not finish in budget. Callers fall back. */
export class ConversionError extends Error {
  constructor(public readonly reason: ConversionFailure) {
    super(`conversion_${reason}`);
  }
}

const envInt = (name: string, fallback: number, min = 0): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

/**
 * Heap ceiling of ONE conversion thread. The host is shared (16 GB: the vault, a
 * VM, a 7 GB local model, this server) and under a swap storm every loaded
 * document's store reaches for a thread at once — two 2 GB ceilings were a
 * quarter of the machine. 512 MB by default; what can be converted scales with it
 * (below). Raise `CONVERT_HEAP_MB` on a host with memory to spare.
 */
const HEAP_MB = envInt("CONVERT_HEAP_MB", 512, 64);

/** Limits (env-tunable; read once, `configureConversion` overrides them in tests). */
export const convertCfg = {
  /** Largest input handed to a parser at all (the vault's note ceiling is 2 MB). */
  maxChars: envInt("CONVERT_MAX_BYTES", 2_500_000, 1024),
  /** Inline (main thread) only for a body below this size — Markdown AND stored HTML (the DOM parser is super-linear in pieces no counter can fully anticipate; a small byte cap bounds every shape) … */
  inlineMaxChars: envInt("CONVERT_INLINE_MAX_BYTES", 24_000, 0),
  /** … this many emphasis/link delimiter runs in one block … */
  inlineMaxDelimiters: envInt("CONVERT_INLINE_MAX_DELIMITERS", 200, 0),
  /** … this element / blockquote nesting … */
  inlineMaxDepth: envInt("CONVERT_INLINE_MAX_DEPTH", 40, 0),
  /**
   * … and this many nodes to PARSE (Markdown lines, delimiter runs, table cells, autolinks / HTML pieces). Measured
   * on the event loop: a paragraph ≈ 0.15 ms, a list item ≈ 0.25–1 ms, a table cell ≈ 0.3–0.5 ms — 2,500 of them
   * (the old cap) was 0.4–1 s. 250 keeps every shape well under 100 ms; "not obviously tiny" goes to the worker.
   */
  inlineMaxNodes: envInt("CONVERT_INLINE_MAX_NODES", 250, 0),
  /** … (Markdown) this many characters `marked` gives a meaning to — the net under every shape the counters do not know … */
  inlineMaxSpecials: envInt("CONVERT_INLINE_MAX_SPECIALS", 600, 0),
  /** A ProseMirror document with more nodes + marks than this is not rendered at all. */
  // (measured: happy-dom + ProseMirror need ~4–5 KB of heap per node, so the defaults follow the heap: 200 nodes per MB to render …)
  maxNodes: envInt("CONVERT_MAX_NODES", Math.min(400_000, HEAP_MB * 200), 1),
  /** A note body that would parse into more nodes than this (lines + delimiter runs + tags) is refused up front (`too_many_nodes`). */
  // (… and 100 per MB to parse: refused by name up front, instead of running a thread out of memory on every open.)
  maxInputNodes: envInt("CONVERT_MAX_INPUT_NODES", Math.min(200_000, HEAP_MB * 100), 1),
  /** Conversions one actor may have in the worker at once; more wait their turn (bounded), then `busy`. */
  perActorInflight: envInt("CONVERT_PER_ACTOR_INFLIGHT", 2, 1),
  perActorWaiting: envInt("CONVERT_PER_ACTOR_WAITING", 8, 0),
  /** Refused outright (never sent to the worker): delimiter runs in one block / blockquote depth. */
  maxDelimiters: envInt("CONVERT_MAX_DELIMITERS", 20_000, 1),
  maxQuoteDepth: envInt("CONVERT_MAX_QUOTE_DEPTH", 200, 1),
  /** Wall clock per worker task: base + per megabyte, capped. */
  timeoutMs: envInt("CONVERT_TIMEOUT_MS", 8000, 20),
  timeoutPerMbMs: envInt("CONVERT_TIMEOUT_PER_MB_MS", 30_000, 0),
  timeoutMaxMs: envInt("CONVERT_TIMEOUT_MAX_MS", 60_000, 20),
  /**
   * Worker threads, tasks queued per thread, heap per thread. With two or more
   * threads the FIRST is reserved for the `store` lane. The heap is a ceiling, not
   * a reservation (see HEAP_MB; 2 MB of ordinary Markdown needs well over 768 MB
   * while its DOM and ProseMirror trees coexist — such a note needs
   * `CONVERT_HEAP_MB=2048`); idle threads exit (`idleMs`).
   */
  threads: envInt("CONVERT_THREADS", 2, 1),
  maxQueue: envInt("CONVERT_MAX_QUEUE", 32, 1),
  heapMb: HEAP_MB,
  /**
   * Circuit breaker, per thread: after this many CONSECUTIVE tasks that ended with
   * the thread killed (deadline) or dead (crash / out of memory), the thread takes
   * no work for a cool-down (doubling per re-trip up to the max) — tasks are
   * answered `busy`, nothing is spawned. One success closes it. 0 = off.
   */
  breakerFailures: envInt("CONVERT_BREAKER_FAILURES", 4, 0),
  breakerCooldownMs: envInt("CONVERT_BREAKER_COOLDOWN_MS", 30_000, 1),
  breakerCooldownMaxMs: envInt("CONVERT_BREAKER_COOLDOWN_MAX_MS", 10 * 60_000, 1),
  /** Idle threads are terminated after this long (they respawn on demand; 0 = keep). */
  idleMs: envInt("CONVERT_IDLE_MS", 5 * 60_000, 0),
  /** How long a failed input is remembered (by hash). */
  failureTtlMs: envInt("CONVERT_FAILURE_TTL_MS", 10 * 60_000, 0),
};
export type ConvertConfig = typeof convertCfg;
/** Test helper: override limits; returns a restore function. */
export function configureConversion(patch: Partial<ConvertConfig>): () => void {
  const before = { ...convertCfg };
  Object.assign(convertCfg, patch);
  return () => void Object.assign(convertCfg, before);
}

// ── worker pool ─────────────────────────────────────────────────────────────

let pool: TaskWorker[] = [];
/**
 * The thread for a task. Saving must not wait behind opening: with ≥ 2 threads the
 * first one serves ONLY the `store` lane (a store may also use any other thread
 * that is idler); everything else shares the rest. One thread: shared, and a
 * store goes to the head of its queue.
 */
function worker(lane: "store" | "default"): TaskWorker | null {
  while (pool.length < convertCfg.threads) pool.push(new TaskWorker(convertCfg.heapMb, convertCfg.maxQueue, { preload: "doc" }));
  const candidates = (pool.length < 2 ? pool : lane === "store" ? pool : pool.slice(1)).filter(breakerAdmits);
  let best = candidates[0] ?? null;
  for (const w of candidates) if (w.pending < best!.pending) best = w;
  return best;
}

// ── circuit breaker ─────────────────────────────────────────────────────────
// A task that passes its deadline costs a thread: it is terminated and the next
// task spawns a fresh one (a parser stack, up to `heapMb`). Under memory pressure
// EVERY conversion times out, and every loaded document's store retried one —
// a respawn storm exactly when the host could least afford it. Per thread:
// `breakerFailures` consecutive kills/deaths open the breaker for a cool-down;
// after it ONE task is let through (half-open) — success closes the breaker,
// another failure re-opens it for twice as long. Per thread, so the default lane
// (opens, agent writes — whatever a member can make time out) cannot take the
// store lane's thread down with it.
interface Breaker {
  fails: number;
  openUntil: number;
  cooldownMs: number;
  /** Half-open: one trial task is in flight. */
  trial: boolean;
}
let breakers = new WeakMap<TaskWorker, Breaker>();
const breakerOf = (w: TaskWorker): Breaker => {
  let b = breakers.get(w);
  if (!b) breakers.set(w, (b = { fails: 0, openUntil: 0, cooldownMs: 0, trial: false }));
  return b;
};
function breakerAdmits(w: TaskWorker): boolean {
  if (convertCfg.breakerFailures <= 0) return true;
  const b = breakerOf(w);
  if (b.openUntil === 0) return true;
  return Date.now() >= b.openUntil && !b.trial;
}
function breakerResult(w: TaskWorker, ok: boolean): void {
  if (convertCfg.breakerFailures <= 0) return;
  const b = breakerOf(w);
  b.trial = false;
  if (ok) {
    b.fails = 0;
    b.openUntil = 0;
    b.cooldownMs = 0;
    return;
  }
  b.fails++;
  if (b.openUntil !== 0 || b.fails >= convertCfg.breakerFailures) {
    b.cooldownMs = Math.min(convertCfg.breakerCooldownMaxMs, b.cooldownMs ? b.cooldownMs * 2 : convertCfg.breakerCooldownMs);
    b.openUntil = Date.now() + b.cooldownMs;
    conversionStats.breakerOpened++;
    console.warn(`[convert] ${b.fails} conversions in a row ended with the worker killed or dead — this thread takes no work for ${Math.round(b.cooldownMs / 1000)} s (callers are answered busy)`);
  }
}

// ── per-actor fairness ──────────────────────────────────────────────────────
// One account (or link) holds at most `perActorInflight` worker slots; its
// further conversions wait in ITS OWN line (bounded), not in the shared queue —
// so a member opening pathological notes in a loop delays only themself.
const actorSlots = new Map<string, { running: number; waiting: Array<() => void> }>();
async function withActorSlot<T>(actor: string | null | undefined, run: () => Promise<T>): Promise<T> {
  if (!actor) return run();
  let slot = actorSlots.get(actor);
  if (!slot) actorSlots.set(actor, (slot = { running: 0, waiting: [] }));
  if (slot.running >= convertCfg.perActorInflight) {
    if (slot.waiting.length >= convertCfg.perActorWaiting) {
      conversionStats.busy++;
      throw new ConversionError("busy");
    }
    await new Promise<void>((resolve) => slot!.waiting.push(resolve));
  } else slot.running++;
  try {
    return await run();
  } finally {
    const next = slot.waiting.shift();
    if (next) next(); // hands its slot over: `running` is unchanged
    else if (--slot.running === 0) actorSlots.delete(actor);
  }
}
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** A converter thread holds a parser stack in memory; let idle ones go (16 GB host). */
function armIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (convertCfg.idleMs <= 0) return;
  idleTimer = setTimeout(() => {
    for (const w of pool) if (w.pending === 0) void w.stop();
  }, convertCfg.idleMs);
  idleTimer.unref?.();
}
/** Shutdown / test helper: terminate the conversion threads (they respawn on demand). */
export async function stopConversionWorkers(): Promise<void> {
  const old = pool;
  pool = []; // new threads, new (closed) breakers
  await Promise.all(old.map((w) => w.stop()));
}

// ── failure memory ──────────────────────────────────────────────────────────

// Only what is (very likely) a property of the INPUT is remembered: an input
// that timed out TWICE. Never `busy`, never a worker crash / out-of-memory / boot
// timeout (`failed`) — those describe the server at that moment, and remembering
// them would keep a good note unopenable for the whole TTL. Pre-check refusals
// need no memory: the pre-check is linear and answers the same every time.
const FAILURES_MAX = 500;
const TIMEOUTS_TO_REMEMBER = 2;
const failures = new Map<string, { timeouts: number; until: number }>();
function remembered(key: string): ConversionFailure | null {
  const hit = failures.get(key);
  if (!hit) return null;
  if (hit.until <= Date.now()) {
    failures.delete(key);
    return null;
  }
  return hit.timeouts >= TIMEOUTS_TO_REMEMBER ? "timeout" : null;
}
function remember(key: string, reason: ConversionFailure): void {
  if (convertCfg.failureTtlMs <= 0 || reason !== "timeout") return;
  const timeouts = (failures.get(key)?.timeouts ?? 0) + 1;
  failures.delete(key);
  failures.set(key, { timeouts, until: Date.now() + convertCfg.failureTtlMs });
  while (failures.size > FAILURES_MAX) failures.delete(failures.keys().next().value!);
}
export function forgetConversionFailures(): void {
  failures.clear();
  breakers = new WeakMap(); // …and every thread's circuit breaker is closed again
}
const hashOf = (op: string, text: string): string => createHash("sha256").update(op).update("\0").update(text).digest("base64");

// ── stats (health / tests) ──────────────────────────────────────────────────

export const conversionStats = { inline: 0, worker: 0, refused: 0, timeouts: 0, failed: 0, busy: 0, remembered: 0, breakerOpened: 0, breakerRefused: 0 };

// ── the two execution paths ─────────────────────────────────────────────────

const timeoutFor = (chars: number): number => Math.min(convertCfg.timeoutMaxMs, Math.ceil(convertCfg.timeoutMs + (convertCfg.timeoutPerMbMs * chars) / 1_000_000));

function refusal(c: Complexity): ConversionFailure | null {
  if (c.chars > convertCfg.maxChars) return "too_large";
  if (c.nodes > convertCfg.maxInputNodes) return "too_many_nodes";
  if (c.delimiterRuns > convertCfg.maxDelimiters || c.quoteDepth > convertCfg.maxQuoteDepth) return "too_complex";
  return null;
}
function cheap(c: Complexity, _markdown: boolean): boolean {
  return (
    // Both kinds are held to a small size: the node count is what costs, but
    // counting is only as good as our knowledge of the parser (stored HTML was
    // once inline up to 2.5 MB "by node count", and 100 KB of lone `>` stalled
    // the loop for seconds). The byte cap bounds whatever the counters miss.
    c.chars <= convertCfg.inlineMaxChars &&
    c.nodes <= convertCfg.inlineMaxNodes &&
    c.delimiterRuns <= convertCfg.inlineMaxDelimiters &&
    c.quoteDepth <= convertCfg.inlineMaxDepth &&
    c.nestDepth <= convertCfg.inlineMaxDepth &&
    c.htmlDepth <= convertCfg.inlineMaxDepth &&
    c.specials <= convertCfg.inlineMaxSpecials
  );
}

/** The pre-check verdict for a note body, without converting: null = a parser may try. */
export function conversionRefusal(content: string, markdown: boolean): ConversionFailure | null {
  return refusal(complexityOf(content, markdown));
}
/** May this body be converted on the calling thread? (the synchronous helpers' guard) */
export function isCheapContent(content: string, markdown: boolean): boolean {
  return cheap(complexityOf(content, markdown), markdown);
}

function offThread<T>(message: unknown, chars: number, opts: ConvertOptions | undefined): Promise<T> {
  return withActorSlot(opts?.actor, () => runInWorker<T>(message, chars, opts?.lane ?? "default"));
}
async function runInWorker<T>(message: unknown, chars: number, lane: "store" | "default"): Promise<T> {
  const w = worker(lane);
  if (!w) {
    // Every thread this lane may use is cooling down: nothing is spawned.
    conversionStats.breakerRefused++;
    conversionStats.busy++;
    throw new ConversionError("busy");
  }
  conversionStats.worker++;
  const b = breakerOf(w);
  if (b.openUntil !== 0) b.trial = true; // half-open: this is the one trial
  try {
    const value = await w.run<T>(message, timeoutFor(chars), [], lane === "store");
    armIdleStop();
    breakerResult(w, true);
    return value;
  } catch (e) {
    armIdleStop();
    if (e instanceof WorkerTimeoutError) {
      conversionStats.timeouts++;
      breakerResult(w, false);
      throw new ConversionError("timeout");
    }
    if (e instanceof WorkerFailedError && e.code === "busy") {
      b.trial = false;
      conversionStats.busy++;
      throw new ConversionError("busy");
    }
    conversionStats.failed++;
    // `worker_failed` = the thread died or never came up; an ordinary error reply
    // (a parser threw on this input) leaves the thread alive and is no respawn.
    breakerResult(w, !(e instanceof WorkerFailedError && e.code === "worker_failed"));
    throw new ConversionError("failed");
  }
}

/** One text-input conversion: pre-check → remembered failure → inline or worker. */
async function convertText<T>(op: string, text: string, markdown: boolean, inline: () => T, message: unknown, opts?: ConvertOptions): Promise<T> {
  const c = complexityOf(text, markdown);
  const refused = refusal(c);
  if (refused) {
    conversionStats.refused++;
    throw new ConversionError(refused);
  }
  if (cheap(c, markdown)) {
    conversionStats.inline++;
    try {
      return inline();
    } catch {
      conversionStats.failed++;
      throw new ConversionError("failed");
    }
  }
  const key = hashOf(op, text);
  const known = remembered(key);
  if (known) {
    conversionStats.remembered++;
    throw new ConversionError(known);
  }
  try {
    return await offThread<T>(message, c.chars, opts);
  } catch (e) {
    if (e instanceof ConversionError) remember(key, e.reason);
    throw e;
  }
}

// ── public API ──────────────────────────────────────────────────────────────

const usesMarkdown = (content: string): boolean => !core.isStoredHtml(content);

/** Markdown → HTML (marked defaults; NOT sanitised — collab's seed input, never served as-is). */
export function markdownToHtml(md: string, opts?: ConvertOptions): Promise<string> {
  return convertText("md-html", md, true, () => core.markdownToHtmlSync(md), { op: "md-html", content: md }, opts);
}

/** HTML → Markdown (for an agent reading a document note). */
export function htmlToMarkdown(html: string, opts?: ConvertOptions): Promise<string> {
  return convertText("html-md", html, false, () => core.htmlToMarkdownSync(html), { op: "html-md", html }, opts);
}

/** HTML → Markdown for blocks appended to a Markdown page: Prism-only blocks stay as HTML blocks. */
export function blocksHtmlToMarkdown(html: string, opts?: ConvertOptions): Promise<string> {
  return convertText("html-md-blocks", html, false, () => core.blocksHtmlToMarkdownSync(html), { op: "html-md", html, flavor: "blocks" }, opts);
}

/** A note body (stored HTML or Markdown) → ProseMirror JSON of the shared schema. */
export function contentToDocJson(content: string, opts?: ConvertOptions): Promise<DocJson> {
  const src = content ?? "";
  return convertText("doc-json", src, usesMarkdown(src), () => core.contentToDocJsonSync(src), { op: "doc-json", content: src, markdown: true }, opts);
}

/** HTML → ProseMirror JSON with no Markdown step. */
export function htmlToDocJson(html: string, opts?: ConvertOptions): Promise<DocJson> {
  return convertText("html-json", html, false, () => core.htmlToDocJsonSync(html), { op: "doc-json", content: html, markdown: false }, opts);
}

/** A note body → the encoded state of a fresh Y.Doc (the first-ever seed of a live document). */
export function contentToSeed(content: string, opts?: ConvertOptions): Promise<Uint8Array> {
  const src = content ?? "";
  return convertText("doc-seed", src, usesMarkdown(src), () => core.contentToSeedSync(src), { op: "doc-seed", content: src }, opts);
}

/**
 * May this document be rendered on the calling thread? Few nodes, shallow — and
 * SMALL: text and attribute strings together within the inline byte cap (it used
 * to be the node count alone, so megabytes of text in one paragraph, or in one
 * attribute, rendered on the event loop).
 */
/** Rendering is 20–50× cheaper per node than parsing (≈ 5–20 µs): ten times the parse cap in nodes + marks. */
const inlineRenderNodes = (): number => convertCfg.inlineMaxNodes * 10;
const cheapDoc = (w: { complete: boolean; depth: number; chars: number }): boolean => w.complete && w.depth <= convertCfg.inlineMaxDepth && w.chars <= convertCfg.inlineMaxChars;

/** ProseMirror JSON → the HTML a collab store writes. */
export async function docJsonToHtml(json: unknown, opts?: ConvertOptions): Promise<string> {
  const w = docJsonWeight(json, inlineRenderNodes());
  if (cheapDoc(w)) {
    conversionStats.inline++;
    try {
      return core.docJsonToHtmlSync(json);
    } catch {
      conversionStats.failed++;
      throw new ConversionError("failed");
    }
  }
  const full = w.complete ? w : docJsonWeight(json);
  // Far beyond anything a 2 MB note can hold: not worth a structured clone.
  if (full.chars > convertCfg.maxChars * 2 || full.nodes > convertCfg.maxNodes) {
    conversionStats.refused++;
    throw new ConversionError(full.nodes > convertCfg.maxNodes ? "too_many_nodes" : "too_large");
  }
  // The deadline scales with the output: text plus ~40 bytes of markup per node.
  return offThread<string>({ op: "doc-html", json }, full.chars + full.nodes * 40, opts);
}

// ── bounded synchronous forms ───────────────────────────────────────────────
// For code that is synchronous by nature (Yjs transactions, pure test helpers).
// They convert on the calling thread ONLY when the input passes the inline
// pre-check, and throw ConversionError("too_large") otherwise — so they can never
// stall the event loop, whatever they are handed.

function assertCheapText(content: string, markdown: boolean): void {
  if (!isCheapContent(content, markdown)) throw new ConversionError("too_large");
}
export function contentToDocJsonBounded(content: string): DocJson {
  const src = content ?? "";
  assertCheapText(src, usesMarkdown(src));
  return core.contentToDocJsonSync(src);
}
export function htmlToDocJsonBounded(html: string): DocJson {
  assertCheapText(html, false);
  return core.htmlToDocJsonSync(html);
}
export function contentToSeedBounded(content: string): Uint8Array {
  const src = content ?? "";
  assertCheapText(src, usesMarkdown(src));
  return core.contentToSeedSync(src);
}
export function docJsonToHtmlBounded(json: unknown): string {
  if (!cheapDoc(docJsonWeight(json, inlineRenderNodes()))) throw new ConversionError("too_large");
  return core.docJsonToHtmlSync(json);
}

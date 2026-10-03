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
export type ConversionFailure = "too_large" | "too_complex" | "timeout" | "busy" | "failed";

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

/** Limits (env-tunable; read once, `configureConversion` overrides them in tests). */
export const convertCfg = {
  /** Largest input handed to a parser at all (the vault's note ceiling is 2 MB). */
  maxChars: envInt("CONVERT_MAX_BYTES", 2_500_000, 1024),
  /** Inline (main thread) only for Markdown below this size (stored HTML: by node count, below) … */
  inlineMaxChars: envInt("CONVERT_INLINE_MAX_BYTES", 24_000, 0),
  /** … this many emphasis/link delimiter runs in one block … */
  inlineMaxDelimiters: envInt("CONVERT_INLINE_MAX_DELIMITERS", 200, 0),
  /** … this element / blockquote nesting … */
  inlineMaxDepth: envInt("CONVERT_INLINE_MAX_DEPTH", 40, 0),
  /** … and this many nodes to build (HTML tags / Markdown lines + delimiters / a ProseMirror document's nodes + marks). */
  inlineMaxNodes: envInt("CONVERT_INLINE_MAX_NODES", 2500, 0),
  /** A ProseMirror document with more nodes + marks than this is not rendered at all. */
  maxNodes: envInt("CONVERT_MAX_NODES", 1_500_000, 1),
  /** Refused outright (never sent to the worker): delimiter runs in one block / blockquote depth. */
  maxDelimiters: envInt("CONVERT_MAX_DELIMITERS", 20_000, 1),
  maxQuoteDepth: envInt("CONVERT_MAX_QUOTE_DEPTH", 200, 1),
  /** Wall clock per worker task: base + per megabyte, capped. */
  timeoutMs: envInt("CONVERT_TIMEOUT_MS", 8000, 20),
  timeoutPerMbMs: envInt("CONVERT_TIMEOUT_PER_MB_MS", 30_000, 0),
  timeoutMaxMs: envInt("CONVERT_TIMEOUT_MAX_MS", 60_000, 20),
  /** Worker threads, tasks queued per thread, heap per thread. */
  threads: envInt("CONVERT_THREADS", 2, 1),
  maxQueue: envInt("CONVERT_MAX_QUEUE", 32, 1),
  heapMb: envInt("CONVERT_HEAP_MB", 768, 64),
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
function worker(): TaskWorker {
  while (pool.length < convertCfg.threads) pool.push(new TaskWorker(convertCfg.heapMb, convertCfg.maxQueue, { preload: "doc" }));
  let best = pool[0]!;
  for (const w of pool) if (w.pending < best.pending) best = w;
  return best;
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
  pool = [];
  await Promise.all(old.map((w) => w.stop()));
}

// ── failure memory ──────────────────────────────────────────────────────────

const FAILURES_MAX = 500;
const failures = new Map<string, { reason: ConversionFailure; until: number }>();
function remembered(key: string): ConversionFailure | null {
  const hit = failures.get(key);
  if (!hit) return null;
  if (hit.until > Date.now()) return hit.reason;
  failures.delete(key);
  return null;
}
function remember(key: string, reason: ConversionFailure): void {
  if (convertCfg.failureTtlMs <= 0 || reason === "busy") return; // `busy` says nothing about the input
  failures.delete(key);
  failures.set(key, { reason, until: Date.now() + convertCfg.failureTtlMs });
  while (failures.size > FAILURES_MAX) failures.delete(failures.keys().next().value!);
}
export function forgetConversionFailures(): void {
  failures.clear();
}
const hashOf = (op: string, text: string): string => createHash("sha256").update(op).update("\0").update(text).digest("base64");

// ── stats (health / tests) ──────────────────────────────────────────────────

export const conversionStats = { inline: 0, worker: 0, refused: 0, timeouts: 0, failed: 0, busy: 0, remembered: 0 };

// ── the two execution paths ─────────────────────────────────────────────────

const timeoutFor = (chars: number): number => Math.min(convertCfg.timeoutMaxMs, Math.ceil(convertCfg.timeoutMs + (convertCfg.timeoutPerMbMs * chars) / 1_000_000));

function refusal(c: Complexity): ConversionFailure | null {
  if (c.chars > convertCfg.maxChars) return "too_large";
  if (c.delimiterRuns > convertCfg.maxDelimiters || c.quoteDepth > convertCfg.maxQuoteDepth) return "too_complex";
  return null;
}
function cheap(c: Complexity, markdown: boolean): boolean {
  return (
    // Text is cheap for the DOM parser, the node count is what costs; `marked`
    // additionally scans its input, so Markdown is held to a size as well.
    c.chars <= (markdown ? convertCfg.inlineMaxChars : convertCfg.maxChars) &&
    c.nodes <= convertCfg.inlineMaxNodes &&
    c.delimiterRuns <= convertCfg.inlineMaxDelimiters &&
    c.quoteDepth <= convertCfg.inlineMaxDepth &&
    c.htmlDepth <= convertCfg.inlineMaxDepth
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

async function offThread<T>(message: unknown, chars: number): Promise<T> {
  conversionStats.worker++;
  try {
    const value = await worker().run<T>(message, timeoutFor(chars));
    armIdleStop();
    return value;
  } catch (e) {
    armIdleStop();
    if (e instanceof WorkerTimeoutError) {
      conversionStats.timeouts++;
      throw new ConversionError("timeout");
    }
    if (e instanceof WorkerFailedError && e.code === "busy") {
      conversionStats.busy++;
      throw new ConversionError("busy");
    }
    conversionStats.failed++;
    throw new ConversionError("failed");
  }
}

/** One text-input conversion: pre-check → remembered failure → inline or worker. */
async function convertText<T>(op: string, text: string, markdown: boolean, inline: () => T, message: unknown): Promise<T> {
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
    return await offThread<T>(message, c.chars);
  } catch (e) {
    if (e instanceof ConversionError) remember(key, e.reason);
    throw e;
  }
}

// ── public API ──────────────────────────────────────────────────────────────

const usesMarkdown = (content: string): boolean => !core.isStoredHtml(content);

/** Markdown → HTML (marked defaults; NOT sanitised — collab's seed input, never served as-is). */
export function markdownToHtml(md: string): Promise<string> {
  return convertText("md-html", md, true, () => core.markdownToHtmlSync(md), { op: "md-html", content: md });
}

/** HTML → Markdown (for an agent reading a document note). */
export function htmlToMarkdown(html: string): Promise<string> {
  return convertText("html-md", html, false, () => core.htmlToMarkdownSync(html), { op: "html-md", html });
}

/** A note body (stored HTML or Markdown) → ProseMirror JSON of the shared schema. */
export function contentToDocJson(content: string): Promise<DocJson> {
  const src = content ?? "";
  return convertText("doc-json", src, usesMarkdown(src), () => core.contentToDocJsonSync(src), { op: "doc-json", content: src, markdown: true });
}

/** HTML → ProseMirror JSON with no Markdown step. */
export function htmlToDocJson(html: string): Promise<DocJson> {
  return convertText("html-json", html, false, () => core.htmlToDocJsonSync(html), { op: "doc-json", content: html, markdown: false });
}

/** A note body → the encoded state of a fresh Y.Doc (the first-ever seed of a live document). */
export function contentToSeed(content: string): Promise<Uint8Array> {
  const src = content ?? "";
  return convertText("doc-seed", src, usesMarkdown(src), () => core.contentToSeedSync(src), { op: "doc-seed", content: src });
}

/** ProseMirror JSON → the HTML a collab store writes. */
export async function docJsonToHtml(json: unknown): Promise<string> {
  const w = docJsonWeight(json, convertCfg.inlineMaxNodes);
  if (w.complete && w.depth <= convertCfg.inlineMaxDepth) {
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
    throw new ConversionError("too_large");
  }
  // The deadline scales with the output: text plus ~40 bytes of markup per node.
  return offThread<string>({ op: "doc-html", json }, full.chars + full.nodes * 40);
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
  const w = docJsonWeight(json, convertCfg.inlineMaxNodes);
  if (!w.complete || w.depth > convertCfg.inlineMaxDepth) throw new ConversionError("too_large");
  return core.docJsonToHtmlSync(json);
}

/**
 * Ordered fallback over a job's chain, with a record of who served each call.
 *
 * `runChain` tries each step in order; a step that fails (refused, unreachable,
 * timed out, HTTP error, empty reply) hands over to the next one. Cancellation stops
 * the chain at once. Every hand-over is LOGGED (`[providers] drafting: a:m failed
 * (…) → trying b:m`) and kept in an in-memory ring that `GET /api/agent/runner`
 * reports as `providers` — a fallback is never silent. No prompt, reply or key is
 * ever recorded: job, provider, model, outcome and a scrubbed reason only.
 *
 * Pure: backends are passed in as `attempt`, so this module imports none of them
 * (agent-exec reads `providerStatus` from here without an import cycle).
 */
import { getModelsConfig, redactedModelsConfig } from "./config";
import type { Job, RouteStep } from "./types";
import { scrubProviderText } from "./openai-compatible";

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  /** Why the step did not answer (scrubbed, one line). */
  error?: string;
}

export interface ServedBy {
  job: Job;
  provider: string;
  model: string;
  /** Steps tried before the one that answered (empty: the preferred one answered). */
  fallbacks: Attempt[];
}

export class ChainExhaustedError extends Error {
  constructor(
    public readonly job: Job,
    public readonly attempts: Attempt[],
  ) {
    super(
      attempts.length === 0
        ? `${job}: no provider is configured for this job`
        : `${job}: every provider failed — ${attempts.map((a) => `${a.provider}:${a.model}: ${a.error ?? "failed"}`).join("; ")}`,
    );
    this.name = "ChainExhaustedError";
  }
}

/** A step's own "this is a cancellation, stop the chain" error. */
export class ChainCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "ChainCancelledError";
  }
}

interface ServedEvent {
  at: number;
  job: Job;
  provider: string;
  model: string;
  ok: boolean;
  /** Set on a call that only succeeded after the preferred step(s) failed. */
  fellBackFrom?: string[];
  error?: string;
}

const RING = 50;
const recent: ServedEvent[] = [];
let lastFallback: ServedEvent | null = null;

function remember(ev: ServedEvent): void {
  recent.push(ev);
  if (recent.length > RING) recent.shift();
  if (ev.fellBackFrom?.length) lastFallback = ev;
}

/** Record a served call made outside `runChain` (e.g. the skills scheduler choosing a step). */
export function noteServed(job: Job, step: RouteStep, fallbacks: Attempt[] = [], log: (m: string) => void = console.log): void {
  if (fallbacks.length) log(`[providers] ${job}: served by ${step.provider}:${step.model} after ${fallbacks.map((a) => `${a.provider}:${a.model} (${a.error ?? "failed"})`).join(", ")}`);
  remember({ at: Date.now(), job, provider: step.provider, model: step.model, ok: true, ...(fallbacks.length ? { fellBackFrom: fallbacks.map((a) => `${a.provider}:${a.model}`) } : {}) });
}
/** Record a job that no step could serve. */
export function noteExhausted(job: Job, attempts: Attempt[]): void {
  const last = attempts[attempts.length - 1];
  remember({ at: Date.now(), job, provider: last?.provider ?? "-", model: last?.model ?? "-", ok: false, error: new ChainExhaustedError(job, attempts).message.slice(0, 500) });
}

/**
 * Try `steps` in order. `attempt` runs one step; throwing ChainCancelledError (or an
 * aborted `signal`) stops the chain; any other error moves to the next step.
 */
export async function runChain<S extends RouteStep, T>(
  job: Job,
  steps: readonly S[],
  attempt: (step: S) => Promise<T>,
  opts: { signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<{ value: T; servedBy: ServedBy }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const tried: Attempt[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (opts.signal?.aborted) throw new ChainCancelledError();
    try {
      const value = await attempt(step);
      noteServed(job, step, tried, log);
      return { value, servedBy: { job, provider: step.provider, model: step.model, fallbacks: tried } };
    } catch (e) {
      if (e instanceof ChainCancelledError || opts.signal?.aborted) throw new ChainCancelledError();
      const error = scrubProviderText((e as Error)?.message ?? String(e)).slice(0, 300);
      tried.push({ provider: step.provider, model: step.model, ok: false, error });
      const next = steps[i + 1];
      log(`[providers] ${job}: ${step.provider}:${step.model} failed (${error})${next ? ` → trying ${next.provider}:${next.model}` : " — no fallback left"}`);
    }
  }
  noteExhausted(job, tried);
  throw new ChainExhaustedError(job, tried);
}

/** For GET /api/agent/runner: the active config (redacted) + who served recent calls. */
export function providerStatus(): {
  config: ReturnType<typeof redactedModelsConfig> | { error: string };
  recent: ServedEvent[];
  lastFallback: ServedEvent | null;
} {
  let config: ReturnType<typeof redactedModelsConfig> | { error: string };
  try {
    config = redactedModelsConfig(getModelsConfig());
  } catch (e) {
    config = { error: (e as Error).message.slice(0, 2000) };
  }
  return { config, recent: recent.slice(-20), lastFallback };
}

/** Tests: forget the served-call ring. */
export function _resetProviderStatus(): void {
  recent.length = 0;
  lastFallback = null;
}

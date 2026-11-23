/**
 * Probing a running server: `/health?live=1` (process liveness, no vault call — the
 * watchdog probe), `/health` (is the vault reachable) and `/api/version`.
 */
export type Fetch = (
  url: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface Probe {
  live: boolean;
  vault: boolean | null;
  version: string | null;
}

async function getJson(fetchFn: Fetch, url: string, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  } catch {
    return null;
  }
}

export async function probe(fetchFn: Fetch, base: string, timeoutMs = 3000): Promise<Probe> {
  const live = await getJson(fetchFn, `${base}/health?live=1`, timeoutMs);
  if (!live || live.status !== 200) return { live: false, vault: null, version: null };
  const [health, ver] = await Promise.all([getJson(fetchFn, `${base}/health`, timeoutMs), getJson(fetchFn, `${base}/api/version`, timeoutMs)]);
  const version = ver && ver.status === 200 && typeof (ver.body as { version?: unknown })?.version === "string" ? (ver.body as { version: string }).version : null;
  return { live: true, vault: health ? health.status === 200 : null, version };
}

export function serverBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Wait until the server is live AND answers `/api/version` with `version`. Resolves with
 * the last probe; `ok` false on timeout. The vault does not have to be reachable.
 *
 * `failFast` (optional) is asked once per round while the server is not yet healthy: a
 * non-null answer ends the wait at once (`exited: true`, that answer as the reason) — used by
 * `prism update` to stop waiting for a server whose process has died (see `ExitWatch`).
 * While it answers null the wait runs to the full timeout, as before.
 */
export async function waitHealthy(
  fetchFn: Fetch,
  base: string,
  version: string,
  opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; failFast?: () => Promise<string | null> },
): Promise<{ ok: boolean; last: Probe; reason?: string; exited?: boolean }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  let last: Probe = { live: false, vault: null, version: null };
  for (;;) {
    last = await probe(fetchFn, base);
    if (last.live && last.version === version) return { ok: true, last };
    const dead = opts.failFast ? await opts.failFast() : null;
    if (dead) return { ok: false, last, reason: dead, exited: true };
    if (now() >= deadline) {
      return { ok: false, last, reason: !last.live ? "the server did not answer /health?live=1" : `the server answers version ${last.version ?? "unknown"}, expected ${version}` };
    }
    await sleep(opts.intervalMs ?? 1000);
  }
}

/** What `launchctl print` says about one agent (cli/launchd.ts `AgentInfo`, the fields used here). */
export interface ProcessInfo {
  loaded: boolean;
  pid: number | null;
  lastExit: string | null;
}

/**
 * Tells "the server process died" apart from "the server is still starting", from successive
 * `launchctl print` readings of the server agent (pure; fed by the caller).
 *
 * A process EXIT is counted when a pid that was seen running is gone at the next reading (no
 * pid, or another pid: launchd started it again). The wait ends after `exits` of them — 2 by
 * default, so the instance `kickstart -k` was replacing (a reading taken in that instant) can
 * never end it alone. An agent that is no longer loaded at all ends it at once. A process that
 * keeps running, healthy or not, never ends it: then the full health wait applies.
 */
export class ExitWatch {
  private lastPid: number | null = null;
  private exitCount = 0;
  constructor(private readonly exits = 2) {}

  observe(info: ProcessInfo): string | null {
    if (!info.loaded) return "the server agent is no longer loaded in launchd";
    if (this.lastPid !== null && info.pid !== this.lastPid) this.exitCount++;
    if (info.pid !== null) this.lastPid = info.pid;
    else this.lastPid = null;
    if (this.exitCount >= this.exits) {
      const code = info.lastExit && !/never/i.test(info.lastExit) ? ` (launchd's last exit code: ${info.lastExit})` : "";
      return `the server process exited ${this.exitCount} times while starting${code}; launchd keeps restarting it`;
    }
    return null;
  }
}

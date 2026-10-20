/**
 * The client half of the owner's local sign-in (src/auth/local-signin.ts): find the host key the
 * running server wrote, and ask that server — over loopback — for a one-time sign-in link.
 * Used by the host CLI (`prism signin`, packaging/host/cli) and by a checkout's
 * `npm run signin -w @prism/server` (scripts/local-signin.ts). No imports from the server's src:
 * the CLI is bundled without it.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type SigninFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Where the server keeps its host key — the same rule as the server's `hostKeyPath()`. */
export function hostKeyFileFor(env: Record<string, string | undefined>, baseDir: string): string | null {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  if (env.HOST_KEY_FILE !== undefined) return env.HOST_KEY_FILE.trim() ? abs(env.HOST_KEY_FILE.trim()) : null;
  const dbPath = env.DB_PATH ?? "./prism-server.db";
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file:")) return null;
  return join(dirname(abs(dbPath)), "host-signin.key");
}

/** The host key, or why it cannot be read. Never logs or returns anything about its value. */
export function readHostKey(path: string): { key: string } | { problem: string } {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { problem: `${path} is not a file` };
    if ((st.mode & 0o077) !== 0) return { problem: `${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}); restart the server to write it again` };
    const key = readFileSync(path, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) return { problem: `${path} does not hold a host key` };
    return { key };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { problem: code === "ENOENT" ? `no host key at ${path} — is the server running (it writes one when it starts)?` : `cannot read ${path} (${code ?? (e as Error).message})` };
  }
}

export interface LocalLink {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
  email: string;
  localOrigin: string;
  appOrigin: string;
  appOriginIsLocal: boolean;
}

export type LinkAnswer =
  | { ok: true; link: LocalLink }
  | { ok: false; kind: "unreachable" | "unavailable" | "refused" | "rate_limited" | "bad_answer"; status?: number; error?: string; retryAfter?: number };

/** POST /auth/local/link on `base` (a loopback origin) with the host key. */
export async function requestLocalLink(fetchFn: SigninFetch, base: string, key: string, timeoutMs = 5000): Promise<LinkAnswer> {
  let r: { status: number; json(): Promise<unknown> };
  try {
    r = await fetchFn(`${base.replace(/\/+$/, "")}/auth/local/link`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  let body: Record<string, unknown> = {};
  try {
    body = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const error = typeof body.error === "string" ? body.error : undefined;
  if (r.status === 201 && typeof body.url === "string" && typeof body.expiresAt === "string") return { ok: true, link: body as unknown as LocalLink };
  if (r.status === 503) return { ok: false, kind: "unavailable", status: r.status, error };
  if (r.status === 429) return { ok: false, kind: "rate_limited", status: r.status, error, retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined };
  if (r.status === 401 || r.status === 403 || r.status === 404) return { ok: false, kind: "refused", status: r.status, error };
  return { ok: false, kind: "bad_answer", status: r.status, error };
}

/** Only a link this server makes is ever handed to the browser. */
export const OPENABLE_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}\/auth\/local\/signin\?token=[A-Za-z0-9_-]{20,200}$/;

/**
 * Open a sign-in link in the default browser (macOS). The URL goes to AppleScript's
 * `open location` on STDIN, never as an argument: a link on a command line can be read by every
 * user of this Mac (`ps`) while the process runs.
 */
export function openInBrowser(url: string): Promise<void> {
  if (!OPENABLE_URL.test(url)) return Promise.reject(new Error("refusing to open an unexpected URL"));
  return new Promise((done, fail) => {
    const child = execFile("/usr/bin/osascript", ["-"], { timeout: 15_000 }, (err) => (err ? fail(new Error("osascript could not open the browser")) : done()));
    child.stdin?.end(`open location "${url}"\n`);
  });
}

export interface ReachAnswer {
  appOrigin: string;
  expect: { origin: string; mode: string; selfAddresses: string[]; at: string } | null;
  seen: { self?: string; outside?: string; outsideVia?: string };
}

/**
 * POST /auth/local/reach on `base` (loopback) with the host key: record (or clear, with
 * `origin: null`) what `prism reach` set up, or just read (`{}`) what the server has seen.
 */
export async function requestReachRecord(
  fetchFn: SigninFetch,
  base: string,
  key: string,
  body: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ ok: true; answer: ReachAnswer } | { ok: false; status?: number; error?: string; appOrigin?: string }> {
  let r: { status: number; json(): Promise<unknown> };
  try {
    r = await fetchFn(`${base.replace(/\/+$/, "")}/auth/local/reach`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false };
  }
  let b: Record<string, unknown> = {};
  try {
    b = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    b = {};
  }
  if (r.status === 200 && typeof b.appOrigin === "string") return { ok: true, answer: b as unknown as ReachAnswer };
  return { ok: false, status: r.status, error: typeof b.error === "string" ? b.error : undefined, appOrigin: typeof b.appOrigin === "string" ? b.appOrigin : undefined };
}

export interface LocalSetupStep {
  id: string;
  group: string;
  done: boolean;
  detail?: string;
}

/**
 * POST /auth/local/setup on `base` (loopback) with the host key: the server's setup checklist
 * (`{ready, steps}`), the same answer the app shows. A server that predates the route answers
 * `{ok: false, status: 404}`.
 */
export async function requestSetupStatus(
  fetchFn: SigninFetch,
  base: string,
  key: string,
  timeoutMs = 5000,
): Promise<{ ok: true; ready: boolean; steps: LocalSetupStep[] } | { ok: false; status?: number; error?: string }> {
  let r: { status: number; json(): Promise<unknown> };
  try {
    r = await fetchFn(`${base.replace(/\/+$/, "")}/auth/local/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false };
  }
  let b: Record<string, unknown> = {};
  try {
    b = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    b = {};
  }
  if (r.status === 200 && Array.isArray(b.steps)) {
    const steps = (b.steps as unknown[]).filter(
      (s): s is LocalSetupStep => !!s && typeof s === "object" && typeof (s as LocalSetupStep).id === "string" && typeof (s as LocalSetupStep).done === "boolean",
    );
    return { ok: true, ready: b.ready === true, steps };
  }
  return { ok: false, status: r.status, error: typeof b.error === "string" ? b.error : undefined };
}

/** What a person is told about a printed link (stderr). */
export const PRINTED_LINK_WARNING =
  "This link signs in as the server owner until it is used or expires (10 minutes). It works on this computer only. Open it here; do not paste it into a chat, a ticket or a shared terminal log.";

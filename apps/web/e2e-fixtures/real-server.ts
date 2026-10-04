/**
 * Playwright helper: run the REAL Prism Server fixture (apps/server/test/fixtures/
 * e2e-server.ts — actual gateway, collab socket and command endpoint over the
 * in-memory fake vault + in-memory SQLite) and wire a page to it:
 *   - /api/*, /auth/*, /acl/* are forwarded with the page's own headers (cookie,
 *     Origin, X-Prism-*), so CSRF/auth behave as in production;
 *   - the /collab WebSocket is bridged to the server with the session cookie.
 * The page is served by the fixture Vite server, so its origin is APP_ORIGIN.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { BrowserContext, Page } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../../server");

export interface RealServer {
  port: number;
  sessions: Record<"owner" | "sam" | "eve" | "gina", string>;
  /** Read a fake-vault note as the server holds it. */
  note(id: string): Promise<{ id: string; content: string; metadata: Record<string, unknown> | null } | null>;
  /** Replace a note's body in the fake vault, as an external writer would (a newer version). */
  put(id: string, content: string): Promise<void>;
  /** Seed one more note in the fake vault (a NEW id; the shared seed is never changed). */
  add(note: { id: string; path: string; content?: string; tags?: string[]; metadata?: Record<string, unknown> }): Promise<boolean>;
  /** Override the server's conversion limits (null restores them) — e.g. `{ inlineMaxNodes: 0, maxNodes: 1 }` makes every page "too large to save". */
  limits(patch: Record<string, number> | null): Promise<void>;
  stop(): Promise<void>;
}

export async function startRealServer(appOrigin: string): Promise<RealServer> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "--env-file=.env.test", "test/fixtures/e2e-server.ts"], {
    cwd: serverDir,
    env: { ...process.env, APP_ORIGIN: appOrigin, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      // Only the fixture's own JSON answers are protocol lines; the server also logs to stdout
      // (e.g. "[mcp] PAT … created"), and such a line must never be read as an answer.
      if (!line.startsWith("{")) continue;
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
    if (process.env.E2E_SERVER_LOG) process.stderr.write(`[fixture server] ${String(d)}`); // debugging aid
  });
  const nextLine = () =>
    new Promise<string>((resolve, reject) => {
      const l = lines.shift();
      if (l !== undefined) return resolve(l);
      const t = setTimeout(() => reject(new Error(`fixture server silent. stderr:\n${stderr.slice(-2000)}`)), 30_000);
      waiters.push((line) => {
        clearTimeout(t);
        resolve(line);
      });
    });
  const hello = JSON.parse(await nextLine()) as { port: number; sessions: RealServer["sessions"] };
  return {
    ...hello,
    async note(id) {
      child.stdin.write(JSON.stringify({ op: "note", id }) + "\n");
      return (JSON.parse(await nextLine()) as { note: never }).note;
    },
    async put(id, content) {
      child.stdin.write(JSON.stringify({ op: "put", id, content }) + "\n");
      await nextLine();
    },
    async add(note) {
      child.stdin.write(JSON.stringify({ op: "add", note }) + "\n");
      return (JSON.parse(await nextLine()) as { ok: boolean }).ok;
    },
    async limits(patch) {
      child.stdin.write(JSON.stringify({ op: "limits", limits: patch }) + "\n");
      await nextLine();
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => {
        child.once("exit", r);
        setTimeout(() => {
          child.kill("SIGKILL");
          r(null);
        }, 3000);
      });
    },
  };
}

/** Sign the page in as `who` and route its server traffic + collab socket to the fixture. */
export async function connect(page: Page, context: BrowserContext, server: RealServer, who: keyof RealServer["sessions"]): Promise<{ sockets: WebSocket[] }> {
  const sid = server.sessions[who];
  const base = new URL(page.url() === "about:blank" ? "http://127.0.0.1" : page.url());
  await context.addCookies([{ name: "prism_session", value: sid, domain: base.hostname === "about:blank" ? "127.0.0.1" : "127.0.0.1", path: "/" }]);
  await page.route((url) => /^\/(api|auth|acl)(\/|$)/.test(url.pathname), async (route) => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    } catch (error) {
      // A spec that closes its page or context with a request still in flight (the tree
      // refresh, a poll) has nothing left to answer; anything else is a real failure.
      if (!page.isClosed()) throw error;
    }
  });
  const sockets: WebSocket[] = [];
  await page.routeWebSocket(/\/collab(\?|$)/, (ws) => {
    const url = new URL(ws.url());
    const upstream = new WebSocket(`ws://127.0.0.1:${server.port}/collab${url.search}`, { headers: { cookie: `prism_session=${sid}` } });
    sockets.push(upstream);
    const pending: Array<string | Buffer> = [];
    ws.onMessage((m) => (upstream.readyState === WebSocket.OPEN ? upstream.send(m) : pending.push(m as never)));
    upstream.on("open", () => {
      for (const m of pending) upstream.send(m);
    });
    upstream.on("message", (m, binary) => ws.send(binary ? Buffer.from(m as Buffer) : m.toString()));
    ws.onClose((code, reason) => upstream.close(code && code >= 3000 ? code : 1000, reason));
    upstream.on("close", (code, reason) => ws.close({ code: code === 1005 || code === 1006 ? 1000 : code, reason: reason.toString() }));
  });
  return { sockets };
}

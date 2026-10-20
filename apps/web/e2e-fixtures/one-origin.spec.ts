/**
 * The one origin rule, end to end (server: apps/server/src/auth/origin.ts,
 * apps/server/test/one-origin.test.ts). APP_ORIGIN is a REMOTE https address (a Tailscale
 * name) while `prism signin` signs the owner in at this computer's own http://localhost:<port>.
 * The browser talks to the REAL server directly (no request routing), so Origin,
 * Sec-Fetch-Site and the cookie are exactly what the browser sends: the session cookie must be
 * stored on plain-http localhost (WebKit drops a Secure one there) and CSRF-guarded setup
 * writes from that origin must be accepted.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRealServer, type RealServer } from "./real-server";

const REMOTE = "https://prism.example.ts.net";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

let server: RealServer;
let port = 0;
let keyDir = "";
test.beforeAll(async () => {
  port = await freePort();
  keyDir = mkdtempSync(join(tmpdir(), "prism-one-origin-")); // 0700, ours: local sign-in accepts it
  server = await startRealServer(REMOTE, { env: { PORT: String(port), E2E_SERVER_PORT: String(port), HOST_KEY_FILE: join(keyDir, "host-signin.key") } });
});
test.afterAll(async () => {
  await server?.stop();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

/** What `prism signin` does: present the host key over loopback, get the one-time link. */
async function mintLink(): Promise<string> {
  const key = readFileSync(join(keyDir, "host-signin.key"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${port}/auth/local/link`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
  expect(r.status).toBe(201);
  const body = (await r.json()) as { url: string; appOrigin: string; appOriginIsLocal: boolean };
  expect(body.appOrigin).toBe(REMOTE);
  expect(body.appOriginIsLocal).toBe(false);
  return body.url;
}

test("signed in through the local link at http://localhost while APP_ORIGIN is remote https: setup writes from that origin are accepted", async ({ page, context }) => {
  const link = await mintLink();
  const local = `http://localhost:${port}`;
  expect(link.startsWith(`${local}/auth/local/signin?token=`)).toBe(true);

  // Spend it. The fixture serves no web app, so where it lands does not matter — the cookie does.
  await page.goto(link).catch(() => undefined);
  const cookies = await context.cookies(local);
  const session = cookies.find((c) => c.name === "prism_session");
  expect(session, "the session cookie is stored on plain-http localhost").toBeTruthy();
  expect(session!.secure).toBe(false);

  // A page on the local origin (same-origin requests: the browser's own Origin + Sec-Fetch-Site).
  await page.goto(`${local}/health?live=1`);
  const results = await page.evaluate(async () => {
    const send = async (path: string, method: string, body: unknown) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "include" });
      return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    };
    const me = await fetch("/auth/me", { credentials: "include" }).then((r) => r.json());
    return {
      me,
      // A setting PUT (CSRF-guarded by the shared csrfRefusal).
      settings: await send("/api/notifications/settings", "PUT", { settings: { mention: { push: false, email: true } } }),
      // A CSRF-guarded POST.
      read: await send("/api/notifications/read", "POST", { all: true }),
    };
  });
  expect((results.me as { authenticated?: boolean }).authenticated).toBe(true);
  expect(results.settings.status, JSON.stringify(results.settings.body)).toBe(200);
  expect((results.settings.body as { settings: { mention: { email: boolean } } }).settings.mention.email).toBe(true);
  expect(results.read.status, JSON.stringify(results.read.body)).toBe(200);
});

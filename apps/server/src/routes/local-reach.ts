/**
 * `POST /auth/local/reach` — the host CLI (`prism reach`) records what it set up, so the server
 * can tell its own check (a request through Tailscale from this machine) from a request by
 * another device (src/reach.ts has the rules).
 *
 * Same gate as `/auth/local/link`: a direct loopback connection, no browser, JSON, the host key
 * (`hostProofRefusal`). Body:
 *
 *   {origin: "https://<name>", mode: "serve"|"funnel", selfAddresses: ["100.x.y.z", "fd7a:…"]}
 *        → records the expectation. The origin must BE this server's APP_ORIGIN (409
 *          `origin_mismatch` otherwise: the server was not restarted after the .env change).
 *   {origin: null}  → clears it (`prism reach off`) and forgets what was seen for `forget`.
 *   {}              → changes nothing; reads.
 *
 * Answer: {appOrigin, expect, seen: {self?, outside?, outsideVia?}} for APP_ORIGIN — times and
 * this machine's own addresses only, never a client's.
 */
import { Hono } from "hono";
import { isIP } from "node:net";
import { config } from "../config";
import { reachableOrigin } from "../setup-status";
import { clearReachSeen, reachExpectation, reachSeen, setReachExpectation } from "../reach";
import { audit, hostProofRefusal } from "./local-signin";

export const localReach = new Hono();

const answer = () => ({ appOrigin: config.appOrigin, expect: reachExpectation(), seen: reachSeen() });

localReach.post("/local/reach", async (c) => {
  const refused = await hostProofRefusal(c, "auth.local-reach");
  if (refused) return refused;
  const text = await c.req.text().catch(() => null);
  if (text === null || text.length > 2048) return c.json({ error: "bad_request" }, 400);
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) return c.json({ error: "bad_request" }, 400);
      body = v as Record<string, unknown>;
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
  }
  const allowed = new Set(["origin", "mode", "selfAddresses", "forget"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) return c.json({ error: "bad_request", detail: "Unknown field." }, 400);
  if (!("origin" in body)) return c.json(answer());

  if (body.origin === null) {
    setReachExpectation(null);
    if (typeof body.forget === "string" && body.forget.length < 300) clearReachSeen(body.forget);
    audit("auth.local-reach", "ok", { cleared: true });
    return c.json(answer());
  }
  const origin = typeof body.origin === "string" ? body.origin.replace(/\/+$/, "") : "";
  if (!reachableOrigin(origin) || new URL(origin).origin !== origin) return c.json({ error: "bad_request", detail: "origin must be an https address like https://name.example.ts.net" }, 400);
  const mode = body.mode === "funnel" ? "funnel" : body.mode === "serve" ? "serve" : null;
  if (!mode) return c.json({ error: "bad_request", detail: "mode must be serve or funnel" }, 400);
  const addrs = body.selfAddresses;
  if (!Array.isArray(addrs) || addrs.length < 1 || addrs.length > 8 || addrs.some((a) => typeof a !== "string" || !isIP(a))) {
    return c.json({ error: "bad_request", detail: "selfAddresses: 1–8 IP addresses of this machine" }, 400);
  }
  if (origin !== config.appOrigin) {
    return c.json({ error: "origin_mismatch", detail: "This server's APP_ORIGIN is another address: restart it after changing .env.", appOrigin: config.appOrigin }, 409);
  }
  setReachExpectation({ origin, mode, selfAddresses: addrs as string[] });
  audit("auth.local-reach", "ok", { mode });
  return c.json(answer());
});

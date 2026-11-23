/**
 * Owner sign-in without email (auth/local-signin.ts has the why).
 *
 *  POST /auth/local/link    — the host CLI (`prism signin`) asks for a one-time link.
 *                             Loopback only + the host key + not a browser.
 *  GET  /auth/local/signin  — the browser on this computer spends it: the normal owner
 *                             session cookie, then the app (the setup checklist while setup
 *                             is unfinished; the native sign-in consent when one is waiting).
 *  POST /auth/local/setup   — the host CLI (`prism setup`) reads the setup checklist (the same
 *                             answer as `GET /acl/setup`: step ids, booleans and sentences,
 *                             never a secret). Same gate as /local/link.
 *
 * Both are under /auth/*, which the PWA service worker never answers (check:sw).
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { ensureUser, getUser } from "../db";
import { startSession } from "../auth/session";
import { recordAction } from "../actions/store";
import { consumeRateLimit, rateLimited } from "../middleware/ratelimit";
import { isHostKey, localOrigin, localSigninEnabled, loopbackRefusal, mintLocalLink, redeemLocalLink, LOCAL_LINK_TTL_MS } from "../auth/local-signin";
import { readSetupStatus, setupUnfinished } from "../setup-facts";
import { pendingDeviceRequest, DEVICE_CONTINUE_PATH } from "./device";

export const localSignin = new Hono();

const WINDOW_MS = 10 * 60_000;
/** Per server (every caller is loopback, so there is one bucket each). Tests lower them. */
export const localSigninLimits = { mints: 10, proofFailures: 10, redeems: 30 };
let generation = 0;
/** Tests: start the rate-limit buckets afresh. */
export function resetLocalSigninLimitsForTests(): void {
  generation++;
}
const key = (name: string) => `local-signin-${name}:${generation}`;

export const audit = (action: string, status: "ok" | "refused" | "failed", target: Record<string, unknown> = {}, error?: string) => {
  const host = action !== "auth.local-signin";
  recordAction({ actorEmail: config.ownerEmail, via: host ? "host-key" : "local-link", origin: host ? "agent" : "human", action, vaultId: "primary", target, status, ...(error ? { error } : {}) });
};

/**
 * Headers a browser sends with a POST and the CLI never does: a page (any origin, even this one)
 * may never mint a link. Not `sec-fetch-mode` — Node's own fetch sends that one too.
 */
const BROWSER_HEADERS = ["origin", "sec-fetch-site", "cookie"];

const noStore = (c: Context) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
};

/**
 * The host-CLI gate shared by every `/auth/local/*` call the `prism` CLI makes (a link, the
 * reachability record): a direct loopback connection, no browser, JSON, and the host key.
 * Returns the refusal, or null to go on. Proof failures share one rate-limit bucket.
 */
export async function hostProofRefusal(c: Context, action: string): Promise<Response | null> {
  noStore(c);
  // Uniform 404 off loopback: the route is not advertised to the tunnel, Tailscale or the LAN.
  if (loopbackRefusal(c)) return c.json({ error: "not_found" }, 404);
  if (!localSigninEnabled()) return c.json({ error: "local_signin_unavailable", detail: "This server has no host key (it runs on an in-memory database, or its data folder could not hold the key)." }, 503);
  if (BROWSER_HEADERS.some((h) => c.req.header(h) !== undefined)) {
    audit(action, "refused", {}, "browser request");
    return c.json({ error: "not_from_a_browser", detail: "Run the `prism` command on this computer." }, 403);
  }
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return c.json({ error: "unsupported_media_type" }, 415);
  const waitProof = rateLimited(key("proof"), localSigninLimits.proofFailures);
  if (waitProof !== null) {
    c.header("Retry-After", String(waitProof));
    return c.json({ error: "rate_limited", retryAfter: waitProof }, 429);
  }
  const auth = c.req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !isHostKey(auth.slice(7))) {
    consumeRateLimit(key("proof"), localSigninLimits.proofFailures, WINDOW_MS);
    audit(action, "refused", {}, "host proof missing or wrong");
    return c.json({ error: "host_proof_required", detail: "Present the host key from the server's data folder (the `prism` command does)." }, 401);
  }
  return null;
}

localSignin.post("/local/link", async (c) => {
  const refused = await hostProofRefusal(c, "auth.local-link");
  if (refused) return refused;
  const body = await c.req.text().catch(() => null);
  if (body === null || body.length > 1024) return c.json({ error: "bad_request" }, 400);
  if (body.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) return c.json({ error: "bad_request", detail: "The request takes no fields." }, 400);
  }
  const wait = consumeRateLimit(key("mint"), localSigninLimits.mints, WINDOW_MS);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    audit("auth.local-link", "refused", {}, "rate limited");
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }
  const link = mintLocalLink();
  audit("auth.local-link", "ok", { link: link.id });
  return c.json(
    {
      url: link.url,
      expiresAt: new Date(link.expiresAt).toISOString(),
      expiresInSeconds: Math.round(LOCAL_LINK_TTL_MS / 1000),
      email: config.ownerEmail,
      localOrigin: localOrigin(),
      appOrigin: config.appOrigin,
      /** The link signs in at this computer's own address, not at APP_ORIGIN (which is an https one). */
      appOriginIsLocal: localOrigin() === config.appOrigin,
    },
    201,
  );
});

localSignin.get("/local/signin", async (c) => {
  noStore(c);
  // Off loopback the link is never even looked at, so a leaked one cannot be spent remotely.
  if (loopbackRefusal(c)) return c.text("Not found", 404);
  // A page on another site may not spend a link it got hold of (navigations from the terminal,
  // the address bar or `open` are `none`).
  if ((c.req.header("sec-fetch-site") ?? "").toLowerCase() === "cross-site") return c.redirect("/?login=local-expired");
  const wait = consumeRateLimit(key("redeem"), localSigninLimits.redeems, WINDOW_MS);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.text("Too many sign-in attempts. Wait a few minutes, then run `prism signin` again.", 429);
  }
  const spent = redeemLocalLink(c.req.query("token") ?? "");
  if (!spent) {
    audit("auth.local-signin", "refused", {});
    return c.redirect("/?login=local-expired");
  }
  ensureUser(spent.email);
  // The local origin is plain http on loopback: a Secure cookie would be dropped there by
  // browsers that do not count localhost as secure.
  startSession(c, spent.email, { secure: false });
  audit("auth.local-signin", "ok", { link: spent.id });
  // A native sign-in waiting in this browser (the app's sign-in sheet) resumes, as after a magic link.
  if (pendingDeviceRequest(c)) return c.redirect(DEVICE_CONTINUE_PATH);
  const next = (await setupUnfinished()) ? "/setup" : "/";
  if (!getUser(spent.email)?.password_hash) return c.redirect(`/set-password?next=${encodeURIComponent(next)}`);
  return c.redirect(next);
});

/**
 * `prism setup` reads the checklist without an owner session: once the server is running, the
 * owner / device / reachable / integration steps of the run ARE the checklist's answer (same ids,
 * `setup-steps.ts`). Body `{}` or empty. A successful read is not audited (it changes nothing and
 * runs on every `prism setup`); refusals are, by the gate.
 */
localSignin.post("/local/setup", async (c) => {
  const refused = await hostProofRefusal(c, "auth.local-setup");
  if (refused) return refused;
  const body = await c.req.text().catch(() => null);
  if (body === null || body.length > 1024) return c.json({ error: "bad_request" }, 400);
  if (body.trim() && body.trim() !== "{}") return c.json({ error: "bad_request", detail: "The request takes no fields." }, 400);
  return c.json(await readSetupStatus());
});

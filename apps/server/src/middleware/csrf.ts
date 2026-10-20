/**
 * ONE cross-site write guard for every state-changing route under /api, /auth and /acl
 * (launch security review, docs/distribution/LAUNCH-PLAN.md Phase 3).
 *
 * Most JSON routes read their body with `c.req.json()`, which parses whatever arrives — it
 * never looks at the Content-Type. A `text/plain`, form or bodiless POST is a CORS "simple"
 * request: the browser sends it without a preflight, and the SameSite=Lax session cookie rides
 * it whenever the page is SAME-SITE (a sibling subdomain of APP_ORIGIN — another machine on the
 * same tailnet, `blog.example.com` beside `prism.example.com`). Only the routes that call
 * `csrfRefusal` themselves were safe; the review found ~50 that were not (publish a tag,
 * create notes, change governance, disconnect integrations, delete workspaces, …).
 *
 * Rules, for POST / PUT / PATCH / DELETE without an `Authorization` header (a browser cannot
 * attach one cross-origin without a preflight, which our CORS answers only for APP_ORIGIN and
 * the native origins — so bearer callers, native apps and scripts are untouched):
 *
 *  1. The body must not be a CORS-simple type: `text/plain`, `application/x-www-form-urlencoded`,
 *     `multipart/form-data`, or a body with NO Content-Type at all → 415. Requests with no body
 *     and no Content-Type pass this rule (rule 2 still applies to them).
 *  2. When the request carries a Cookie (the credential CSRF borrows): `Sec-Fetch-Site:
 *     cross-site | same-site` → 403, and an `Origin` that the one origin rule
 *     (`allowedOrigin`, auth/origin.ts) does not accept → 403.
 *
 * Routes keep their own checks (`csrfRefusal`, X-Prism-Upload, …): this is the floor under them.
 */
import type { Context, MiddlewareHandler } from "hono";
import { allowedOrigin } from "../auth/origin";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIMPLE_TYPES = new Set(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]);

interface Exemption {
  method: string;
  path: RegExp;
  /** The simple content type this route may take. */
  type: string;
  /** Extra condition the request must meet for the exemption to apply. */
  when?: (c: Context) => boolean;
  why: string;
}

/**
 * Routes that legitimately take a CORS-simple body. Each keeps rule 2 (Origin / Sec-Fetch-Site).
 * Add an entry ONLY with the reason the route cannot be forged cross-site anyway.
 */
export const SIMPLE_BODY_EXEMPTIONS: readonly Exemption[] = [
  {
    method: "POST",
    path: /^\/auth\/device\/approve$/,
    type: "application/x-www-form-urlencoded",
    why: "the native sign-in consent page is a server-rendered HTML <form>; it carries its own HMAC CSRF token bound to the session and the parking cookie (routes/device.ts)",
  },
  {
    method: "POST",
    path: /^\/auth\/device\/token$/,
    type: "application/x-www-form-urlencoded",
    why: "RFC 8252/6749 token endpoint: the native apps (Rust, PrismKit) post form bodies; it needs a single-use code AND its PKCE verifier, and no cookie is involved",
  },
  {
    method: "POST",
    path: /^\/auth\/device\/revoke$/,
    type: "application/x-www-form-urlencoded",
    why: "RFC 7009 revocation: possession of the token is the authority; the native apps post form bodies; no cookie is involved",
  },
  {
    method: "POST",
    path: /^\/api\/notes\/[^/]+\/attachments$/,
    type: "multipart/form-data",
    when: (c) => c.req.header("x-prism-upload") === "1",
    why: "file upload; the REQUIRED custom X-Prism-Upload header forces a CORS preflight (routes/attachments.ts)",
  },
];

const mediaType = (c: Context): string => (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

function hasBody(c: Context): boolean {
  const len = c.req.header("content-length");
  if (len !== undefined) return Number(len) > 0;
  return c.req.header("transfer-encoding") !== undefined || c.req.raw.body !== null;
}

function exempt(c: Context, path: string, type: string): boolean {
  return SIMPLE_BODY_EXEMPTIONS.some((e) => e.method === c.req.method && e.type === type && e.path.test(path) && (!e.when || e.when(c)));
}

/** The refusal for this request, or null to go on. Exported for tests. */
export function crossSiteWriteRefusal(c: Context): Response | null {
  if (!UNSAFE.has(c.req.method)) return null;
  if (c.req.header("authorization") !== undefined) return null;
  const path = new URL(c.req.url).pathname;
  const type = mediaType(c);
  if (SIMPLE_TYPES.has(type) ? !exempt(c, path, type) : type === "" && hasBody(c)) {
    return c.json({ error: "unsupported_media_type", detail: "Content-Type must be application/json" }, 415);
  }
  if (c.req.header("cookie") !== undefined) {
    const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
    if (site === "cross-site" || site === "same-site") return c.json({ error: "csrf_refused", detail: "cross-site request refused" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigin(c, origin)) return c.json({ error: "csrf_refused", detail: "request origin not allowed" }, 403);
  }
  return null;
}

export const crossSiteWriteGuard: MiddlewareHandler = async (c, next) => {
  const refused = crossSiteWriteRefusal(c);
  if (refused) return refused;
  await next();
};

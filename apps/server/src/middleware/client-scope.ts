/**
 * Client scope (Comms phase 0/1, Task 12): a `comms-native` device token reaches ONLY the
 * messaging routes. Everything else answers 403 `{error:"client_scope"}` — the vault
 * gateway, MCP, admin, ACL, events, media, the live-action send routes, account routes.
 *
 * Installed with `app.use("*", clientScope())` in app.ts BEFORE every route, so it sees
 * every request the Hono app answers, including in-process `app.request` calls that
 * forward the caller's Authorization header (omni executors). The collab WebSocket is
 * outside Hono; `auth/device.ts` `deviceEmail` refuses a comms-native token there.
 *
 * Rules (fail closed):
 *  - The bearer is read the way EVERY consumer reads it (`actor.ts` slices without trim,
 *    `bearerFromHeader` trims, `mcp/auth.ts` is case-insensitive with `\s+`): each candidate
 *    that starts with `pd_` is looked up by hash. If ANY is a `comms-native` device row
 *    (live or not — a dead one authenticates nobody, so refusing costs nothing) the
 *    request is scoped. A lookup that throws refuses every `pd_` request.
 *  - The path checked is `c.req.path`, the very string Hono routes on (the WHATWG URL
 *    parser already resolved `.`/`..` and `%2e` dot segments). On top, a scoped request is
 *    refused for an empty segment (`//`), a `.`/`..` segment, a backslash, an encoded
 *    `/`, `\`, `.` or NUL, or any control / whitespace character — nothing ambiguous.
 *  - Prefixes are matched segment-safely and case-sensitively (Hono routes are
 *    case-sensitive): `/api/omni/approvals` allows itself and `/api/omni/approvals/…`,
 *    never `/api/omni/approvalsX`. The denylist is matched case-insensitively.
 *  - Omni (ruling R17, amended for Phase 4): read approvals and cards, deny an approval, snooze
 *    or dismiss a card, and — with COMMS_OMNI_ENABLED — approve or revise a Comms reply draft
 *    (a `message` approval bound to a Comms thread). Nothing else (`omniWriteAllowed`). A `device-sign-in` approval
 *    is never decided by a scoped token (it would mint an unrestricted device).
 *  - Anything under an allowed prefix that no route matched falls through to the vault
 *    gateway, which refuses a scoped client itself (routes/api.ts, `requestClientId`).
 * Other clients (`prism-native`, `omni-native`), sessions, capability links and anon are
 * untouched.
 */
import type { Context, MiddlewareHandler } from "hono";
import { DEVICE_TOKEN_PREFIX, COMMS_CLIENT_ID, sha256hex } from "../auth/device";
import { getDeviceTokenByHash } from "../db";
import { getApproval } from "../omni/approvals";
import { omniConfig } from "../omni/config";
import { commsOmniEnabled, isCommsDraft } from "../comms/omni";

/** The only prefixes a comms-native token may call (global constraints, binding). A
 *  trailing `/` means "strictly below"; without one, the path itself or below it. */
export const COMMS_ALLOWED_PREFIXES = [
  "/api/comms/",
  "/api/integrations/comms/",
  "/api/omni/approvals",
  "/api/omni/cards",
  "/auth/device/",
  "/api/push/",
] as const;
/** Refused even inside an allowed prefix (owner maintenance). */
export const COMMS_DENIED_PREFIXES = ["/api/comms/admin"] as const;

const REFUSAL = { error: "client_scope" } as const;

type Lookup = (tokenHash: string) => { client_id: string } | null | undefined;
let lookup: Lookup = (h) => getDeviceTokenByHash(h);
/** Tests: replace the device-row lookup (e.g. one that throws, to prove fail-closed). */
export function setClientLookupForTests(fn: Lookup | null): void {
  lookup = fn ?? ((h) => getDeviceTokenByHash(h));
}

/** Every reading of the Authorization header some consumer makes, deduplicated. */
function bearerCandidates(h: string | undefined): string[] {
  if (!h) return [];
  const out = new Set<string>();
  if (h.startsWith("Bearer ")) {
    const raw = h.slice("Bearer ".length);
    out.add(raw);
    out.add(raw.trim());
  }
  if (/^Bearer\s+/i.test(h)) out.add(h.replace(/^Bearer\s+/i, "").trim());
  return [...out].filter((t) => t.startsWith(DEVICE_TOKEN_PREFIX));
}

/** Per-request cache: the client id the bearer resolved to (null = not a device / unknown). */
const cache = new WeakMap<Request, string | null>();
/** The device client behind this request's bearer, as clientScope resolved it. */
export const requestClientId = (c: Context): string | null => cache.get(c.req.raw) ?? null;

/** Matches `prefix` segment-safely. */
export function prefixAllows(path: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(prefix + "/");
}

/** A path a scoped token may not send at all: anything a parser could read two ways. */
function ambiguous(path: string): boolean {
  if (!path.startsWith("/")) return true;
  if (/[\u0000- \u007f\\]/.test(path)) return true;
  if (/%(2f|5c|2e|00)/i.test(path)) return true;
  const segs = path.slice(1).split("/");
  // An empty segment anywhere but a single trailing slash (`/api/push/` is fine).
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "" && i !== segs.length - 1) return true;
    if (s === "." || s === "..") return true;
  }
  return false;
}

/** Is this path allowed for a comms-native token? (Pure; exported for tests.) */
export function commsPathAllowed(path: string): boolean {
  if (ambiguous(path)) return false;
  const lower = path.toLowerCase();
  if (COMMS_DENIED_PREFIXES.some((p) => prefixAllows(lower, p))) return false;
  return COMMS_ALLOWED_PREFIXES.some((p) => prefixAllows(path, p));
}

const APPROVAL_DECIDE = /^\/api\/omni\/approvals\/([^/]+)\/(?:decision|decide)$/;
const CARD_WRITE_OK = /^\/api\/omni\/cards\/[^/]+\/(?:snooze|dismiss)$/;
/** Largest decide body a scoped client may send (the real one is ~200 bytes). */
const MAX_DECIDE_BODY = 16 * 1024;

/** Read a CLONE of the body (the handler still reads the original), capped. A declared
 *  Content-Length above the cap is refused before reading anything. Past the cap the
 *  clone's reader is cancelled WITHOUT awaiting: a tee branch's cancel settles only when
 *  both branches are cancelled, and the original is never read on a refusal (await = hang). */
async function peekJson(c: Context): Promise<Record<string, unknown> | null> {
  const raw = c.req.raw;
  if (!raw.body) return null;
  const declared = raw.headers.get("content-length");
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_DECIDE_BODY)) return null;
  const reader = raw.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_DECIDE_BODY) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Amended ruling R17 (until Phase 4 designs executor identity): a scoped client READS
 * approvals and cards and may DENY an approval; nothing else that writes. So under
 * /api/omni/approvals the only write is `POST …/:id/decision|decide` whose decision reads
 * (exactly as routes/omni.ts `decide` reads it) as `cancel` — never on a `device-sign-in`
 * approval, which an unrestricted device decides. Under /api/omni/cards only snooze and
 * dismiss write (instruct / choose start agent turns and drafts). Refused BEFORE the
 * handler runs, so an approval is never claimed and stays pending.
 */
async function omniWriteAllowed(c: Context, path: string): Promise<boolean> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  if (prefixAllows(path, "/api/omni/cards")) return c.req.method === "POST" && CARD_WRITE_OK.test(path);
  if (!prefixAllows(path, "/api/omni/approvals")) return true;
  const m = c.req.method === "POST" ? APPROVAL_DECIDE.exec(path) : null;
  if (!m) return false;
  const b = await peekJson(c);
  if (!b) return false;
  const decision = b.decision === "approve" ? "send" : b.decision === "reject" ? "cancel" : b.decision;
  const a = getApproval(omniConfig.ownerEmail(), decodeURIComponent(m[1]!));
  if (decision === "cancel") return a?.kind !== "device-sign-in";
  // Phase 4 (Omni in Comms): Comms approves (Approve & Send) or refines (revise) ITS OWN drafts — a
  // `message` approval bound to a Comms thread — and nothing else. The decide route still requires
  // the digest the owner saw, a human device origin and an Idempotency-Key, and the executor sends
  // only through the comms send path (comms/omni.ts).
  if ((decision === "send" || decision === "revise") && a && isCommsDraft(a) && commsOmniEnabled()) return true;
  return false;
}

export function clientScope(): MiddlewareHandler {
  return async (c, next) => {
    const candidates = bearerCandidates(c.req.header("authorization"));
    if (candidates.length === 0) {
      cache.set(c.req.raw, null);
      return next();
    }
    let clientId: string | null = null;
    try {
      for (const t of candidates) {
        if (t.length > 200) continue; // verifyDeviceToken refuses these too
        const row = lookup(sha256hex(t));
        if (row?.client_id === COMMS_CLIENT_ID) {
          clientId = COMMS_CLIENT_ID;
          break;
        }
        if (row && clientId === null) clientId = row.client_id;
      }
    } catch {
      console.error("[client-scope] device lookup failed; refusing the device-token request");
      return c.json(REFUSAL, 403);
    }
    cache.set(c.req.raw, clientId);
    if (clientId !== COMMS_CLIENT_ID) return next();

    const path = c.req.path;
    if (!commsPathAllowed(path)) return c.json(REFUSAL, 403);

    try {
      if (!(await omniWriteAllowed(c, path))) return c.json(REFUSAL, 403);
    } catch {
      return c.json(REFUSAL, 403);
    }
    return next();
  };
}

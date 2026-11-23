/**
 * The relay's whole wire vocabulary. Everything a self-hosted server can make the
 * relay do is in here, and nothing else is accepted: a send names a device token,
 * its APNs environment, one of four fixed KINDS and (for two of them) an opaque id.
 * There is no field for text, a title, a URL, a sound or any other payload key —
 * the relay builds the whole APNs body itself from fixed copy (apns.ts).
 */

export type Environment = "production" | "sandbox";
/**
 * - `notification` — an inbox notification (id = the notification id)
 * - `agent` — an agent turn finished (id = the agent session id, a uuid)
 * - `agent-attention` — an agent turn ended in error / was interrupted (same id)
 * - `test` — "Notifications are working" (no id)
 */
export type Kind = "notification" | "agent" | "agent-attention" | "test";
export const KINDS: readonly Kind[] = ["notification", "agent", "agent-attention", "test"];

export interface SendRequest {
  deviceToken: string;
  environment: Environment;
  kind: Kind;
  /** Absent only for `test`. */
  id?: string;
}

/** Bytes; a valid send body is ~250. */
export const MAX_BODY_BYTES = 1024;

/** APNs device tokens are hex (32 bytes today; Apple says the length may grow). Same rule as the server. */
export const isDeviceToken = (t: unknown): t is string =>
  typeof t === "string" && t.length % 2 === 0 && /^[0-9a-fA-F]{64,200}$/.test(t);
/** Agent session ids are uuids (the server mints them with randomUUID). */
export const isUuid = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
/** The iOS app's own rule for a notification id (PrismIosPlugin.swift notificationIdPattern). */
export const isNotificationId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

export type Parsed = { ok: true; value: SendRequest } | { ok: false; detail: string };

/**
 * Strict parse: a JSON object with EXACTLY the keys of its kind. An unknown key —
 * `alert`, `title`, `body`, `url`, `payload`, anything — refuses the whole request
 * (no silently ignored extras: a client that tries to send text learns it cannot).
 */
export function parseSendRequest(raw: string): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "body must be JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, detail: "body must be an object" };
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return { ok: false, detail: `kind must be one of ${KINDS.join(", ")}` };
  }
  const allowed = kind === "test" ? ["deviceToken", "environment", "kind"] : ["deviceToken", "environment", "kind", "id"];
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, detail: "unknown keys are refused (the relay accepts ids only, never text)" };
  if (!isDeviceToken(o.deviceToken)) return { ok: false, detail: "deviceToken must be hex, 64-200 chars" };
  if (o.environment !== "production" && o.environment !== "sandbox") return { ok: false, detail: "environment must be production or sandbox" };
  const k = kind as Kind;
  if (k === "test") return { ok: true, value: { deviceToken: o.deviceToken.toLowerCase(), environment: o.environment, kind: k } };
  const id = o.id;
  const idOk = k === "notification" ? isNotificationId(id) : isUuid(id);
  if (!idOk) return { ok: false, detail: k === "notification" ? "id must match [A-Za-z0-9_-]{1,64}" : "id must be a uuid" };
  return {
    ok: true,
    value: { deviceToken: o.deviceToken.toLowerCase(), environment: o.environment, kind: k, id: k === "notification" ? (id as string) : (id as string).toLowerCase() },
  };
}

/** Registration body: `{publicKey}` = the server's Ed25519 public key, raw 32 bytes, base64url. */
export function parseRegisterRequest(raw: string): { ok: true; publicKey: string } | { ok: false; detail: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "body must be JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, detail: "body must be an object" };
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "publicKey")) return { ok: false, detail: "only publicKey is accepted" };
  if (typeof o.publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(o.publicKey)) {
    return { ok: false, detail: "publicKey must be a raw Ed25519 public key (32 bytes, base64url)" };
  }
  return { ok: true, publicKey: o.publicKey };
}

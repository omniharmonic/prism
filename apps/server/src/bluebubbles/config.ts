/**
 * BlueBubbles connector configuration: the flag, the loopback-only base URL and the stored
 * credential. The credential (kind "bluebubbles": `{password, webhookSecret}`) lives in the
 * per-tenant secret store of the PRIMARY vault, keyed to OWNER_EMAIL, like the Matrix one.
 */
import { config } from "../config";
import { resolveVaultEntry } from "../db";
import { getSecret, secretsConfigured } from "../secrets";
import { BlueBubblesClient, type BlueBubblesCreds } from "./client";

export const BLUEBUBBLES_CREDENTIAL = "bluebubbles";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A webhook secret must be long enough not to be guessed (the runbook generates 64 hex chars). */
export const MIN_WEBHOOK_SECRET = 32;

/** The base URL when it is a loopback http(s) URL with no credentials/path tricks, else null. */
export function loopbackBaseUrl(raw: string = config.blueBubblesUrl): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return null;
  // Never a port another local service of this install owns (review C1 / M15): Prism itself,
  // the vault, LM Studio (the skills / embedder base URL — 1234 by default, which is why
  // BlueBubbles runs on 1235). The password would otherwise be handed to that service.
  const port = portOf(u);
  if (port === String(config.port) || [config.parachuteUrl, config.skillsLocalBaseUrl].some((o) => sameLocalPort(o, port))) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

const portOf = (u: URL): string => u.port || (u.protocol === "https:" ? "443" : "80");
function sameLocalPort(other: string, port: string): boolean {
  try {
    const o = new URL(other);
    return LOOPBACK_HOSTS.has(o.hostname.toLowerCase()) && portOf(o) === port;
  } catch {
    return false;
  }
}

let warnedUrl = false;
/** Connector on: the flag AND a loopback URL (a non-loopback URL is refused once, loudly). */
export function blueBubblesActive(): boolean {
  if (!config.blueBubblesEnabled) return false;
  if (loopbackBaseUrl()) return true;
  if (!warnedUrl) {
    warnedUrl = true;
    console.error("[bluebubbles] BLUEBUBBLES_URL is not a loopback http(s) URL on a port of its own (not Prism's, the vault's or LM Studio's) — the connector stays OFF");
  }
  return false;
}

/** The stored credential, or null (absent / unreadable / malformed). Never logged. */
// Decrypted at most once per CREDS_TTL_MS per vault (final review M5: channelCanSend asks per
// rendered iMessage thread). A credential write clears it (clearBlueBubblesCredsCache).
const CREDS_TTL_MS = 5_000;
const credsCache = new Map<string, { at: number; creds: BlueBubblesCreds | null }>();
export function clearBlueBubblesCredsCache(): void {
  credsCache.clear();
}

export function blueBubblesCreds(vaultId: string = resolveVaultEntry(undefined).id): BlueBubblesCreds | null {
  const hit = credsCache.get(vaultId);
  if (hit && Date.now() - hit.at < CREDS_TTL_MS) return hit.creds;
  const creds = readCreds(vaultId);
  credsCache.set(vaultId, { at: Date.now(), creds });
  return creds;
}

function readCreds(vaultId: string): BlueBubblesCreds | null {
  if (!secretsConfigured()) return null;
  try {
    const c = JSON.parse(getSecret(vaultId, config.ownerEmail, BLUEBUBBLES_CREDENTIAL) ?? "null") as Partial<BlueBubblesCreds> | null;
    if (!c || typeof c.password !== "string" || !c.password || typeof c.webhookSecret !== "string" || c.webhookSecret.length < MIN_WEBHOOK_SECRET) return null;
    return { password: c.password, webhookSecret: c.webhookSecret };
  } catch {
    return null;
  }
}

type ClientFactory = (base: string, password: string) => BlueBubblesClient;
let factory: ClientFactory | null = null;
/** Tests: build clients over a fake server's fetch. */
export function setBlueBubblesClientFactoryForTests(f: ClientFactory | null): void {
  factory = f;
}

/** A client for the primary vault's credential, or null when the connector cannot run. */
export function blueBubblesClient(vaultId?: string): BlueBubblesClient | null {
  if (!blueBubblesActive()) return null;
  const base = loopbackBaseUrl();
  const creds = blueBubblesCreds(vaultId);
  if (!base || !creds) return null;
  return factory ? factory(base, creds.password) : new BlueBubblesClient(base, creds.password, fetch, config.blueBubblesTimeoutMs);
}

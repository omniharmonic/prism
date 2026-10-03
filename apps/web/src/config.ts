import { useAgentChatStore } from "@prism/core/shell";
/**
 * Web connection config: which Parachute vault to talk to, and the bearer token.
 *
 * Persisted in localStorage (a personal, single-user app — the same trade-off
 * Aaron's my-vault-ui makes). The active connection is also held in a module
 * variable so the non-React REST layer can read it without prop-drilling.
 */
export interface Connection {
  /** Server root, e.g. https://vault.example.com (no trailing /api). */
  vaultUrl: string;
  /** Vault name, e.g. "default". */
  vaultName: string;
  /** Hub-issued JWT (vault:<name>:write). */
  token: string;
}

const STORAGE_KEY = "prism-web-connection";

/** Build-time defaults so a deployed instance knows which vault it fronts
 *  (set VITE_VAULT_URL / VITE_VAULT_NAME at build time; falls back to local dev). */
export const DEFAULT_VAULT_URL =
  (import.meta.env.VITE_VAULT_URL as string | undefined)?.replace(/\/+$/, "") ||
  // The native client (apps/client) never talks to a vault directly: no
  // localhost vault default is baked into that build (its CSP forbids it too).
  (import.meta.env.VITE_PRISM_NATIVE === "1" ? "" : "http://localhost:1940");
export const DEFAULT_VAULT_NAME =
  (import.meta.env.VITE_VAULT_NAME as string | undefined) || "default";

let active: Connection | null = null;

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Connection>;
    if (!c.vaultUrl || !c.vaultName || !c.token) return null;
    return { vaultUrl: c.vaultUrl, vaultName: c.vaultName, token: c.token };
  } catch {
    return null;
  }
}

export function saveConnection(c: Connection): void {
  // Normalize: strip trailing slash and any legacy /api suffix.
  const url = c.vaultUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  const normalized: Connection = { ...c, vaultUrl: url, vaultName: c.vaultName.trim() || "default" };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  active = normalized;
}

export function clearConnection(): void {
  localStorage.removeItem(STORAGE_KEY);
  active = null;
}

export function setActiveConnection(c: Connection): void {
  active = c;
}

export function getConnection(): Connection {
  if (!active) throw new Error("No vault connection configured");
  return active;
}

// ---------------------------------------------------------------------------
// Prism Server gateway (the secure path). The browser holds NO vault token;
// it talks only to the gateway, authenticated by an httpOnly session cookie set
// via magic-link sign-in. The gateway holds the vault token server-side. The
// legacy Connection bits above remain only for the public ShareView and the
// (being-rebuilt) collab route; the main app uses the gateway exclusively.
// ---------------------------------------------------------------------------

// Gateway origin + request plumbing live in ./transport (PWA: same-origin,
// session cookie; native build: configured origin + device bearer token).
// For dev, set VITE_GATEWAY_URL=http://localhost:8787.
import { gatewayOrigin, serverFetch, isNative, getDeviceToken, getHost } from "./transport";
import { bindCacheUser, clearReadCache } from "./offline/readCache";
export { gatewayOrigin };

/** Native sign-in (WP2.1): the server bounces a signed-out browser to
 *  `/?next=/auth/device/continue`. That EXACT path is the only `next` we honor —
 *  anything else goes to the app root, so `next` can never be an open redirect. */
const DEVICE_CONTINUE_PATH = "/auth/device/continue";
export function postLoginTarget(): string | null {
  const next = new URLSearchParams(window.location.search).get("next");
  return next === DEVICE_CONTINUE_PATH ? `${gatewayOrigin()}${DEVICE_CONTINUE_PATH}` : null;
}

/** Base URL for the gateway REST API. */
export function apiBase(): string {
  return `${gatewayOrigin()}/api`;
}

export interface Me {
  authenticated: boolean;
  /** Authentication could not be checked; this is not a sign-out. */
  unavailable?: boolean;
  email?: string;
  name?: string | null;
  /** Small data:image/ URL avatar, or null. Feeds collab presence identity. */
  avatar?: string | null;
  isOwner?: boolean;
  /** The viewer's role in the ACTIVE vault (owner/admin/member/guest). Per-vault:
   *  re-fetched on vault switch. Drives role-gating of management surfaces. */
  role?: "owner" | "admin" | "member" | "guest";
  /** The active vault id the role above is scoped to. */
  vaultId?: string;
  /** The active workspace (X-Prism-Workspace → Host subdomain → default). */
  workspace?: { id: string; name: string };
  hasPassword?: boolean;
}

let cachedMe: Me | null = null;
let cachedMeContext = "";
const identityContext = () => JSON.stringify([gatewayOrigin(), contextHeaders(), getCapabilityToken()]);

/** Current identity per the session cookie. Never throws. Caches the result so
 *  synchronous owner checks (e.g. gating owner-only UI) don't need a refetch.
 *  Sends the active-vault header so the returned `role` is scoped to the vault
 *  the app is currently viewing (role is per-workspace). */
export async function fetchMe(): Promise<Me> {
  const context = identityContext();
  try {
    // Native: no device token → not signed in; don't even ask (the sign-in
    // screen starts the flow). A 401 is routed to the host by serverFetch.
    if (isNative && !getCapabilityToken() && !(await getDeviceToken())) {
      cachedMe = { authenticated: false };
      cachedMeContext = context;
      useAgentChatStore.getState().bindScope(null);
      return cachedMe;
    }
    const r = await serverFetch("/auth/me", { headers: { ...capabilityHeader(), ...contextHeaders() } });
    if (!r.ok && r.status !== 401 && r.status !== 403) return { authenticated: false, unavailable: true };
    const me = r.ok ? (await r.json()) as Me : { authenticated: false };
    // A late response from the previous vault must not replace current identity.
    if (identityContext() !== context) return getMe() ?? { authenticated: false };
    cachedMe = me;
    cachedMeContext = context;
    useAgentChatStore.getState().bindScope(agentScope());
    // The server says nobody is signed in (session expired/revoked, PWA 401):
    // cached pages and device-local page lists of the previous account go now,
    // not at the next sign-in (wave 2E review M4). Capability viewers keep theirs.
    if (!me.authenticated && !getCapabilityToken()) await clearReadCache();
    const changed = await bindCacheUser(cachedMe.email);
    // A different account on this browser: the previous account's synced live
    // documents go with its read cache (its unsynced ones stay for it).
    if (changed) {
      const { captureWriteContext } = await import("./offline/writeScope");
      const { purgeOtherScopes } = await import("./collab/unsynced");
      await purgeOtherScopes((await captureWriteContext().catch(() => null))?.scope ?? null).catch(() => 0);
    }
    return cachedMe;
  } catch {
    // Retain the last confirmed identity for offline drafts, but report the
    // failed revalidation to callers. Replay checks cannot treat it as fresh.
    return { authenticated: false, unavailable: true };
  }
}

/** The cached identity for the signed-in user — for surfaces that need a
 *  synchronous read (collab presence/authorship). Null until fetchMe() has run.
 *  Use with fetchMe() to guarantee freshness. */
export function getMe(): Me | null {
  return cachedMeContext === identityContext() ? cachedMe : null;
}

/** Resolved conversation audience; never contains a token or defaults to another vault. */
export function agentScope(): string | null {
  const me = getMe();
  if (getCapabilityToken() || !me?.authenticated || !me.email || !me.vaultId || !me.workspace?.id) return null;
  return JSON.stringify([new URL(apiBase(), location.origin).href, me.workspace.id, me.vaultId, me.email]);
}

/** True only for the signed-in vault owner with no capability token in play.
 *  Owner-only features (e.g. the wikilink suggest dropdown, which surfaces vault
 *  note names) gate on this so collaborators/share-link recipients never get it.
 *  This is a UX/defense-in-depth gate — the gateway is the real boundary and
 *  already filters /api/notes to a non-owner's granted notes. */
export function isOwner(): boolean {
  return !!getMe()?.isOwner && !getCapabilityToken();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return serverFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Password login. Throws with a generic message on failure. */
export async function login(email: string, password: string): Promise<void> {
  const r = await postJson("/auth/login", { email, password });
  if (!r.ok) throw new Error("Incorrect email or password.");
}

export interface InviteInfo {
  valid: boolean;
  email?: string;
  name?: string | null;
}
/** Look up an invite token so the register screen can show the email. */
export async function fetchInvite(token: string): Promise<InviteInfo> {
  try {
    const r = await serverFetch(`/auth/invite-info?token=${encodeURIComponent(token)}`, { credentials: "same-origin" });
    if (!r.ok) return { valid: false };
    return (await r.json()) as InviteInfo;
  } catch {
    return { valid: false };
  }
}

/** Accept an invite: create the account (name + password) and start a session. */
export async function register(token: string, name: string, password: string): Promise<void> {
  const r = await postJson("/auth/register", { token, name, password });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || "Could not create your account.");
  }
}

/** Set/replace the signed-in user's password (and optionally name). */
export async function setPassword(password: string, name?: string): Promise<void> {
  const r = await postJson("/auth/set-password", { password, name });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || "Could not set your password.");
  }
}

/** Request a magic-link sign-in email. Resolves on 200 (the server never
 *  reveals whether an address is known). Returns `emailDelivery` — false when
 *  the server has no Resend key, so the link was only printed to its console. */
export async function requestMagicLink(email: string): Promise<{ emailDelivery: boolean }> {
  const r = await serverFetch("/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(`Sign-in request failed (${r.status}).`);
  const body = await r.json().catch(() => ({}));
  return { emailDelivery: body?.emailDelivery !== false };
}

/** Set when the last sign-out could not reach the server (shown once on the sign-in screen). */
export const SIGNOUT_NOTICE_KEY = "prism:signout-unreached";
export function takeSignOutNotice(): boolean {
  try {
    const set = sessionStorage.getItem(SIGNOUT_NOTICE_KEY) === "1";
    sessionStorage.removeItem(SIGNOUT_NOTICE_KEY);
    return set;
  } catch { return false; }
}

export async function logout(): Promise<boolean> {
  // The scope being signed out, captured while the identity is still known.
  const { captureWriteContext } = await import("./offline/writeScope");
  const leaving = await captureWriteContext().catch(() => null);
  // Unsent changes for this account would stay on the device (unencrypted and
  // never sent from another account): the user decides first — stay, download
  // and sign out, or discard and sign out. `false` = they chose to stay.
  const { confirmLeaveWithUnsent } = await import("./offline/leave");
  if (!(await confirmLeaveWithUnsent().catch(() => true))) return false;
  cachedMe = null;
  cachedMeContext = "";
  useAgentChatStore.getState().bindScope(null);
  let reached = false;
  try {
    // PWA: end the session. Native: revoke the calling device token (POST
    // /auth/device/revoke with an empty body + the bearer).
    const r = await serverFetch(isNative ? "/auth/device/revoke" : "/auth/logout", { method: "POST" });
    reached = r.ok || r.status === 401;
  } catch {
    /* offline / server unreachable: the local sign-out still completes below */
  } finally {
    // The shell forgets its token WHETHER OR NOT the server answered (review low 9):
    // it used to be skipped when the revoke request failed, leaving the token in the Keychain.
    if (isNative) await Promise.resolve(getHost()?.onSignedOut?.()).catch(() => undefined);
    await clearReadCache();
    // Live-document bodies of the signing-out account leave the device too (review
    // M3). The person already chose download/discard for any unsynced ones.
    if (leaving) {
      const { purgeScopeDocuments } = await import("./collab/unsynced");
      await purgeScopeDocuments(leaving.scope, true).catch(() => 0);
    }
    if (!reached) { try { sessionStorage.setItem(SIGNOUT_NOTICE_KEY, "1"); } catch { /* private mode */ } }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Capability mode. A share link is `${origin}/?t=<token>` — the recipient has
// no session, so the token is sent on every gateway call (Authorization:
// Capability <token>) and the gateway authorizes via the link's grants. The
// token is held in sessionStorage so SPA navigation (which drops the query)
// keeps working within the tab.
// ---------------------------------------------------------------------------

const CAP_KEY = "prism-cap";
let capabilityToken: string | null = null;

/** Read ?t= from the URL (fresh link) or restore from sessionStorage. Returns
 *  the active capability token, if any. Call once at startup. */
export function initCapability(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) {
    capabilityToken = fromUrl;
    try {
      sessionStorage.setItem(CAP_KEY, fromUrl);
    } catch {
      /* private mode */
    }
  } else {
    try {
      capabilityToken = sessionStorage.getItem(CAP_KEY);
    } catch {
      capabilityToken = null;
    }
  }
  return capabilityToken;
}

export function getCapabilityToken(): string | null {
  return capabilityToken;
}

/** Authorization header for capability mode (empty for session users). */
export function capabilityHeader(): Record<string, string> {
  return capabilityToken ? { Authorization: `Capability ${capabilityToken}` } : {};
}

// ---------------------------------------------------------------------------
// Active vault (multi-vault, Phase 1). The owner can switch which configured
// vault the gateway proxies to. We send the chosen vault id on every gateway
// call as `X-Prism-Vault`; no header (or "primary") = the default vault, so a
// single-vault deployment is unaffected. Held in localStorage so the choice
// survives reloads. This is an owner-only switch — the gateway only honors the
// header on the owner passthrough.
// ---------------------------------------------------------------------------

const ACTIVE_VAULT_KEY = "prism-active-vault";

export function getActiveVault(): string | null {
  try {
    return localStorage.getItem(ACTIVE_VAULT_KEY);
  } catch {
    return null;
  }
}

export function setActiveVault(id: string | null): void {
  useAgentChatStore.getState().bindScope(null);
  try {
    if (id) localStorage.setItem(ACTIVE_VAULT_KEY, id);
    else localStorage.removeItem(ACTIVE_VAULT_KEY);
  } catch {
    /* private mode */
  }
}

/** Header naming the active vault for the gateway (empty = default vault). */
export function vaultHeader(): Record<string, string> {
  const id = getActiveVault();
  return id ? { "X-Prism-Vault": id } : {};
}

// ---------------------------------------------------------------------------
// Active workspace (Stage 2, "one server, many workspaces"). The owner switches
// which workspace they're managing on the main origin; sent as `X-Prism-Workspace`
// so the server scopes the vault list + admin surface to that workspace. On a
// per-workspace SUBDOMAIN the server resolves the workspace by Host instead, so
// this header is the owner's explicit switch. No header = the default workspace.
// ---------------------------------------------------------------------------

const ACTIVE_WORKSPACE_KEY = "prism-active-workspace";

export function getActiveWorkspace(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function setActiveWorkspace(id: string | null): void {
  useAgentChatStore.getState().bindScope(null);
  try {
    if (id) localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    // Switching workspace narrows the vault set → force a fresh identity/vault read.
    window.dispatchEvent(new Event("prism:vault-changed"));
  } catch {
    /* private mode */
  }
}

/** Combined context headers for gateway calls: the active vault AND workspace.
 *  Either may be empty (→ the server's default). Use everywhere a gateway/ACL
 *  request is made so the owner's workspace switch is honored consistently. */
export function contextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const v = getActiveVault();
  if (v) headers["X-Prism-Vault"] = v;
  const w = getActiveWorkspace();
  if (w) headers["X-Prism-Workspace"] = w;
  return headers;
}

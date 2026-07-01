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
  (import.meta.env.VITE_VAULT_URL as string | undefined)?.replace(/\/+$/, "") || "http://localhost:1940";
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

/** Gateway origin. Empty = same-origin (Prism Server serves this app). For dev,
 *  set VITE_GATEWAY_URL=http://localhost:8787. */
export const GATEWAY_ORIGIN =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

/** Base URL for the gateway REST API. */
export function apiBase(): string {
  return `${GATEWAY_ORIGIN}/api`;
}

export interface Me {
  authenticated: boolean;
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

/** Current identity per the session cookie. Never throws. Caches the result so
 *  synchronous owner checks (e.g. gating owner-only UI) don't need a refetch.
 *  Sends the active-vault header so the returned `role` is scoped to the vault
 *  the app is currently viewing (role is per-workspace). */
export async function fetchMe(): Promise<Me> {
  try {
    const r = await fetch(`${GATEWAY_ORIGIN}/auth/me`, {
      credentials: "include",
      headers: contextHeaders(),
    });
    if (!r.ok) { cachedMe = { authenticated: false }; return cachedMe; }
    cachedMe = (await r.json()) as Me;
    return cachedMe;
  } catch {
    cachedMe = { authenticated: false };
    return cachedMe;
  }
}

/** The cached identity for the signed-in user — for surfaces that need a
 *  synchronous read (collab presence/authorship). Null until fetchMe() has run.
 *  Use with fetchMe() to guarantee freshness. */
export function getMe(): Me | null {
  return cachedMe;
}

/** True only for the signed-in vault owner with no capability token in play.
 *  Owner-only features (e.g. the wikilink suggest dropdown, which surfaces vault
 *  note names) gate on this so collaborators/share-link recipients never get it.
 *  This is a UX/defense-in-depth gate — the gateway is the real boundary and
 *  already filters /api/notes to a non-owner's granted notes. */
export function isOwner(): boolean {
  return !!cachedMe?.isOwner && !getCapabilityToken();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${GATEWAY_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
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
    const r = await fetch(`${GATEWAY_ORIGIN}/auth/invite-info?token=${encodeURIComponent(token)}`);
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
  const r = await fetch(`${GATEWAY_ORIGIN}/auth/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(`Sign-in request failed (${r.status}).`);
  const body = await r.json().catch(() => ({}));
  return { emailDelivery: body?.emailDelivery !== false };
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${GATEWAY_ORIGIN}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
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

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
  isOwner?: boolean;
}

/** Current identity per the session cookie. Never throws. */
export async function fetchMe(): Promise<Me> {
  try {
    const r = await fetch(`${GATEWAY_ORIGIN}/auth/me`, { credentials: "include" });
    if (!r.ok) return { authenticated: false };
    return (await r.json()) as Me;
  } catch {
    return { authenticated: false };
  }
}

/** Request a magic-link sign-in email. Resolves on 200 (the server never
 *  reveals whether an address is known). */
export async function requestMagicLink(email: string): Promise<void> {
  const r = await fetch(`${GATEWAY_ORIGIN}/auth/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(`Sign-in request failed (${r.status}).`);
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${GATEWAY_ORIGIN}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
}

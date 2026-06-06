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

/** Base URL for the vault-scoped REST API. */
export function apiBase(): string {
  const c = getConnection();
  return `${c.vaultUrl}/vault/${c.vaultName}/api`;
}

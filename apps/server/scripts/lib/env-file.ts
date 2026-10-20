/**
 * The Prism Server `.env`: secret generation, the body `prism-setup.ts` writes, and the
 * small parser both it and the host bundle's `prism install` use. Dependency-free
 * (node:crypto only) so the `prism` CLI can bundle it.
 *
 * Rules every writer keeps:
 *  - an existing `SECRETS_KEY` and `GOVERNANCE_SIGNING_SECRET` are NEVER replaced (a new
 *    SECRETS_KEY makes every stored connection unreadable; a new governance secret hides
 *    every governance note until it is re-signed);
 *  - the file is written 0600.
 */
import { randomBytes } from "node:crypto";

/** Keys whose values are secrets: masked in previews, never printed. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "PARACHUTE_TOKEN",
  "SESSION_SECRET",
  "CAPABILITY_SECRET",
  "COLLAB_TOKEN",
  "RESEND_API_KEY",
  "GOVERNANCE_SIGNING_SECRET",
  "SECRETS_KEY",
]);

/** base64 secret, newline-stripped (same shape the old bootstrap.sh wrote). */
export function gen(bytes = 48): string {
  return randomBytes(bytes).toString("base64").replace(/\n/g, "");
}

/** url-safe collab token (same `collab_<...>` shape the old bootstrap.sh wrote). */
export function genCollabToken(): string {
  const b = randomBytes(30).toString("base64").replace(/\//g, "_").replace(/\+/g, "-").replace(/=+$/g, "");
  return `collab_${b}`;
}

/** The key stored integration credentials are encrypted under (src/secrets.ts). */
export function genSecretsKey(): string {
  return randomBytes(32).toString("base64");
}

/** Derive a default From address from the origin host, as the old bootstrap.sh did. */
export function defaultMagicFrom(appOrigin: string): string {
  // strip scheme + leading subdomain (e.g. https://prism.acme.dev → acme.dev)
  const host = appOrigin.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  // A local address has no mail domain; keep the server's built-in default until email is set up.
  if (!host.includes(".") || /^[\d.]+$/.test(host)) return "Prism <login@example.com>";
  const apex = host.split(".").slice(-2).join(".");
  return `Prism <login@${apex}>`;
}

/** The server needs Node 22.18+ (TypeScript type stripping on by default; package.json `engines`). */
export function nodeTooOld(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 22 || (major === 22 && minor < 18);
}

/** Minimal .env parser (KEY=VALUE per line; no quoting, no expansion — what we write). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Mask secret values in a .env preview. */
export function maskSecrets(envBody: string): string {
  return envBody
    .split("\n")
    .map((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && SECRET_KEYS.has(m[1]!) && m[2]) {
        const v = m[2];
        const shown = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-2)}` : "********";
        return `${m[1]}=${shown}`;
      }
      return line;
    })
    .join("\n");
}

/** A value that can sit on one `KEY=VALUE` line without changing the file's meaning. */
export function isSafeEnvValue(v: string): boolean {
  return !/[\r\n\0]/.test(v);
}

/**
 * The generated secrets for a new `.env`, keeping whatever `prior` already holds for the
 * secrets that must never rotate (and, when `keepAll`, for every generated secret).
 */
export function generatedSecrets(prior: Record<string, string> = {}, keepAll = false): Record<string, string> {
  const keep = (k: string, fresh: () => string) => (prior[k] && (keepAll || k === "SECRETS_KEY" || k === "GOVERNANCE_SIGNING_SECRET") ? prior[k]! : fresh());
  return {
    SESSION_SECRET: keep("SESSION_SECRET", () => gen(48)),
    CAPABILITY_SECRET: keep("CAPABILITY_SECRET", () => gen(48)),
    COLLAB_TOKEN: keep("COLLAB_TOKEN", genCollabToken),
    GOVERNANCE_SIGNING_SECRET: keep("GOVERNANCE_SIGNING_SECRET", () => gen(48)),
    SECRETS_KEY: keep("SECRETS_KEY", genSecretsKey),
  };
}

/** `KEY=VALUE` lines in the given order, ending in a newline. Throws on an unsafe value. */
export function renderEnv(entries: ReadonlyArray<readonly [string, string]>): string {
  for (const [k, v] of entries) {
    if (!/^[A-Z0-9_]+$/.test(k)) throw new Error(`bad env key ${k}`);
    if (!isSafeEnvValue(v)) throw new Error(`unsafe value for ${k}`);
  }
  return [...entries.map(([k, v]) => `${k}=${v}`), ""].join("\n");
}

/**
 * Add the keys of `additions` that `text` does not define yet (an existing key — even an
 * empty one — is left exactly as it is). Returns the new text and the keys added.
 */
export function addMissingKeys(text: string, additions: ReadonlyArray<readonly [string, string]>): { text: string; added: string[] } {
  const have = parseEnv(text);
  const missing = additions.filter(([k]) => !(k in have));
  if (missing.length === 0) return { text, added: [] };
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return { text: base + renderEnv(missing), added: missing.map(([k]) => k) };
}

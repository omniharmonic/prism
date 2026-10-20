/**
 * The install's `config/.env`, built with the same helpers `prism-setup.ts` uses
 * (apps/server/scripts/lib/env-file.ts). Rules: written 0600; an existing file keeps every
 * value it has — only missing keys are added, and only the keys the person names on the
 * command line (vault token, Parachute paths) are replaced. Values are never printed.
 */
import { addMissingKeys, defaultMagicFrom, generatedSecrets, isSafeEnvValue, parseEnv, renderEnv } from "../../../apps/server/scripts/lib/env-file";
import type { Layout } from "./paths";

export interface EnvInputs {
  ownerEmail?: string;
  appOrigin?: string;
  port?: number;
  parachuteUrl?: string;
  parachuteVault?: string;
  /** The vault token, read from a file the person names (never argv). */
  parachuteToken?: string;
  parachuteBin?: string;
  parachuteVaultBin?: string;
  parachuteHome?: string;
  /** The hub's origin: the issuer pinned on vault tokens AND where its JWKS is fetched. */
  parachuteHubOrigin?: string;
}

export const DEFAULT_PORT = 8787;

/** Keys that are paths into the install (always the install's own, added when missing). */
export function layoutKeys(layout: Layout): Array<[string, string]> {
  return [
    ["DB_PATH", layout.db],
    ["AGENT_CWD", layout.agentCwd],
  ];
}

/** The `.env` body of a fresh install. */
export function freshEnv(layout: Layout, input: EnvInputs): string {
  if (!input.ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail)) throw new Error("a valid --owner-email is required for a new install");
  const port = input.port ?? DEFAULT_PORT;
  const appOrigin = input.appOrigin ?? `http://localhost:${port}`;
  const s = generatedSecrets();
  const entries: Array<[string, string]> = [
    ["APP_ORIGIN", appOrigin],
    ["PORT", String(port)],
    ["PARACHUTE_URL", input.parachuteUrl ?? "http://127.0.0.1:1940"],
    ["PARACHUTE_VAULT", input.parachuteVault ?? "default"],
    ["PARACHUTE_TOKEN", input.parachuteToken ?? ""],
    ["SESSION_SECRET", s.SESSION_SECRET!],
    ["CAPABILITY_SECRET", s.CAPABILITY_SECRET!],
    ["COLLAB_TOKEN", s.COLLAB_TOKEN!],
    ["GOVERNANCE_SIGNING_SECRET", s.GOVERNANCE_SIGNING_SECRET!],
    ["SECRETS_KEY", s.SECRETS_KEY!],
    ["OWNER_EMAIL", input.ownerEmail.trim().toLowerCase()],
    ["RESEND_API_KEY", ""],
    ["MAGIC_FROM", defaultMagicFrom(appOrigin)],
    ...layoutKeys(layout),
    ...parachuteKeys(input),
  ];
  return renderEnv(entries);
}

function parachuteKeys(input: EnvInputs): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (input.parachuteBin) out.push(["PARACHUTE_BIN", input.parachuteBin]);
  if (input.parachuteVaultBin) out.push(["PARACHUTE_VAULT_BIN", input.parachuteVaultBin]);
  if (input.parachuteHome) out.push(["PARACHUTE_HOME", input.parachuteHome]);
  if (input.parachuteHubOrigin) out.push(["PARACHUTE_HUB_ORIGIN", input.parachuteHubOrigin], ["PARACHUTE_HUB_JWKS_ORIGIN", input.parachuteHubOrigin]);
  return out;
}

/** Replace (or append) exactly these keys; every other line is kept byte for byte. */
export function setKeys(text: string, entries: ReadonlyArray<readonly [string, string]>): string {
  for (const [, v] of entries) if (!isSafeEnvValue(v)) throw new Error("unsafe env value");
  const want = new Map(entries);
  const lines = text.split("\n");
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && want.has(m[1]!)) {
      seen.add(m[1]!);
      return `${m[1]}=${want.get(m[1]!)}`;
    }
    return line;
  });
  let body = out.join("\n");
  const rest = entries.filter(([k]) => !seen.has(k));
  if (rest.length) body = (body === "" || body.endsWith("\n") ? body : body + "\n") + renderEnv(rest);
  return body;
}

/**
 * Bring an existing `.env` up to what this install needs: add missing generated secrets
 * (SECRETS_KEY etc. — an existing one is never replaced) and the install's paths; replace
 * only what the person named.
 */
export function updateEnv(layout: Layout, text: string, input: EnvInputs): { text: string; added: string[]; replaced: string[] } {
  const prior = parseEnv(text);
  const s = generatedSecrets(prior, true);
  const additions: Array<[string, string]> = [...Object.entries(s), ...layoutKeys(layout)];
  const step = addMissingKeys(text, additions);
  const replace: Array<[string, string]> = [];
  if (input.parachuteToken !== undefined) replace.push(["PARACHUTE_TOKEN", input.parachuteToken]);
  replace.push(...parachuteKeys(input));
  return { text: replace.length ? setKeys(step.text, replace) : step.text, added: step.added, replaced: replace.map(([k]) => k) };
}

/** Non-secret facts about the env file the CLI reports (`status`, `doctor`). */
export function envFacts(text: string | null): { present: boolean; port: number; vaultTokenSet: boolean; ownerEmailSet: boolean; parachuteUrl: string; hubOrigin: string } {
  const e = text ? parseEnv(text) : {};
  const port = Number(e.PORT) || DEFAULT_PORT;
  return {
    present: text !== null,
    port,
    vaultTokenSet: !!e.PARACHUTE_TOKEN,
    ownerEmailSet: !!e.OWNER_EMAIL,
    parachuteUrl: (e.PARACHUTE_URL || "http://127.0.0.1:1940").replace(/\/+$/, ""),
    hubOrigin: (e.PARACHUTE_HUB_JWKS_ORIGIN || "http://127.0.0.1:1939").replace(/\/+$/, ""),
  };
}

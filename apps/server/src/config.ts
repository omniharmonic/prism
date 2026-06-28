/**
 * Prism Server configuration, read from the environment (load with
 * `node --env-file=.env`). The Parachute token is held ONLY here, server-side —
 * it is never sent to a client.
 */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  appOrigin: (process.env.APP_ORIGIN ?? "http://localhost:8787").replace(/\/+$/, ""),

  parachuteUrl: (process.env.PARACHUTE_URL ?? "http://localhost:1940").replace(/\/+$/, ""),
  parachuteVault: process.env.PARACHUTE_VAULT ?? "default",
  parachuteToken: process.env.PARACHUTE_TOKEN ?? "",

  sessionSecret: process.env.SESSION_SECRET ?? "",
  capabilitySecret: process.env.CAPABILITY_SECRET ?? process.env.SESSION_SECRET ?? "",

  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),

  // Dedicated owner token for the trusted desktop app's real-time connection.
  // The Tauri webview presents this to /collab to join live docs as the owner —
  // separate from the vault token, so the powerful vault credential stays out of
  // the webview. Shared between this .env and the desktop's prism-config.json.
  collabToken: process.env.COLLAB_TOKEN ?? "",

  // ── Parachute-to-Parachute federation (Horizon C) ──
  // This server's Ed25519 PRIVATE signing key as a base64url-encoded 32-byte
  // seed. Used to sign federation requests/connections to peer hubs; only the
  // PUBLIC key is ever shared. Empty → auth/peer.ts generates an ephemeral
  // in-memory keypair and warns (federation works within the process but the
  // identity is not stable across restarts).
  peerSigningKey: process.env.PEER_SIGNING_KEY ?? "",
  // Master switch for the federation transport/routes. Trust pairing can be
  // exercised independently; this gates the live sync (Phase 2+).
  federationEnabled: process.env.FEDERATION_ENABLED === "true",

  resendApiKey: process.env.RESEND_API_KEY ?? "",
  magicFrom: process.env.MAGIC_FROM ?? "Prism <login@example.com>",

  dbPath: process.env.DB_PATH ?? "./prism-server.db",

  // Semantic search (RAG). Embeddings are model-deterministic, so the Rust
  // backend's indexer and this server's query-time path can both call the same
  // model and get comparable vectors. With no EMBED_ENDPOINT we fall back to a
  // deterministic, dependency-free local embedder (lexical, offline) — the
  // pipeline still runs and is testable; quality just isn't semantic.
  embedEndpoint: (process.env.EMBED_ENDPOINT ?? "").replace(/\/+$/, ""), // e.g. http://localhost:11434/v1
  embedModel: process.env.EMBED_MODEL ?? "nomic-embed-text",
  embedApiKey: process.env.EMBED_API_KEY ?? "",
  // Dimension of the offline fallback embedder (ignored for a real endpoint,
  // whose dimension is whatever the model returns).
  embedFallbackDim: Number(process.env.EMBED_FALLBACK_DIM ?? 384),
} as const;

/**
 * A single Parachute vault the server can bind a request to. Tokens live ONLY
 * here, server-side — they are never serialized to a client (see the
 * `GET /api/vaults` response in routes/vaults.ts, which omits `token`/`url`).
 */
export interface VaultEntry {
  id: string;
  label: string;
  url: string;
  vault: string;
  token: string;
}

/**
 * The vault registry (multi-vault Phase 1). Optional `PRISM_VAULTS` env is a
 * JSON array `[{id,label,url,vault,token}]`. When unset/empty we synthesize ONE
 * entry, "primary", from the existing single-vault config — so the default
 * behavior with one configured vault is byte-for-byte unchanged. The first
 * entry is always the primary/default (what `resolveVaultEntry()` returns with
 * no id, and what every non-owner route + the legacy `vault` client use).
 */
function buildVaultRegistry(): VaultEntry[] {
  const raw = process.env.PRISM_VAULTS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`PRISM_VAULTS is not valid JSON: ${(e as Error).message}`);
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>;
        const id = String(o.id ?? `vault-${i}`);
        return {
          id,
          label: String(o.label ?? o.vault ?? id),
          url: String(o.url ?? config.parachuteUrl).replace(/\/+$/, ""),
          vault: String(o.vault ?? config.parachuteVault),
          token: String(o.token ?? ""),
        };
      });
    }
  }
  return [
    {
      id: "primary",
      label: config.parachuteVault,
      url: config.parachuteUrl,
      vault: config.parachuteVault,
      token: config.parachuteToken,
    },
  ];
}

export const vaultRegistry: VaultEntry[] = buildVaultRegistry();

/**
 * Resolve a vault id to its registry entry. Unknown/absent id → the
 * primary/first entry, so a stale or bogus `X-Prism-Vault` header degrades to
 * the default vault rather than erroring.
 */
export function resolveVaultEntry(id?: string | null): VaultEntry {
  if (id) {
    const found = vaultRegistry.find((v) => v.id === id);
    if (found) return found;
  }
  return vaultRegistry[0]!;
}

/** Whether a real embedding endpoint is configured (else the offline fallback). */
export const embeddingsConfigured = () => config.embedEndpoint.length > 0;

/** Whether magic-link email sign-in is available (Resend configured). */
export const emailEnabled = () => config.resendApiKey.length > 0;

/** Fail fast at startup if required secrets are missing. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.parachuteToken) missing.push("PARACHUTE_TOKEN");
  if (!config.sessionSecret) missing.push("SESSION_SECRET");
  if (!config.ownerEmail) missing.push("OWNER_EMAIL");
  // Each vault in the registry needs a url + vault name + token to be usable.
  // (For the default single-vault case this mirrors the PARACHUTE_* check above;
  // explicit PRISM_VAULTS entries are validated individually.)
  for (const v of vaultRegistry) {
    const bad = [!v.url && "url", !v.vault && "vault", !v.token && "token"].filter(Boolean);
    if (bad.length) missing.push(`PRISM_VAULTS["${v.id}"] (${bad.join("+")})`);
  }
  const unique = [...new Set(missing)];
  if (unique.length) {
    throw new Error(`Prism Server misconfigured — missing env: ${unique.join(", ")}`);
  }
}

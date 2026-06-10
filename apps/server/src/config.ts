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
  if (missing.length) {
    throw new Error(`Prism Server misconfigured — missing env: ${missing.join(", ")}`);
  }
}

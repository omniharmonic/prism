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

  resendApiKey: process.env.RESEND_API_KEY ?? "",
  magicFrom: process.env.MAGIC_FROM ?? "Prism <login@example.com>",

  dbPath: process.env.DB_PATH ?? "./prism-server.db",
} as const;

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

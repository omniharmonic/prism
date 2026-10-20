/**
 * The live facts behind the first-run checklist (`GET /acl/setup`, and the local sign-in's
 * "land on the checklist while setup is unfinished"). `setup-status.ts` stays pure; this reads
 * the database, the stored credentials and the vault.
 */
import { config } from "./config";
import { vault } from "./parachute";
import { getSecret, secretsConfigured } from "./secrets";
import { listLivePats } from "./auth/pat";
import { getUser, listLiveDeviceTokens } from "./db";
import { setupStatus, type SetupStep } from "./setup-status";
import { reachSeen } from "./reach";

export const SETUP_INTEGRATIONS = ["matrix", "fathom", "fireflies", "clickup", "github", "google", "notion", "proton-bridge"] as const;

export async function readSetupStatus(): Promise<{ ready: boolean; steps: SetupStep[] }> {
  const tokens = listLivePats(config.ownerEmail);
  const integrations: Record<string, boolean> = {};
  const seen = reachSeen(config.appOrigin);
  for (const k of SETUP_INTEGRATIONS) integrations[k] = secretsConfigured() && !!getSecret("primary", config.ownerEmail, k);
  return setupStatus({
    vaultReachable: await vault.health().catch(() => false),
    secretsAvailable: secretsConfigured(),
    emailConfigured: !!config.resendApiKey,
    appOrigin: config.appOrigin,
    reach: { self: !!seen.self, outside: !!seen.outside },
    ownerHasPassword: !!getUser(config.ownerEmail)?.password_hash,
    agentTokens: tokens.length,
    agentTokenUsed: tokens.some((t) => t.last_used_at !== null),
    devices: listLiveDeviceTokens(config.ownerEmail).length,
    integrations,
  });
}

/** Is anything outside the optional group still to do? (Unknown counts as unfinished.) */
export async function setupUnfinished(): Promise<boolean> {
  try {
    const s = await readSetupStatus();
    return s.steps.some((step) => !step.done && step.group !== "optional");
  } catch {
    return true;
  }
}

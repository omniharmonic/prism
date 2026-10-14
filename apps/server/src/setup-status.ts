/**
 * First-run setup, as a checklist a client can draw and an agent can work through.
 *
 * One answer for "what is done, what is next": each step has a stable `id` (a setup skill and the
 * checklist UI both key on it), the group it is shown under, whether it is done, and — when it is
 * not — one plain sentence saying what is missing. Nothing here is a secret or names one: only
 * whether a thing is configured.
 *
 * This is the SERVER's half. Before a server exists there is nothing to ask; the installer writes
 * the same shape of steps to a state file for the app to read (`docs/setup-state.md`).
 */

export type SetupGroup = "core" | "agent" | "devices" | "optional";

export interface SetupStep {
  id: string;
  group: SetupGroup;
  done: boolean;
  /** Present when the step is not done (or is done with something worth saying). Never a secret. */
  detail?: string;
}

export interface SetupFacts {
  vaultReachable: boolean;
  /** SECRETS_KEY is set: integration credentials can be stored. */
  secretsAvailable: boolean;
  emailConfigured: boolean;
  /** APP_ORIGIN as configured. */
  appOrigin: string;
  /** Live agent access tokens of the owner, and whether any has ever been used. */
  agentTokens: number;
  agentTokenUsed: boolean;
  /** Signed-in native devices of the owner. */
  devices: number;
  /** Integration kind → a credential is stored. */
  integrations: Record<string, boolean>;
}

/** An address another device can reach: https, and not this machine's own loopback. */
export function reachableOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  const step = (id: string, group: SetupGroup, done: boolean, detail?: string): SetupStep => ({ id, group, done, ...(detail ? { detail } : {}) });
  return [
    step("server", "core", true),
    step("vault", "core", f.vaultReachable, f.vaultReachable ? undefined : "The server cannot reach the vault. Check that Parachute is running and the vault token is current."),
    step("owner", "core", true),
    step("secrets", "core", f.secretsAvailable, f.secretsAvailable ? undefined : "SECRETS_KEY is not set, so no integration can be connected yet."),
    step("agent-token", "agent", f.agentTokens > 0, f.agentTokens > 0 ? undefined : "No agent access token has been created."),
    step("agent-connected", "agent", f.agentTokenUsed, f.agentTokenUsed ? undefined : f.agentTokens > 0 ? "A token exists, but no agent has used it yet." : "Create an agent access token first."),
    step("reachable", "devices", reachableOrigin(f.appOrigin), reachableOrigin(f.appOrigin) ? undefined : "This server answers on this computer only. A phone needs an https address (Tailscale or a Cloudflare tunnel)."),
    step("device", "devices", f.devices > 0, f.devices > 0 ? undefined : "No app has signed in to this server yet."),
    step("email", "optional", f.emailConfigured, f.emailConfigured ? undefined : "Sign-in links and invitations are printed in the server log instead of being emailed."),
    ...Object.entries(f.integrations).map(([kind, configured]) => step(`integration:${kind}`, "optional", configured)),
  ];
}

/** The whole answer: the steps, and whether the core is finished (the app is usable). */
export function setupStatus(f: SetupFacts): { ready: boolean; steps: SetupStep[] } {
  const steps = setupSteps(f);
  return { ready: steps.filter((s) => s.group === "core").every((s) => s.done), steps };
}

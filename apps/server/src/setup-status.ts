/**
 * First-run setup, as a checklist a client can draw and an agent can work through.
 *
 * One answer for "what is done, what is next": each step has a stable `id` (a setup skill and the
 * checklist UI both key on it), the group it is shown under, whether it is done, and — when it is
 * not — one plain sentence saying what is missing. Nothing here is a secret or names one: only
 * whether a thing is configured.
 *
 * This is the SERVER's half. Before a server exists there is nothing to ask: `prism setup` (the
 * host CLI) walks the steps up to a running server and then reads this checklist through
 * `POST /auth/local/setup`. The ids live in `setup-steps.ts`, shared by both.
 */

import type { ChecklistStepId } from "./setup-steps";

export type SetupGroup = "core" | "agent" | "devices" | "optional";

export interface SetupStep {
  /** One of `CHECKLIST_STEP_IDS` (setup-steps.ts), shared with `prism setup` and the skill. */
  id: ChecklistStepId;
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
  /** The owner account has a password (needed to sign in from a phone or another computer). Absent = not known, counted as done. */
  ownerHasPassword?: boolean;
  /** APP_ORIGIN as configured. */
  appOrigin: string;
  /**
   * What reached APP_ORIGIN through its proxy (reach.ts): `self` = the `prism reach` check from
   * this computer (proves the name, certificate and proxy only); `outside` = a request from
   * another device or from the internet. Absent = nothing seen.
   */
  reach?: { self: boolean; outside: boolean };
  /** Live agent access tokens of the owner, and whether any has ever been used. */
  agentTokens: number;
  agentTokenUsed: boolean;
  /** Signed-in native devices of the owner. */
  devices: number;
  /** Integration kind → a credential is stored. */
  integrations: Record<string, boolean>;
}

/** Names reserved for examples and tests (RFC 2606 / RFC 6761): a setup default, never a real address. */
const PLACEHOLDER_DOMAINS = ["example.com", "example.net", "example.org"];
const PLACEHOLDER_TLDS = ["example", "test", "invalid", "localhost"];

/** An address another device can reach: https, not this machine's own loopback, not a placeholder. */
export function reachableOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(host)) return false;
    if (PLACEHOLDER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    return !PLACEHOLDER_TLDS.includes(host.split(".").pop() ?? "");
  } catch {
    return false;
  }
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  const step = (id: ChecklistStepId, group: SetupGroup, done: boolean, detail?: string): SetupStep => ({ id, group, done, ...(detail ? { detail } : {}) });
  return [
    step("server", "core", true),
    step("vault", "core", f.vaultReachable, f.vaultReachable ? undefined : "The server cannot reach the vault. Check that Parachute is running and the vault token is current."),
    step("owner", "core", f.ownerHasPassword !== false, f.ownerHasPassword === false ? "Set a password so you can sign in from your phone and other computers. On this computer, `prism signin` always signs you in." : undefined),
    step("secrets", "core", f.secretsAvailable, f.secretsAvailable ? undefined : "SECRETS_KEY is not set, so no integration can be connected yet."),
    step("agent-token", "agent", f.agentTokens > 0, f.agentTokens > 0 ? undefined : "No agent access token has been created."),
    step("agent-connected", "agent", f.agentTokenUsed, f.agentTokenUsed ? undefined : f.agentTokens > 0 ? "A token exists, but no agent has used it yet." : "Create an agent access token first."),
    reachableStep(f),
    step("device", "devices", f.devices > 0, f.devices > 0 ? undefined : "No app has signed in to this server yet."),
    step("email", "optional", f.emailConfigured, f.emailConfigured ? undefined : "Optional. Without it you sign in on this computer with `prism signin`, and invitations are links you copy and send yourself."),
    ...Object.entries(f.integrations).map(([kind, configured]) => step(`integration:${kind}`, "optional", configured)),
  ];
}

/**
 * `reachable`: APP_ORIGIN is an address another device could open AND a request for that exact
 * address has been seen arriving from outside this machine. The server alone cannot know a
 * phone can get in; it waits until one has.
 */
function reachableStep(f: SetupFacts): SetupStep {
  const s = (done: boolean, detail?: string): SetupStep => ({ id: "reachable", group: "devices", done, ...(detail ? { detail } : {}) });
  if (!reachableOrigin(f.appOrigin)) {
    return s(false, "This server answers on this computer only. A phone needs an https address: `prism reach tailscale` sets one up with Tailscale (a Cloudflare tunnel also works).");
  }
  if (f.reach?.outside) return s(true);
  if (f.reach?.self) return s(false, `Prism answers at ${f.appOrigin} through Tailscale on this computer. Open that address on your phone (signed in to the same tailnet) to finish this step.`);
  return s(false, `No device has opened ${f.appOrigin} yet. Open it on your phone; with Tailscale, \`prism reach status\` checks it from this computer first.`);
}

/** The whole answer: the steps, and whether the core is finished (the app is usable). */
export function setupStatus(f: SetupFacts): { ready: boolean; steps: SetupStep[] } {
  const steps = setupSteps(f);
  return { ready: steps.filter((s) => s.group === "core").every((s) => s.done), steps };
}

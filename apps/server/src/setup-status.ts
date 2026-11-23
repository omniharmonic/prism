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

import type { ChecklistStepId, SendDoor } from "./setup-steps";

/**
 * `core`, `agent` and `devices` are setup proper ("N steps left"); `comms`, `sending` and
 * `optional` are things a person may or may not want, and never count as left to do.
 */
export type SetupGroup = "core" | "agent" | "devices" | "comms" | "sending" | "optional";
export const REQUIRED_GROUPS: readonly SetupGroup[] = ["core", "agent", "devices"];

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
  /** The Comms app's half (absent = an older caller: Comms is reported off). */
  comms?: CommsFacts;
  /** Omni (the agent app): its module is on, and Omni apps signed in. */
  omni?: { enabled: boolean; devices: number };
  /** Notes Minutes delivered into the vault (tag `minutes`); null = the vault could not be asked. */
  minutesNotes?: number | null;
  /** Each send switch as the server decides it right now (send-policy.ts, host-config.ts). */
  sending?: Partial<Record<SendDoor, boolean>>;
}

export interface CommsFacts {
  /** COMMS_ENABLED. */
  enabled: boolean;
  /** Conversations in the Comms projection; null = it could not be read. */
  threads: number | null;
  /** Live sign-ins of the Comms app (client `comms-native`). */
  devices: number;
  /** iMessage/SMS through BlueBubbles. `answers`: a ping just now (or the worker's last pass) got "pong". */
  bluebubbles: { enabled: boolean; urlAccepted: boolean; credential: boolean; answers: boolean | null };
}

export type EcosystemApp = "prism" | "comms" | "omni" | "minutes";
/** One line per app for the checklist's summary: set up (ready) or not yet. */
export interface EcosystemEntry {
  app: EcosystemApp;
  ready: boolean;
  /** One sentence when it is not ready. */
  detail?: string;
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
    ...commsSteps(f),
    minutesStep(f),
    ...sendSteps(f),
  ];
}

const COMMS_OFF = "Comms is off. Turn it on with `prism config set COMMS_ENABLED=true` (the prism-setup-comms skill walks through it).";

/** `comms` (module on, conversations in it), `comms-device` (the app signed in), iMessage via BlueBubbles. */
function commsSteps(f: SetupFacts): SetupStep[] {
  const c = f.comms;
  const step = (id: ChecklistStepId, done: boolean, detail?: string): SetupStep => ({ id, group: "comms", done, ...(detail ? { detail } : {}) });
  if (!c?.enabled) {
    return [step("comms", false, COMMS_OFF), step("comms-device", false, "Turn Comms on first."), step("integration:bluebubbles", false, "Optional, for iMessage and SMS. Turn Comms on first.")];
  }
  const commsDone = c.threads !== null && c.threads > 0;
  const commsDetail = c.threads === null
    ? "Comms is on, but its conversation list could not be read. Check the server log."
    : c.threads === 0
      ? "Comms is on, but no conversations are in it yet. Connect messages (Matrix), iMessage (BlueBubbles) or email, then give it a minute."
      : undefined;
  return [
    step("comms", commsDone, commsDetail),
    step("comms-device", c.devices > 0, c.devices > 0 ? undefined : "Install the Comms app on your Mac or iPhone, enter this server's address and sign in."),
    blueBubblesStep(c.bluebubbles),
  ];
}

function blueBubblesStep(b: CommsFacts["bluebubbles"]): SetupStep {
  const s = (done: boolean, detail?: string): SetupStep => ({ id: "integration:bluebubbles", group: "comms", done, ...(detail ? { detail } : {}) });
  if (!b.enabled) return s(false, "Optional, for iMessage and SMS: BlueBubbles Server on a Mac signed in to Messages, then `prism config set BLUEBUBBLES_ENABLED=true`.");
  if (!b.urlAccepted) return s(false, "BLUEBUBBLES_URL must be a loopback address on a port of its own (not Prism's, the vault's or LM Studio's 1234), for example http://127.0.0.1:1235.");
  if (!b.credential) return s(false, "Enter the BlueBubbles password and a webhook secret in Workspace settings → Server → Connections → BlueBubbles.");
  if (b.answers === false) return s(false, "BlueBubbles Server does not answer at BLUEBUBBLES_URL. Is it running on this Mac, on that port, and allowed through the firewall for this Mac only?");
  return s(true);
}

/** `minutes`: a meeting from the Minutes app has reached the vault. */
function minutesStep(f: SetupFacts): SetupStep {
  const n = f.minutesNotes;
  const done = typeof n === "number" && n > 0;
  const detail = done ? undefined
    : n === null ? "Optional. The vault could not be asked whether Minutes has delivered a meeting yet."
    : "Optional. Install Minutes on your Mac, connect it to this vault in Minutes' settings, and export a meeting (or turn on automatic export).";
  return { id: "minutes", group: "optional", done, ...(detail ? { detail } : {}) };
}

/**
 * The send switches, one by one. Off is a fine state: the server sends nothing to anyone until
 * the owner turns a switch on. Every message any app sends goes out through these, and only these
 * (the one door). A switch is `done` when it is on.
 */
const SEND_SENTENCES: Record<SendDoor, string> = {
  chat: "Off: Comms cannot send chat messages (WhatsApp, Signal, Telegram, Slack, …). To allow it, the owner confirms, then `prism config set COMMS_SEND_ENABLED=true ACTIONS_MATRIX_ENABLED=true --confirm-send`.",
  imessage: "Off: Comms cannot send iMessages or SMS. It needs COMMS_SEND_ENABLED (owner-confirmed, `--confirm-send`) and a BlueBubbles Server that answers.",
  email: "Off: Comms cannot send email replies. They go out only through Omni's approved email door: COMMS_EMAIL_ENABLED, COMMS_EMAIL_SEND_ENABLED and COMMS_SEND_ENABLED (owner-confirmed), Omni on, and its email executor set up.",
  "actions-email": "Off: Prism's live actions cannot send email. To allow it, the owner confirms, then `prism config set ACTIONS_EMAIL_ENABLED=true --confirm-send`.",
  "actions-calendar": "Off: Prism's live actions cannot create or change calendar events (which sends invitations). To allow it, the owner confirms, then `prism config set ACTIONS_CALENDAR_ENABLED=true --confirm-send`.",
};
function sendSteps(f: SetupFacts): SetupStep[] {
  return (Object.keys(SEND_SENTENCES) as SendDoor[]).map((door) => {
    const on = f.sending?.[door] === true;
    return { id: `send:${door}` as const, group: "sending" as const, done: on, ...(on ? {} : { detail: SEND_SENTENCES[door] }) };
  });
}

/** One line per app: what the checklist's summary shows at the top. */
export function ecosystem(f: SetupFacts, steps: SetupStep[]): EcosystemEntry[] {
  const done = (id: string) => steps.find((s) => s.id === id)?.done === true;
  const coreDone = steps.filter((s) => s.group === "core").every((s) => s.done);
  const entry = (app: EcosystemApp, ready: boolean, detail: string): EcosystemEntry => ({ app, ready, ...(ready ? {} : { detail }) });
  const omni = f.omni;
  return [
    entry("prism", coreDone, "Finish “Your workspace” below."),
    entry("comms", done("comms") && done("comms-device"), f.comms?.enabled ? "Finish the Comms steps below." : "Comms is off on this server."),
    entry("omni", !!omni?.enabled && omni.devices > 0, omni?.enabled ? "Sign in to the Omni app." : "Omni is not set up on this server."),
    entry("minutes", done("minutes"), "No meeting from Minutes has reached the vault yet."),
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

/** The whole answer: the steps, whether the core is finished (the app is usable), and the apps. */
export function setupStatus(f: SetupFacts): { ready: boolean; steps: SetupStep[]; ecosystem: EcosystemEntry[] } {
  const steps = setupSteps(f);
  return { ready: steps.filter((s) => s.group === "core").every((s) => s.done), steps, ecosystem: ecosystem(f, steps) };
}

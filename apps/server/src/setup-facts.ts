/**
 * The live facts behind the first-run checklist (`GET /acl/setup`, and the local sign-in's
 * "land on the checklist while setup is unfinished"). `setup-status.ts` stays pure; this reads
 * the database, the stored credentials and the vault.
 */
import { config } from "./config";
import { vault } from "./parachute";
import { getSecret, secretsConfigured } from "./secrets";
import { listLivePats } from "./auth/pat";
import { db, getUser, listLiveDeviceTokens } from "./db";
import { REQUIRED_GROUPS, setupStatus, type CommsFacts, type EcosystemEntry, type SetupStep } from "./setup-status";
import { reachSeen } from "./reach";
import { omniConfig } from "./omni/config";
import { blueBubblesActive, blueBubblesCreds, loopbackBaseUrl } from "./bluebubbles/config";
import { blueBubblesReachable } from "./bluebubbles/ready";
import { BlueBubblesClient } from "./bluebubbles/client";
import { emailSendEnabled, imessageSendEnabled, matrixSendEnabled } from "./comms/send-policy";

export const SETUP_INTEGRATIONS = ["matrix", "fathom", "fireflies", "clickup", "github", "google", "notion", "proton-bridge"] as const;

/** The checklist is read every few seconds while it is open: slow probes are remembered this long. */
const PROBE_TTL_MS = 30_000;
const BB_PROBE_TIMEOUT_MS = 3_000;

let bbProbe: { at: number; answers: boolean } | null = null;
let minutesProbe: { at: number; notes: number | null } | null = null;
let clock: () => number = () => Date.now();
type BbPing = (base: string, password: string) => Promise<void>;
let bbPing: BbPing = (base, password) => new BlueBubblesClient(base, password, fetch, BB_PROBE_TIMEOUT_MS).ping();

/** Tests: forget the remembered probes; optionally a clock and a BlueBubbles ping. */
export function resetSetupProbesForTests(o: { now?: () => number; ping?: BbPing } = {}): void {
  bbProbe = null;
  minutesProbe = null;
  clock = o.now ?? (() => Date.now());
  bbPing = o.ping ?? ((base, password) => new BlueBubblesClient(base, password, fetch, BB_PROBE_TIMEOUT_MS).ping());
}

/** Does BlueBubbles answer? The connector's own last pass counts; else one bounded ping, remembered. */
async function blueBubblesAnswers(): Promise<boolean | null> {
  if (!blueBubblesActive()) return null;
  const base = loopbackBaseUrl();
  const creds = blueBubblesCreds();
  if (!base || !creds) return null;
  if (blueBubblesReachable()) return true;
  if (bbProbe && clock() - bbProbe.at < PROBE_TTL_MS) return bbProbe.answers;
  const answers = await bbPing(base, creds.password).then(() => true, () => false);
  bbProbe = { at: clock(), answers };
  return answers;
}

/** How many notes Minutes has delivered (tag `minutes`, at most 1 counted); null = the vault did not answer. */
async function minutesNotes(): Promise<number | null> {
  if (minutesProbe && clock() - minutesProbe.at < PROBE_TTL_MS) return minutesProbe.notes;
  const notes = await vault.listNotes({ tags: ["minutes"], limit: 1, includeContent: false }).then((n) => n.length, () => null);
  minutesProbe = { at: clock(), notes };
  return notes;
}

function commsThreads(): number | null {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM comms_threads").get() as { n: number }).n;
  } catch {
    return null; // no table yet (the module has never run) or unreadable
  }
}

async function commsFacts(clients: string[]): Promise<CommsFacts> {
  const enabled = config.commsEnabled;
  return {
    enabled,
    threads: enabled ? commsThreads() : null,
    devices: clients.filter((c) => c === "comms-native").length,
    bluebubbles: {
      enabled: config.blueBubblesEnabled,
      urlAccepted: !!loopbackBaseUrl(),
      credential: !!blueBubblesCreds(),
      answers: enabled ? await blueBubblesAnswers() : null,
    },
  };
}

export async function readSetupStatus(): Promise<{ ready: boolean; steps: SetupStep[]; ecosystem: EcosystemEntry[] }> {
  const tokens = listLivePats(config.ownerEmail);
  const integrations: Record<string, boolean> = {};
  const seen = reachSeen(config.appOrigin);
  for (const k of SETUP_INTEGRATIONS) integrations[k] = secretsConfigured() && !!getSecret("primary", config.ownerEmail, k);
  const devices = listLiveDeviceTokens(config.ownerEmail);
  const clients = devices.map((d) => d.client_id);
  const [vaultReachable, comms, minutes] = await Promise.all([vault.health().catch(() => false), commsFacts(clients), minutesNotes()]);
  return setupStatus({
    vaultReachable,
    secretsAvailable: secretsConfigured(),
    emailConfigured: !!config.resendApiKey,
    appOrigin: config.appOrigin,
    reach: { self: !!seen.self, outside: !!seen.outside },
    ownerHasPassword: !!getUser(config.ownerEmail)?.password_hash,
    agentTokens: tokens.length,
    agentTokenUsed: tokens.some((t) => t.last_used_at !== null),
    devices: devices.length,
    integrations,
    comms,
    omni: { enabled: omniConfig.enabled(), devices: clients.filter((c) => c === "omni-native").length },
    minutesNotes: minutes,
    sending: {
      chat: matrixSendEnabled(),
      imessage: imessageSendEnabled(),
      email: emailSendEnabled(),
      "actions-email": config.actionsEmailEnabled,
      "actions-calendar": config.actionsCalendarEnabled,
    },
  });
}

/** Is anything in setup proper (not the optional apps or switches) still to do? (Unknown counts as unfinished.) */
export async function setupUnfinished(): Promise<boolean> {
  try {
    const s = await readSetupStatus();
    return s.steps.some((step) => !step.done && REQUIRED_GROUPS.includes(step.group));
  } catch {
    return true;
  }
}

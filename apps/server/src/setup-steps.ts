/**
 * The ONE list of setup step ids, read by both halves of setup (launch plan Phase 2: "the
 * checklist and the skill read the same step ids"):
 *
 *  - the server's checklist (`setup-status.ts` → `GET /acl/setup`, and `POST /auth/local/setup`
 *    for the host CLI), which says what is done on a RUNNING server;
 *  - `prism setup` (packaging/host/cli/setup.ts), the agent-run, resumable setup that gets a
 *    Mac from nothing to that checklist, and the `prism-setup` skill that drives it.
 *
 * A run step that is also a checklist step has the SAME id (`vault`, `secrets`, `server`,
 * `owner`, `device`, `reachable`); the run's own steps (`machine`, `install`, `vault-token`,
 * `schemas`, `mac-client`, `integrations`) exist before a server can answer or are not something
 * the server can see. Dependency-free: the host CLI bundles this file.
 */

/** Every id the server's checklist can emit (besides `integration:<kind>`). */
export const CHECKLIST_STEP_IDS = ["server", "vault", "owner", "secrets", "agent-token", "agent-connected", "reachable", "device", "email"] as const;

export type ChecklistStepId = (typeof CHECKLIST_STEP_IDS)[number] | `integration:${string}`;

export interface RunStepDef {
  id: string;
  /** One line a person can read. */
  title: string;
  /**
   * A blocking step that is not done stops the run (later steps depend on it). The person-facing
   * steps after the server is running are not blocking: the run reports all of them at once.
   */
  blocking: boolean;
  /** The id is also a checklist step id (same meaning, read from the server once it runs). */
  checklist: boolean;
  /** The skill that explains the step in detail. */
  skill: string;
}

/** The order of `prism setup` (launch plan Phase 2, "One resumable skill run"). */
export const RUN_STEPS: readonly RunStepDef[] = [
  { id: "machine", title: "This Mac can host Prism", blocking: true, checklist: false, skill: "prism-setup-server" },
  { id: "install", title: "The Prism host bundle is installed", blocking: true, checklist: false, skill: "prism-setup-server" },
  { id: "vault", title: "Parachute (the vault) is running", blocking: true, checklist: true, skill: "prism-setup-vault" },
  { id: "secrets", title: "The server's secrets are in its .env", blocking: true, checklist: true, skill: "prism-setup-server" },
  { id: "vault-token", title: "The server holds a working vault token", blocking: true, checklist: false, skill: "prism-setup-vault" },
  { id: "schemas", title: "The vault knows Prism's tag schemas", blocking: true, checklist: false, skill: "prism-setup-schema" },
  { id: "server", title: "Prism Server is running", blocking: true, checklist: true, skill: "prism-setup-server" },
  { id: "owner", title: "The owner has signed in and set a password", blocking: false, checklist: true, skill: "prism-setup-server" },
  { id: "mac-client", title: "Prism Client is on this Mac", blocking: false, checklist: false, skill: "prism-setup-reach" },
  { id: "device", title: "A phone or another computer is signed in", blocking: false, checklist: true, skill: "prism-setup-reach" },
  { id: "reachable", title: "Reachable from other devices", blocking: false, checklist: true, skill: "prism-setup-reach" },
  { id: "integrations", title: "Optional connections (mail, calendar, messages, …)", blocking: false, checklist: false, skill: "prism-setup-integrations" },
];

export type RunStepId = (typeof RUN_STEPS)[number]["id"];

export const RUN_STEP_IDS: readonly string[] = RUN_STEPS.map((s) => s.id);

/** The skill for any step id, run or checklist (the checklist's "Have your agent do it"). */
export function skillForStep(id: string): string | null {
  const run = RUN_STEPS.find((s) => s.id === id);
  if (run) return run.skill;
  if (id === "agent-token" || id === "agent-connected") return "prism-setup-agent";
  if (id === "email") return "prism-setup-server";
  if (id.startsWith("integration:")) return "prism-setup-integrations";
  return null;
}

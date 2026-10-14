import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, ClipboardCopy, RefreshCw } from "lucide-react";
import type { SetupStatus, SetupStep } from "../../../data/CollabSharing";
import { copyText } from "../../../lib/clipboard";
import "./setup-checklist.css";

/**
 * First-run setup as a checklist (`GET /acl/setup`).
 *
 * Each step that is not done offers the two ways to do it: hand it to your agent (a prompt to
 * copy, naming the step so the setup skill knows which one) or do it yourself. The list reads the
 * server again every few seconds while it is open, so a step ticks when the agent finishes it —
 * nobody has to come back and ask.
 */

const GROUPS: Array<{ id: SetupStep["group"]; title: string; about: string }> = [
  { id: "core", title: "Your workspace", about: "What Prism needs to run." },
  { id: "agent", title: "Your agent", about: "Let an AI agent read and write your workspace, with its own token." },
  { id: "devices", title: "Your devices", about: "Reach this server from your phone and other computers." },
  { id: "optional", title: "Optional", about: "Connect only what you use. Everything here can wait." },
];

const INTEGRATIONS: Record<string, string> = {
  matrix: "Messages (Matrix)", "proton-bridge": "Email (Proton Mail Bridge)", google: "Google Calendar and Gmail",
  fireflies: "Meeting transcripts (Fireflies)", fathom: "Meeting transcripts (Fathom)", clickup: "Tasks (ClickUp)", notion: "Notion", github: "GitHub",
};
const NAMES: Record<string, string> = {
  server: "Prism Server is running", vault: "Vault connected", owner: "Owner account", secrets: "Secure storage for connection details",
  "agent-token": "Create an agent access token", "agent-connected": "Your agent has connected",
  reachable: "Reachable from other devices", device: "An app is signed in", email: "Email for sign-in links and invitations",
};
/** What doing the step yourself means, in one line. */
const BY_HAND: Record<string, string> = {
  vault: "Start Parachute on the server's computer, then check the vault token in the server's settings.",
  secrets: "Add a SECRETS_KEY to the server's .env file and restart the server.",
  "agent-token": "Open Settings → Account → Agent access tokens and create one.",
  "agent-connected": "Paste the token's connection block into your agent, then press “Test connection” there.",
  reachable: "Install Tailscale on this computer and your phone, or set up a Cloudflare tunnel, and set the server's address to the https one.",
  device: "Install Prism on your phone or another computer and sign in to this server's address.",
  email: "Add a Resend API key to the server's settings.",
};

export const setupStepName = (step: Pick<SetupStep, "id">): string =>
  NAMES[step.id] ?? (step.id.startsWith("integration:") ? INTEGRATIONS[step.id.slice(12)] ?? step.id.slice(12) : step.id);

/** The prompt to hand an agent for one step. It names the step id the setup skill keys on. */
export function setupAgentPrompt(step: SetupStep, origin: string): string {
  return [
    `Help me finish setting up Prism. Use the prism-setup skill.`,
    `Step: ${step.id} — ${setupStepName(step)}.`,
    step.detail ? `Where it stands: ${step.detail}` : "",
    origin ? `My Prism server: ${origin}` : "",
    `Do only this step, tell me what you are about to change before you change it, and tell me when it is done so I can check it off.`,
  ].filter(Boolean).join("\n");
}

export function SetupChecklist({ load, origin = "", intervalMs = 5000 }: { load: () => Promise<SetupStatus>; origin?: string; intervalMs?: number }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const alive = useRef(true);
  const read = useCallback(async () => {
    setBusy(true);
    try {
      const next = await load();
      if (!alive.current) return;
      setStatus(next);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    alive.current = true;
    void read();
    // While something is still to do, look again: a step an agent finishes ticks by itself.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, intervalMs);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [read, intervalMs]);

  if (!status) return <p role="status" className="text-sm" style={{ color: "var(--text-secondary)" }}>{failed ? "Setup progress could not be read. Check that the server is running." : "Reading setup progress…"}</p>;
  const left = status.steps.filter((s) => !s.done && s.group !== "optional").length;
  // The one to do next carries the emphasis; the rest are offered quietly.
  const next = status.steps.find((s) => !s.done && s.group !== "optional")?.id;
  return (
    <section aria-label="Setup" className="prism-setup">
      <header className="prism-setup-head">
        <div>
          <h3>{left === 0 ? "Setup is complete" : `${left} ${left === 1 ? "step" : "steps"} left`}</h3>
          <p>{status.ready ? "Prism is ready to use. The rest can be done whenever you like, by you or by your agent." : "Finish the first group to start using Prism."}</p>
        </div>
        <button type="button" className="prism-setup-refresh focus-ring" onClick={() => void read()} disabled={busy} aria-label="Check setup again"><RefreshCw size={14} aria-hidden="true" /></button>
      </header>
      {failed && <p role="status" className="prism-setup-note">Setup progress could not be refreshed. Showing what was last read.</p>}
      {GROUPS.map((group) => {
        const steps = status.steps.filter((s) => s.group === group.id);
        if (!steps.length) return null;
        return (
          <div key={group.id} className="prism-setup-group" role="group" aria-label={group.title}>
            <h4>{group.title}<span>{steps.filter((s) => s.done).length} of {steps.length}</span></h4>
            <p>{group.about}</p>
            <ul>
              {steps.map((step) => {
                const name = setupStepName(step);
                const hand = BY_HAND[step.id] ?? (step.id.startsWith("integration:") ? "Open Workspace settings → Server → Connections and add its details." : "");
                return (
                  <li key={step.id} data-done={step.done} data-step={step.id} data-next={step.id === next || undefined}>
                    <span className="prism-setup-mark" aria-hidden="true">{step.done ? <Check size={13} /> : <Circle size={13} />}</span>
                    <div className="prism-setup-body">
                      <strong>{name}<span className="sr-only">{step.done ? " — done" : " — not done"}</span></strong>
                      {!step.done && step.detail && <p>{step.detail}</p>}
                      {!step.done && (
                        <div className="prism-setup-actions">
                          <button type="button" className="focus-ring" onClick={() => { void copyText(setupAgentPrompt(step, origin)).then((ok) => { if (ok && alive.current) setCopied(step.id); }); }}>
                            <ClipboardCopy size={13} aria-hidden="true" /> {copied === step.id ? "Copied. Paste it to your agent" : "Have your agent do it"}
                          </button>
                          {hand && <button type="button" className="focus-ring" aria-expanded={open === step.id} onClick={() => setOpen(open === step.id ? null : step.id)}>Do it myself</button>}
                        </div>
                      )}
                      {!step.done && open === step.id && hand && <p className="prism-setup-hand">{hand}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

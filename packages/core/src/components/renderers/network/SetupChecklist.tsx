import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, ClipboardCopy, QrCode, RefreshCw } from "lucide-react";
import type { DevicePairingClient, SetupStatus, SetupStep } from "../../../data/CollabSharing";
import { PairPhoneDialog } from "./PairPhoneDialog";
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
  { id: "comms", title: "Comms", about: "Optional. Every conversation (email, iMessage, chat networks) in one app, served by this server." },
  { id: "sending", title: "Sending", about: "Every message any app sends leaves through this server, and only through these switches. They stay off until you turn one on, and turning one on is always your decision. Off is a fine answer." },
  { id: "optional", title: "Optional", about: "Connect only what you use. Everything here can wait." },
];
/** Setup proper: these count as "steps left". Comms, Sending and Optional never do. */
const REQUIRED_GROUPS = new Set<SetupStep["group"]>(["core", "agent", "devices"]);

const APPS: Record<string, string> = { prism: "Prism", comms: "Comms", omni: "Omni", minutes: "Minutes" };

const INTEGRATIONS: Record<string, string> = {
  matrix: "Messages (Matrix)", "proton-bridge": "Email (Proton Mail Bridge)", google: "Google Calendar and Gmail",
  fireflies: "Meeting transcripts (Fireflies)", fathom: "Meeting transcripts (Fathom)", clickup: "Tasks (ClickUp)", notion: "Notion", github: "GitHub",
  bluebubbles: "iMessage and SMS (BlueBubbles)",
};
const NAMES: Record<string, string> = {
  server: "Prism Server is running", vault: "Vault connected", owner: "Owner account", secrets: "Secure storage for connection details",
  "agent-token": "Create an agent access token", "agent-connected": "Your agent has connected",
  reachable: "Reachable from other devices", device: "An app is signed in", email: "Email for sign-in links and invitations",
  comms: "Comms is on, with conversations in it", "comms-device": "The Comms app is signed in", minutes: "Meeting notes from Minutes",
  "send:chat": "Send chat messages from Comms", "send:imessage": "Send iMessages and SMS from Comms", "send:email": "Send email replies from Comms",
  "send:actions-email": "Send email from Prism's live actions", "send:actions-calendar": "Create and change calendar events",
};
/** What doing the step yourself means, in one line. */
const BY_HAND: Record<string, string> = {
  vault: "Start Parachute on the server's computer, then check the vault token in the server's settings.",
  secrets: "Add a SECRETS_KEY to the server's .env file and restart the server.",
  "agent-token": "Open Settings → Account → Agent access tokens and create one.",
  "agent-connected": "Paste the token's connection block into your agent, then press “Test connection” there.",
  reachable: "Install Tailscale on this computer and your phone, or set up a Cloudflare tunnel, and set the server's address to the https one.",
  device: "Install Prism on your phone, then use “Pair a phone” here and scan the code with the phone's camera. Or open Prism on the phone or another computer and sign in to this server's address.",
  email: "Optional. Add RESEND_API_KEY to the server's .env file and restart it. Without email, sign in on the server's computer with “prism signin”.",
  owner: "Open Settings → Account and set a password.",
  comms: "On the server's computer run “prism config set COMMS_ENABLED=true”, then connect messages, iMessage or email.",
  "comms-device": "Install the Comms app on your Mac or iPhone, enter this server's address and sign in.",
  "integration:bluebubbles": "Run BlueBubbles Server on a Mac signed in to Messages (port 1235), run “prism config set BLUEBUBBLES_ENABLED=true”, then enter its password here under Connections.",
  minutes: "Install Minutes, connect it to this vault in its settings, and export a meeting.",
};
/** A send switch is only ever turned on by you, on the server's computer. */
const SEND_BY_HAND = "Decide whether this server may send this kind of message. If yes, run the “prism config set … --confirm-send” command above on the server's computer. Leaving it off is fine.";

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

export function SetupChecklist({ load, origin = "", intervalMs = 5000, pairing }: { load: () => Promise<SetupStatus>; origin?: string; intervalMs?: number; pairing?: DevicePairingClient }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const pairReturn = useRef<HTMLButtonElement | null>(null);
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
    // Coming back to the window (from the terminal where the agent works) reads at once.
    const onVisible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [read, intervalMs]);

  if (!status) return <p role="status" className="text-sm" style={{ color: "var(--text-secondary)" }}>{failed ? "Setup progress could not be read. Check that the server is running." : "Reading setup progress…"}</p>;
  const left = status.steps.filter((s) => !s.done && REQUIRED_GROUPS.has(s.group)).length;
  // The one to do next carries the emphasis; the rest are offered quietly.
  const next = status.steps.find((s) => !s.done && REQUIRED_GROUPS.has(s.group))?.id;
  // A QR names this server's address for the phone: only once another device can reach it.
  const reachable = status.steps.find((s) => s.id === "reachable")?.done !== false;
  const pairButton = (step: SetupStep) =>
    pairing && step.id === "device" ? (
      <button type="button" className="focus-ring" onClick={(e) => { pairReturn.current = e.currentTarget; setPairOpen(true); }} disabled={!reachable} aria-describedby={reachable ? undefined : "prism-setup-pair-why"}>
        <QrCode size={13} aria-hidden="true" /> {step.done ? "Pair another phone" : "Pair a phone"}
      </button>
    ) : null;
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
      {status.ecosystem && status.ecosystem.length > 0 && (
        <ul className="prism-setup-apps" aria-label="Your apps">
          {status.ecosystem.map((a) => (
            <li key={a.app} data-ready={a.ready} title={a.ready ? undefined : a.detail}>
              <span className="prism-setup-mark" aria-hidden="true">{a.ready ? <Check size={12} /> : <Circle size={12} />}</span>
              <span>{APPS[a.app] ?? a.app}</span>
              <em>{a.ready ? "Ready" : "Set up"}</em>
              {!a.ready && a.detail && <span className="sr-only">: {a.detail}</span>}
            </li>
          ))}
        </ul>
      )}
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
                const hand = BY_HAND[step.id] ?? (step.id.startsWith("integration:") ? "Open Workspace settings → Server → Connections and add its details." : step.id.startsWith("send:") ? SEND_BY_HAND : "");
                return (
                  <li key={step.id} data-done={step.done} data-step={step.id} data-next={step.id === next || undefined}>
                    <span className="prism-setup-mark" aria-hidden="true">{step.done ? <Check size={13} /> : <Circle size={13} />}</span>
                    <div className="prism-setup-body">
                      <strong>{name}<span className="sr-only">{step.done ? " — done" : " — not done"}</span></strong>
                      {!step.done && step.detail && <p>{step.detail}</p>}
                      {step.done && pairing && step.id === "device" && <div className="prism-setup-actions">{pairButton(step)}</div>}
                      {!step.done && pairing && step.id === "device" && !reachable && <p id="prism-setup-pair-why">Pairing a phone needs the step above first: a phone can only scan its way to an https address.</p>}
                      {!step.done && (
                        <div className="prism-setup-actions">
                          {pairButton(step)}
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
      {pairOpen && pairing && <PairPhoneDialog client={pairing} onClose={() => setPairOpen(false)} onPaired={() => void read()} returnFocus={pairReturn.current} />}
    </section>
  );
}

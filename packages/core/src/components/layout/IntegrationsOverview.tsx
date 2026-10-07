import { useEffect, useState } from "react";
import { useCollabSharing, useVaultChangeSignal } from "../../data/CollabSharing";
import { useUIStore } from "../../app/stores/ui";
import { useNetworkTabRequest } from "../../lib/network/tabRequest";

/** The inputs a Prism Server can hold a credential for (`/api/integrations/<kind>`), in the order Connections lists them. */
const INPUTS: Array<{ kind: string; name: string; brings: string }> = [
  { kind: "proton-bridge", name: "Proton Mail Bridge", brings: "Email" },
  { kind: "matrix", name: "Matrix", brings: "Messages (WhatsApp, Telegram, Discord through bridges)" },
  { kind: "google", name: "Google", brings: "Calendar and Google Docs" },
  { kind: "fireflies", name: "Fireflies", brings: "Meeting transcripts" },
  { kind: "fathom", name: "Fathom", brings: "Meeting transcripts" },
  { kind: "clickup", name: "ClickUp", brings: "Tasks" },
  { kind: "notion", name: "Notion", brings: "Notion pages and databases" },
  { kind: "github", name: "GitHub", brings: "Folder sync to a repository" },
];

type State = "on" | "off" | "unknown";

/**
 * Settings → Inputs & integrations on a server-backed shell (web, Prism Client).
 * Credentials live on the Prism Server and are write-only, so this section never
 * holds a field of its own: it says what is connected and opens the one place
 * that edits them (Workspace settings → Connections).
 */
export function IntegrationsOverview({ onNavigate }: { onNavigate: () => void }) {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [states, setStates] = useState<Record<string, State>>({});
  const canRead = !!sharing?.getViewer && !!sharing.getIntegrationStatus;

  useEffect(() => {
    let live = true;
    setStates({});
    if (!sharing?.getViewer) { setAdmin(false); return; }
    setAdmin(null);
    sharing.getViewer()
      .then((v) => { if (live) setAdmin(v.role === "owner" || v.role === "admin"); })
      .catch(() => { if (live) setAdmin(false); });
    return () => { live = false; };
  }, [sharing, vaultSignal]);

  useEffect(() => {
    if (!admin || !sharing?.getIntegrationStatus) return;
    let live = true;
    void Promise.all(INPUTS.map(async ({ kind }) => {
      try { return [kind, (await sharing.getIntegrationStatus!(kind)).configured ? "on" : "off"] as const; }
      catch { return [kind, "unknown"] as const; }
    })).then((rows) => { if (live) setStates(Object.fromEntries(rows)); });
    return () => { live = false; };
  }, [admin, sharing, vaultSignal]);

  const open = () => {
    useNetworkTabRequest.getState().request("server");
    onNavigate();
    useUIStore.getState().openTab("network", "Workspace settings", "network");
  };

  return (
    <section className="prism-settings__section" aria-label="Inputs">
      <h4>Connected inputs</h4>
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        Inputs are kept on the Prism Server, per vault, and are write-only: a saved key or password is never shown again, only replaced or removed.
      </p>
      <ul className="prism-settings__list" aria-label="Inputs and integrations">
        {INPUTS.map(({ kind, name, brings }) => {
          const state = states[kind];
          return (
            <li key={kind} data-input={kind}>
              <span><span className="block font-medium">{name}</span><span className="prism-settings__hint">{brings}</span></span>
              {admin && canRead && (
                <span className="prism-settings__badge" data-on={state === "on"}>
                  {state === "on" ? "Connected" : state === "off" ? "Not connected" : state === "unknown" ? "Status unavailable" : "Checking…"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {admin ? (
        <button type="button" className="focus-ring mt-4 min-h-11 rounded-lg border border-[var(--glass-border)] px-3 text-sm" onClick={open}>Manage connections</button>
      ) : admin === false ? (
        <p role="note" className="mt-4 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          A workspace owner or admin connects these in Workspace settings → Connections.
        </p>
      ) : null}
    </section>
  );
}

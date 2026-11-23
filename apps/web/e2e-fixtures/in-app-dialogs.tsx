/**
 * In-app confirmation fixture: the REAL account settings (signed-in devices, agent tokens) inside a
 * modal `<dialog>` — the way Settings shows them — over an in-page fake account (fictional data),
 * plus the two self-mounting calls every other surface uses (`askConfirm`, `showMessage`).
 *
 *   ?dark
 * `window.prismDialogs`: `calls` (every account write), `answers` (what each `ask` button got),
 * `askConfirm`, `showMessage`.
 */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountProvider, askConfirm, showMessage, type ConfirmOptions } from "@prism/core/shell";
import { AccountSettings } from "../../../packages/core/src/components/layout/AccountSettings";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";
import "../../../packages/core/src/styles/touch.css";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const at = Date.UTC(2026, 9, 2, 15, 30);
const calls: string[] = [];
const answers: unknown[] = [];
let devices = [
  { id: "dev-1", label: "Avery’s iPhone", createdAt: at, lastSeenAt: at, expiresAt: at + 9e9, current: false },
  { id: "dev-2", label: "Studio Mac", createdAt: at, lastSeenAt: at, expiresAt: at + 9e9, current: true },
];
let tokens = [{ id: "tok-1", prefix: "pp_Ab3dE6", vaultId: "primary", scope: "read" as const, label: "Research agent", createdAt: at, lastUsedAt: null, expiresAt: at + 9e9 }];
const account = {
  getProfile: async () => ({ email: "avery@example.test", name: "Avery", avatar: null, hasPassword: true }),
  updateProfile: async () => {},
  changePassword: async () => {},
  listDevices: async () => devices,
  revokeDevice: async (id: string) => { calls.push(`revokeDevice:${id}`); devices = devices.filter((d) => d.id !== id); },
  listAgentTokens: async () => ({ tokens, mcpUrl: "https://prism.example.test/mcp" }),
  createAgentToken: async () => { throw new Error("not in this fixture"); },
  revokeAgentToken: async (id: string) => { calls.push(`revokeAgentToken:${id}`); tokens = tokens.filter((t) => t.id !== id); },
};
Object.assign(window, { prismDialogs: { calls, answers, askConfirm, showMessage } });

const QUESTION: ConfirmOptions = { title: "Delete this event?", body: "Guests are told.\nThis cannot be undone.", confirm: "Delete", danger: true };

function App() {
  const settings = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) settings.current?.showModal(); else settings.current?.close(); }, [open]);
  return (
    <main style={{ padding: 24, display: "flex", gap: 12, flexWrap: "wrap", background: "var(--bg-base)", color: "var(--text-primary)", minHeight: "100dvh", boxSizing: "border-box", alignContent: "start" }}>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <button type="button" onClick={() => void askConfirm(QUESTION).then((a) => answers.push(a))}>Ask</button>
      <button type="button" onClick={() => void askConfirm({ title: "Add these 3 links now?", confirm: "Add links" }).then((a) => answers.push(a))}>Ask plain</button>
      <button type="button" onClick={() => void showMessage("Resolved 3 of 4 wikilinks.", "Wikilinks").then(() => answers.push("told"))}>Tell</button>
      <button type="button" onClick={() => { void askConfirm({ title: "First?" }).then((a) => answers.push(`first:${a}`)); void askConfirm({ title: "Second?" }).then((a) => answers.push(`second:${a}`)); }}>Ask twice</button>
      <dialog ref={settings} aria-label="Settings" onCancel={(e) => { e.preventDefault(); setOpen(false); }} style={{ width: "min(640px, calc(100vw - 24px))", maxHeight: "90dvh", overflow: "auto", border: "1px solid var(--glass-border)", borderRadius: 12, background: "var(--bg-elevated)", color: "var(--text-primary)", padding: 16 }}>
        <button type="button" onClick={() => setOpen(false)}>Close settings</button>
        {open && <AccountProvider value={account as never}><AccountSettings /></AccountProvider>}
      </dialog>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

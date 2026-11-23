/**
 * Account deletion fixture (docs/account-deletion.md): the REAL account settings inside a modal
 * `<dialog>` — the way Settings shows them — over an in-page fake account (fictional data) whose
 * `deleteAccount` answers like the server: the typed email must match, a password account needs
 * its password ("right password"), the server owner is refused.
 *
 *   ?owner        the signed-in account is the server owner (no button, an explanation)
 *   ?nopassword   an account without a password (no password field)
 *   ?nodelete     a shell without the route (no section at all)
 *   ?dark
 * `window.prismAccountDelete`: `calls` (every deleteAccount input), `deleted` (true once accepted).
 */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountProvider } from "@prism/core/shell";
import { AccountSettings } from "../../../packages/core/src/components/layout/AccountSettings";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";
import "../../../packages/core/src/styles/touch.css";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const owner = params.has("owner");
const hasPassword = !params.has("nopassword");
const EMAIL = owner ? "owner@example.test" : "avery@example.test";
const state = { calls: [] as Array<{ confirm: string; password?: string }>, deleted: false };
Object.assign(window, { prismAccountDelete: state });

const account = {
  getProfile: async () => ({ email: EMAIL, name: "Avery", avatar: null, hasPassword, isServerOwner: owner, serverName: "prism.example.test" }),
  updateProfile: async () => {},
  changePassword: async () => {},
  ...(params.has("nodelete") ? {} : {
    deleteAccount: async (input: { confirm: string; password?: string }) => {
      state.calls.push(input);
      if (owner) throw new Error("This is the server owner's account. Removing the server removes it.");
      if (input.confirm.trim().toLowerCase() !== EMAIL) throw new Error("The email address does not match this account.");
      if (hasPassword && input.password !== "right password") throw new Error("That password is incorrect.");
      state.deleted = true;
      // The web shell reloads into its sign-in screen here; the fixture shows a stand-in.
      document.body.dataset.accountDeleted = "1";
    },
  }),
};

function App() {
  const settings = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (open) settings.current?.showModal(); else settings.current?.close(); }, [open]);
  return (
    <main style={{ padding: 24, background: "var(--bg-base)", color: "var(--text-primary)", minHeight: "100dvh", boxSizing: "border-box" }}>
      <button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <dialog ref={settings} aria-label="Settings" onCancel={(e) => { e.preventDefault(); setOpen(false); }} style={{ width: "min(640px, calc(100vw - 24px))", maxHeight: "90dvh", overflow: "auto", border: "1px solid var(--glass-border)", borderRadius: 12, background: "var(--bg-elevated)", color: "var(--text-primary)", padding: 16, boxSizing: "border-box" }}>
        <button type="button" onClick={() => setOpen(false)}>Close settings</button>
        {open && <AccountProvider value={account as never}><AccountSettings /></AccountProvider>}
      </dialog>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

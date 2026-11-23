import { useState } from "react";
import { webCollabSharing } from "../collab/grant";

/** A context-bearing browser source never opens against an unrelated saved vault. */
export function SourceVaultMismatch({ vault }: { vault: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function switchVault() {
    setBusy(true); setProblem(null);
    try {
      const list = webCollabSharing.listVaults;
      const select = webCollabSharing.setActiveVault;
      if (!list || !select) throw new Error("Vault selection is unavailable in this workspace.");
      const permitted = await list();
      if (!permitted.some(v => v.id === vault)) throw new Error("This account cannot select the source vault. Sign in with an account that has access.");
      select(vault);
      // Reload re-checks the signed-in identity in this vault before any note opens.
      window.location.reload();
    } catch (e) { setProblem(e instanceof Error ? e.message : "The source vault could not be verified."); setBusy(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center p-6">
    <div className="workspace-auth-card w-full max-w-md rounded-2xl p-7">
      <h1 className="text-xl font-semibold">This source belongs to another vault</h1>
      <p className="mt-3">The source names the {vault} vault. Prism has kept your current vault and has not opened the note.</p>
      <button className="focus-ring mt-5 rounded-lg px-4 py-3" disabled={busy} onClick={() => void switchVault()}>{busy ? "Checking access…" : "Select source vault"}</button>
      {problem && <p role="alert" className="mt-3">{problem}</p>}
    </div>
  </main>;
}

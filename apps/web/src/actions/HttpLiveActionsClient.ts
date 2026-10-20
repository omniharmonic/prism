/**
 * The web shell's LiveActionsClient (Arch v2 WP1.5): email (Proton Bridge),
 * calendar (gog) and Matrix actions over `/api/actions/*`.
 *
 * Requests go through `serverFetch` (transport.ts), so the same client works in
 * the PWA (same-origin session cookie → the server treats it as HUMAN origin)
 * and the native build (bearer device token → also human). `contextHeaders()`
 * names the active vault: credentials are stored per vault.
 */
import { createHttpLiveActionsClient } from "@prism/core/shell";
import { serverFetch } from "../transport";
import { contextHeaders, agentScope, getMe } from "../config";

export const httpLiveActionsClient = createHttpLiveActionsClient({
  fetch: (path, init) => serverFetch(path, init),
  headers: () => {
    if (!agentScope()) throw new Error("Reconnect to your workspace before using live actions.");
    const me = getMe()!;
    return { ...contextHeaders(), "X-Prism-Workspace": me.workspace!.id, "X-Prism-Vault": me.vaultId!, "X-Prism-Write-Actor": `user:${me.email}` };
  },
  scope: () => agentScope() ?? "",
});

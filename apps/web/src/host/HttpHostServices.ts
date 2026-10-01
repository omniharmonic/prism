/**
 * The web shell's HostServices (Arch v2 WP4.3): the server-side replacements for
 * the legacy desktop's host commands — calendar range sync, note sync to Google
 * Docs / Notion, the Notion page picker and the read-only inline agent.
 *
 * Requests go through `serverFetch` (transport.ts), so the same client works in
 * the PWA (same-origin session cookie) and the Prism Client (bearer device
 * token). `contextHeaders()` names the active vault/workspace. main.tsx provides
 * it to the SERVER OWNER only (the routes are admin/owner-gated anyway; this
 * keeps the affordances hidden from everyone else).
 */
import { createHttpHostServices } from "@prism/core";
import { serverFetch } from "../transport";
import { contextHeaders, agentScope, getMe } from "../config";

export const httpHostServices = createHttpHostServices({
  fetch: (path, init) => serverFetch(path, init),
  headers: () => {
    if (!agentScope()) throw new Error("Reconnect to this workspace before using server services.");
    const me = getMe()!;
    return { ...contextHeaders(), "X-Prism-Workspace": me.workspace!.id, "X-Prism-Vault": me.vaultId!, "X-Prism-Write-Actor": `user:${me.email}` };
  },
  scope: () => agentScope() ?? "",
});

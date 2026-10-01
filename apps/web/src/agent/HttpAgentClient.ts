/**
 * The web shell's AgentClient (Arch v2 WP3.2): durable server-side agent
 * sessions over `/api/agent/sessions*`.
 *
 * Requests go through `serverFetch` and streams through `streamServerSSE`
 * (transport.ts), so the same client works in the PWA (same-origin, session
 * cookie) and the native build (configured origin, bearer device token). Streams
 * resume with `?after=` + `Last-Event-ID`. `contextHeaders()` names the active
 * vault/workspace: sessions live per vault.
 */
import { createHttpAgentClient } from "@prism/core";
import { serverFetch, streamServerSSE } from "../transport";
import { contextHeaders } from "../config";
import { withTurnEndNotifications } from "../native/notifyTurnEnd";

export const httpAgentClient = withTurnEndNotifications(createHttpAgentClient({
  fetch: (path, init) => serverFetch(path, init),
  sse: (path, opts) => streamServerSSE(path, opts),
  headers: () => contextHeaders(),
  scope: () => {
    const h = contextHeaders();
    return `${h["X-Prism-Workspace"] ?? ""}/${h["X-Prism-Vault"] ?? ""}`;
  },
}));

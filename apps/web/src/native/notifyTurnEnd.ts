// Native notification when an agent turn ends while the app is not focused
// (WP4.2). Wraps the agent client's stream: the same terminal `status` event
// that updates the chat also asks the shell to notify. The shell decides
// whether to show it (only when the main window is unfocused), sanitises and
// caps the text, and rate-limits. Background push for a CLOSED app is WP5/APNs.
import type { AgentClient, AgentStreamHandlers } from "@prism/core/shell";
import { isNative } from "../transport";

interface Shell {
  notify?(title: string, body: string, sessionId?: string | null): Promise<boolean>;
}
const shell = (): Shell | undefined => (window as unknown as { __PRISM_SHELL__?: Shell }).__PRISM_SHELL__;

const TEXT: Record<string, [string, string]> = {
  done: ["Prism agent finished", "Your agent has a reply."],
  error: ["Prism agent hit an error", "A turn ended with an error."],
  interrupted: ["Prism agent was interrupted", "A turn was interrupted."],
};

const notified = new Set<string>();

export function withTurnEndNotifications(client: AgentClient): AgentClient {
  if (!isNative) return client;
  return {
    ...client,
    streamSession(sessionId: string, afterSeq: number, handlers: AgentStreamHandlers) {
      return client.streamSession(sessionId, afterSeq, {
        ...handlers,
        onEvent(msg) {
          handlers.onEvent(msg);
          if (msg.t !== "status" || !TEXT[msg.status] || notified.has(msg.turnId)) return;
          notified.add(msg.turnId);
          const [title, body] = TEXT[msg.status]!;
          void shell()?.notify?.(title, body, sessionId);
        },
      });
    },
  };
}

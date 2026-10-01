/**
 * Agent chat navigation state (WP3.2): which session the Agent tab shows, and a
 * pending "ask" (from the command bar / "Ask about this note") for the tab to
 * start when it mounts. The open session id is remembered per browser so
 * reopening the app lands back in the conversation.
 */
import { create } from "zustand";
import type { ContentType } from "../types";
import { useUIStore } from "../../app/stores/ui";

// Legacy unscoped IDs are deliberately not restored: their account/vault is unknown.
const key = (scope: string) => `prism:agent-session:v2:${scope}`;
function load(scope: string | null): string | null {
  try { return scope ? localStorage.getItem(key(scope)) : null; }
  catch { return null; }
}
function save(scope: string | null, id: string | null) {
  if (!scope) return;
  try {
    if (id) localStorage.setItem(key(scope), id);
    else localStorage.removeItem(key(scope));
  } catch { /* Navigation still works without persistent storage. */ }
}

export interface PendingAsk {
  /** Send this prompt right away (command bar "Ask Claude: …"). Empty = just prefill context. */
  prompt?: string;
  /** Attach the session to this note ("Ask about this note"). */
  noteId?: string;
  noteTitle?: string;
}

interface AgentChatState {
  scope: string | null;
  bindScope: (scope: string | null) => void;
  activeSessionId: string | null;
  pendingAsk: PendingAsk | null;
  setActiveSession: (id: string | null) => void;
  setPendingAsk: (a: PendingAsk | null) => void;
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  scope: null,
  bindScope: (scope) => {
    if (get().scope === scope) return;
    set({ scope, activeSessionId: load(scope), pendingAsk: null });
  },
  activeSessionId: null,
  pendingAsk: null,
  setActiveSession: (id) => {
    save(get().scope, id);
    set({ activeSessionId: id });
  },
  setPendingAsk: (a) => set({ pendingAsk: a }),
}));

/** The Agent chat virtual tab id (Registry + Canvas + Navigation). */
export const AGENT_CHAT_TAB = "agent-chat";

export { isVaultNoteId as isAskableNoteId } from "../noteIdentity";

/** Open the Agent chat tab, optionally on a session or with a pending ask. */
export function openAgentChat(opts: { sessionId?: string | null; ask?: PendingAsk } = {}) {
  const st = useAgentChatStore.getState();
  if (opts.sessionId !== undefined) st.setActiveSession(opts.sessionId);
  if (opts.ask) st.setPendingAsk(opts.ask);
  useUIStore.getState().openTab(AGENT_CHAT_TAB, "Agent chat", AGENT_CHAT_TAB as ContentType);
}

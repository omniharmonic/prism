/**
 * Agent chat navigation state (WP3.2): which session the Agent tab shows, and a
 * pending "ask" (from the command bar / "Ask about this note") for the tab to
 * start when it mounts. The open session id is remembered per browser so
 * reopening the app lands back in the conversation.
 */
import { create } from "zustand";
import type { ContentType } from "../types";
import { useUIStore } from "../../app/stores/ui";

const KEY = "prism:agent-session";

function load(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function save(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export interface PendingAsk {
  /** Send this prompt right away (command bar "Ask Claude: …"). Empty = just prefill context. */
  prompt?: string;
  /** Attach the session to this note ("Ask about this note"). */
  noteId?: string;
  noteTitle?: string;
}

interface AgentChatState {
  activeSessionId: string | null;
  pendingAsk: PendingAsk | null;
  setActiveSession: (id: string | null) => void;
  setPendingAsk: (a: PendingAsk | null) => void;
}

export const useAgentChatStore = create<AgentChatState>((set) => ({
  activeSessionId: load(),
  pendingAsk: null,
  setActiveSession: (id) => {
    save(id);
    set({ activeSessionId: id });
  },
  setPendingAsk: (a) => set({ pendingAsk: a }),
}));

/** The Agent chat virtual tab id (Registry + Canvas + Navigation). */
export const AGENT_CHAT_TAB = "agent-chat";

const VIRTUAL_IDS = new Set(["messages-dashboard", "calendar-dashboard", "vault-messages", "agent-activity", "network", "map", AGENT_CHAT_TAB]);

/** A tab id that is a real vault note (not tag:/matrix:/virtual) — "Ask about this note" applies. */
export function isAskableNoteId(id: string | null | undefined): id is string {
  return !!id && !id.includes(":") && !VIRTUAL_IDS.has(id);
}

/** Open the Agent chat tab, optionally on a session or with a pending ask. */
export function openAgentChat(opts: { sessionId?: string | null; ask?: PendingAsk } = {}) {
  const st = useAgentChatStore.getState();
  if (opts.sessionId !== undefined) st.setActiveSession(opts.sessionId);
  if (opts.ask) st.setPendingAsk(opts.ask);
  useUIStore.getState().openTab(AGENT_CHAT_TAB, "Agent chat", AGENT_CHAT_TAB as ContentType);
}

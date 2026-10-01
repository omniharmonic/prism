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
const draftKey = (scope: string) => `prism:agent-context:v1:${scope}`;
export interface AgentDraftContext { noteId?: string; noteTitle?: string }
function loadDraft(scope: string | null): AgentDraftContext | null {
  try {
    const value = scope ? JSON.parse(localStorage.getItem(draftKey(scope)) ?? "null") : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.noteId !== undefined && typeof value.noteId !== "string") return null;
    return { noteId: value.noteId, noteTitle: typeof value.noteTitle === "string" ? value.noteTitle : undefined };
  } catch { return null; }
}
function saveDraft(scope: string | null, draft: AgentDraftContext | null) {
  if (!scope) return;
  try {
    if (draft) localStorage.setItem(draftKey(scope), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(scope));
  } catch { /* The current window retains the explicit document binding. */ }
}
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
  draft: AgentDraftContext | null;
  setDraft: (draft: AgentDraftContext | null) => void;
  setActiveSession: (id: string | null) => void;
  setPendingAsk: (a: PendingAsk | null) => void;
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  scope: null,
  bindScope: (scope) => {
    if (get().scope === scope) return;
    set({ scope, activeSessionId: load(scope), draft: loadDraft(scope), pendingAsk: null });
  },
  activeSessionId: null,
  pendingAsk: null,
  draft: null,
  setDraft: (draft) => {
    saveDraft(get().scope, draft);
    set({ draft });
  },
  setActiveSession: (id) => {
    save(get().scope, id);
    if (id) saveDraft(get().scope, null);
    set({ activeSessionId: id, ...(id ? { draft: null } : {}) });
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

import { useEffect, useState } from "react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { inferContentType } from "../../lib/schemas/content-types";
import { noteLinkTitle } from "../../lib/wikilinks";
import type { ContentType, TabState } from "../../lib/types";
import { useUIStore } from "../stores/ui";

const LIMIT = 20;
const PREFIX = "prism:workspace-session:v1:";
const VIRTUAL: Record<string, string> = {
  "messages-dashboard": "Inbox", "calendar-dashboard": "Calendar",
  "vault-messages": "Messages", "agent-activity": "Agent",
  network: "Network", map: "Map", "agent-chat": "Agent chat", people: "People",
};
type Panel = ReturnType<typeof useUIStore.getState>["contextPanelTab"];
type Session = { version: 1; ids: string[]; active: string | null; panel: Panel; panelOpen: boolean };
type Restore = { state: "idle" | "loading" | "partial"; retry: () => void; dismiss: () => void };
const IDLE: Restore = { state: "idle", retry: () => {}, dismiss: () => {} };
function eligible(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 2048 &&
    !/[\u0000-\u001f]/.test(id) && (isVaultNoteId(id) || Object.prototype.hasOwnProperty.call(VIRTUAL, id));
}
function key(scope: string) { return PREFIX + encodeURIComponent(scope); }
function read(scope: string): Session | null {
  try {
    const raw = localStorage.getItem(key(scope));
    if (!raw || raw.length > 50_000) return null;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.ids) || value.ids.length > LIMIT) return null;
    return {
      version: 1, ids: [...new Set<string>(value.ids.filter(eligible))],
      active: eligible(value.active) ? value.active : null,
      panel: ["agent", "metadata", "links", "history", "graph"].includes(value.panel) ? value.panel : "metadata",
      panelOpen: value.panelOpen === true,
    };
  } catch { return null; }
}

/** Navigation only. Bodies, titles, drafts and permission decisions never enter this record.
 * The host must supply a confirmed audience matching the reactive auth scope. */
export function useWorkspaceSession(): Restore {
  const client = useVaultClient();
  const [restore, setRestore] = useState<Restore>(IDLE);
  useEffect(() => {
    let disposed = false, generation = 0, ready = false, applying = false;
    let scope: string | null = null;
    let unresolved: string[] = [];
    let desired: Session | null = null;
    let navigationRevision = 0;
    const current = () => !disposed && !!scope &&
      useAgentChatStore.getState().scope === scope && client.scope?.() === scope;
    const save = () => {
      if (!ready || applying || !current()) return;
      const state = useUIStore.getState();
      const active = state.openTabs.find(t => t.id === state.activeTabId)?.noteId ?? null;
      let ids = [...new Set([...state.openTabs.map(t => t.noteId).filter(eligible), ...unresolved])];
      // Keep the active tab even when an unusually large workspace exceeds the bound.
      if (ids.length > LIMIT && active && ids.indexOf(active) >= LIMIT) ids = [active, ...ids.filter(id => id !== active)];
      const record: Session = { version: 1, ids: ids.slice(0, LIMIT), active,
        panel: state.contextPanelTab, panelOpen: state.contextPanelOpen };
      try { localStorage.setItem(key(scope!), JSON.stringify(record)); } catch { /* Navigation works without storage. */ }
    };
    const show = (state: Restore["state"]) => {
      if (!disposed) setRestore({ state, retry: () => { void reopen(true); }, dismiss: () => {
        generation++; unresolved = []; ready = true; show("idle"); save();
      } });
    };
    const reopen = async (retry = false) => {
      if (!current()) return;
      const ticket = ++generation, revision = navigationRevision;
      const requested = retry ? unresolved : desired?.ids ?? [];
      if (!requested.length) { ready = true; show("idle"); save(); return; }
      show("loading");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.all(requested.map(async (id): Promise<TabState | null> => {
          try {
            if (Object.prototype.hasOwnProperty.call(VIRTUAL, id)) return { id: `tab-${id}`, noteId: id, title: VIRTUAL[id], type: id as ContentType, isDirty: false };
            const note = await client.getNote(id, { fresh: true });
            if (!current() || (note.id !== id && !(id.startsWith("offline-") && isVaultNoteId(note.id)))) return null;
            return { id: `tab-${note.id}`, noteId: note.id, title: noteLinkTitle(note), type: inferContentType(note), isDirty: false };
          } catch { return null; }
        })),
        new Promise<Array<TabState | null>>(resolve => { timeout = setTimeout(() => resolve(requested.map(() => null)), 12_000); }),
      ]);
      clearTimeout(timeout);
      if (!current() || ticket !== generation) return;
      // A deep link or deliberate navigation wins over delayed cold-start reads.
      if (!retry && navigationRevision !== revision) {
        ready = true; unresolved = []; show("idle"); save(); return;
      }
      unresolved = requested.filter((_, index) => !results[index]);
      const state = useUIStore.getState();
      const existing = new Set(state.openTabs.map(t => t.noteId));
      const tabs = [...state.openTabs, ...results.filter((tab): tab is TabState => !!tab && !existing.has(tab.noteId))];
      const active = state.activeTabId ?? tabs.find(t => t.noteId === desired?.active)?.id ?? tabs[0]?.id ?? null;
      applying = true;
      useUIStore.setState({ openTabs: tabs, activeTabId: active,
        ...(state.activeTabId ? {} : { navHistory: active ? [active] : [], navIndex: active ? 0 : -1 }),
        ...(!retry && desired ? { contextPanelTab: desired.panel,
          contextPanelOpen: desired.panelOpen && window.matchMedia("(min-width: 768px)").matches } : {}),
      });
      applying = false; ready = true;
      show(unresolved.length ? "partial" : "idle"); save();
    };
    const bind = (next: string | null) => {
      generation++; ready = false; unresolved = []; desired = null;
      // Clear before the new audience can render old tabs. The App vault-change
      // listener separately clears query data; binding null also covers logout.
      if (scope !== null) {
        applying = true;
        useUIStore.getState().closeAllTabs();
        useUIStore.setState({ contextPanelOpen: false, pendingEdit: null, ghostText: null });
        applying = false;
      }
      scope = next && client.scope?.() === next ? next : null;
      show("idle");
      if (!scope) return;
      desired = read(scope);
      // Existing tabs on mount are an explicit host/deep-link selection.
      if (useUIStore.getState().openTabs.length) { ready = true; save(); }
      else void reopen();
    };
    const unsubscribeUI = useUIStore.subscribe((state, previous) => {
      if (applying) return;
      if (state.openTabs !== previous.openTabs || state.activeTabId !== previous.activeTabId) navigationRevision++;
      if (state.openTabs !== previous.openTabs || state.activeTabId !== previous.activeTabId ||
        state.contextPanelOpen !== previous.contextPanelOpen || state.contextPanelTab !== previous.contextPanelTab) save();
    });
    const unsubscribeScope = useAgentChatStore.subscribe((state, previous) => {
      if (state.scope !== previous.scope) bind(state.scope);
    });
    bind(useAgentChatStore.getState().scope);
    return () => { save(); disposed = true; generation++; unsubscribeUI(); unsubscribeScope(); };
  }, [client]);
  return restore;
}

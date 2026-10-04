import { isVaultNoteId } from "../../lib/noteIdentity";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OpenDocuments } from "./OpenDocuments";
import {
  X,
  PanelLeft,
  PanelRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  Star,
} from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { ShareButton } from "./ShareButton";
import { PageActionsButton } from "../pages/PageActionsMenu";
import { SyncStateBadge } from "./SyncStateBadge";
import { QueryClientContext } from "@tanstack/react-query";
import { agentKeys, useAgentClient } from "../../data/AgentClientContext";
import type { AgentSessionSummary } from "../../lib/agent/sessions";
import { PageIcon } from "../../lib/pages/icons";
import type { Editor } from "@tiptap/react";
import { useDocumentSnapshots } from "../../lib/agent/documentSnapshots";
import { useSelectionAsk } from "../../lib/agent/useSelectionAsk";

/**
 * NP-AI-01: the header Agent button opens the SAME document-bound conversation with
 * the page's current selection attached — exactly what the selection toolbar, the
 * block menu, slash and ⌘J do (`useSelectionAsk().ask("selection")`). This renders
 * nothing; it hands the button a function that attaches the selection when there is
 * one (false = nothing selected / not possible → the button just opens the panel).
 * Mounted only for a page that is open in an editor, inside a query client.
 */
function HeaderSelectionAsk({ editor, register }: { editor: Editor; register: (attach: (() => boolean) | null) => void }) {
  const action = useSelectionAsk(editor);
  useEffect(() => {
    register(() => action.selected && action.canAsk && action.ask("selection"));
    return () => register(null);
  });
  return null;
}

/** True while a cached agent session has a queued/running turn. Reads the
 *  cache only (AgentChat/AgentActivity own the polling) — never adds a request. */
function useAgentActive(): boolean {
  const client = useAgentClient();
  const queries = useContext(QueryClientContext); // optional: fixtures may mount TabBar without one
  const key = agentKeys(client).list(false);
  const read = () => !!(queries?.getQueryData<AgentSessionSummary[]>(key) ?? []).some((s) => s.lastTurnStatus === "running" || s.lastTurnStatus === "queued");
  return useSyncExternalStore((notify) => queries ? queries.getQueryCache().subscribe(notify) : () => {}, read, () => false);
}

/** A square, quiet icon button for the top bar (rounded hover via .interactive). */
function IconButton({
  onClick,
  title,
  active,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : (event) => { event.currentTarget.focus({ preventScroll: true }); onClick(); }}
      title={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      className="interactive focus-ring flex items-center justify-center flex-shrink-0"
      style={{
        width: 30,
        height: 30,
        color: active ? "var(--text-secondary)" : "var(--text-muted)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function TabBar() {
  const {
    openTabs,
    activeTabId,
    setActiveTab,
    closeTab,
    reorderTabs,
    navHistory,
    navIndex,
    navBack,
    navForward,
    sidebarOpen,
    toggleSidebar,
    contextPanelOpen,
    toggleContextPanel,
    setContextPanelTab,
  } = useUIStore();

  // Drag-to-reorder state: the tab being dragged + the tab it's hovering over.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Back/forward enabled only when a still-open tab exists in that direction.
  const tabIds = new Set(openTabs.map((t) => t.id));
  const canBack = navHistory
    .slice(0, Math.max(0, navIndex))
    .some((id) => tabIds.has(id));
  const canForward = navHistory
    .slice(navIndex + 1)
    .some((id) => tabIds.has(id));

  // Favorite (pin) the active note.
  const { favoriteIds, toggleFavorite } = useNoteShortcuts();
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isRealNote = isVaultNoteId(activeTab?.noteId);
  const isFav = isRealNote && favoriteIds.includes(activeTab!.noteId);

  const isMobile = useIsMobile();
  const agentActive = useAgentActive();
  const agentClient = useAgentClient();
  const queries = useContext(QueryClientContext);
  const activeNoteForAgent = useUIStore((st) => st.openTabs.find((t) => t.id === st.activeTabId)?.noteId ?? null);
  const activeEditor = useDocumentSnapshots((st) => (activeNoteForAgent ? st.notes[activeNoteForAgent]?.editor ?? null : null));
  const attachSelection = useRef<(() => boolean) | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (isMobile) return;
    // Change only the horizontal tab-strip scroll; never scroll the document or focus it.
    const node = strip.current;
    const active = node?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!node || !active) return;
    const tab = active.parentElement!;
    const reveal = () => {
      const parent = node.getBoundingClientRect();
      const child = tab.getBoundingClientRect();
      if (child.left < parent.left) node.scrollLeft -= parent.left - child.left;
      else if (child.right > parent.right) node.scrollLeft += child.right - parent.right;
    };
    reveal();
    // Fonts, companion widths and responsive chrome can settle after activation.
    const observer = new ResizeObserver(reveal);
    observer.observe(node);
    observer.observe(tab);
    return () => observer.disconnect();
  }, [activeTabId, openTabs, isMobile]);

  // Mobile: a quiet 3-zone header (nav · centered title · share). Tab switching,
  // creation, sidebar, and note actions all live in the floating command pill,
  // so the top bar stays a single uncluttered line.
  if (isMobile) {
    return (
      <div
        className="flex items-center gap-1"
        style={{
          height: 46,
          borderBottom: "1px solid var(--glass-border)",
          background: "var(--bg-surface)",
          padding: "0 6px",
        }}
      >
        <IconButton onClick={navBack} title="Back" disabled={!canBack}>
          <ChevronLeft size={20} />
        </IconButton>
        <IconButton onClick={navForward} title="Forward" disabled={!canForward}>
          <ChevronRight size={20} />
        </IconButton>

        <div className="flex-1 min-w-0 flex items-center justify-center px-1">
          <span
            className="truncate text-center"
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 550,
              color: "var(--text-primary)",
              maxWidth: "100%",
            }}
          >
            {activeTab?.title ?? "Prism"}
          </span>
        </div>
        {isRealNote && <SyncStateBadge key="sync" variant="phone" />}

        {isRealNote && (
          <IconButton
            onClick={() =>
              toggleFavorite({
                id: activeTab!.noteId,
                title: activeTab!.title,
                type: activeTab!.type,
              })
            }
            title={isFav ? "Remove from Favorites" : "Add to Favorites"}
            active={isFav}
          >
            <Star
              size={18}
              fill={isFav ? "var(--color-accent)" : "none"}
              color={isFav ? "var(--color-accent)" : undefined}
            />
          </IconButton>
        )}
        <ShareButton key="share" />
        {isRealNote && <PageActionsButton key="page-actions" page={{ id: activeTab!.noteId, path: null, title: activeTab!.title }} size={18} />}
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1"
      style={{
        height: "var(--tab-bar-height)",
        borderBottom: "1px solid var(--glass-border)",
        background: "var(--bg-surface)",
        padding: "0 8px",
      }}
    >
      {/* Sidebar toggle */}
      <IconButton
        onClick={toggleSidebar}
        title="Toggle sidebar (⌘\)"
        active={sidebarOpen}
      >
        <PanelLeft size={16} />
      </IconButton>

      {/* Back / forward through visited notes */}
      <IconButton onClick={navBack} title="Back" disabled={!canBack}>
        <ChevronLeft size={17} />
      </IconButton>
      <IconButton onClick={navForward} title="Forward" disabled={!canForward}>
        <ChevronRight size={17} />
      </IconButton>

      {/* Tabs */}
      <div
        ref={strip}
        role="navigation"
        aria-label="Open document tabs"
        className="flex-1 flex items-center gap-1 overflow-x-auto min-w-0"
        style={{ paddingLeft: 2 }}
      >
        {openTabs.map((tab) => {
          const active = activeTabId === tab.id;
          const isOver =
            overId === tab.id && dragId !== null && dragId !== tab.id;
          const isDragging = dragId === tab.id;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.noteId}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = "move";
                // Some browsers require data to be set for a drag to begin.
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overId !== tab.id) setOverId(tab.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== tab.id) reorderTabs(dragId, tab.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              className="interactive group flex items-center gap-1.5 flex-shrink-0"
              style={{
                height: 28,
                padding: "0 6px 0 10px",
                fontSize: "var(--text-sm)",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: active ? 550 : 400,
                background: active ? "var(--surface-active)" : undefined,
                opacity: isDragging ? 0.4 : 1,
                // Accent insertion marker on the side the dragged tab will land.
                boxShadow: isOver
                  ? "inset 2px 0 0 0 var(--color-accent)"
                  : undefined,
                cursor: "grab",
              }}
            >
              {tab.isDirty && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--color-accent)",
                    flexShrink: 0,
                  }}
                />
              )}
              <PageIcon noteId={tab.noteId} />
              <button
                aria-label={`Open ${tab.title}`}
                aria-current={active ? "page" : undefined}
                className="focus-ring truncate text-left"
                style={{ maxWidth: 160, height: 28 }}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  if (
                    !event.altKey ||
                    !event.shiftKey ||
                    !["ArrowLeft", "ArrowRight"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  const index = openTabs.findIndex(
                    (item) => item.id === tab.id,
                  );
                  const target =
                    openTabs[index + (event.key === "ArrowLeft" ? -1 : 1)];
                  if (!target) return;
                  reorderTabs(tab.id, target.id);
                  setAnnouncement(
                    `${tab.title} moved ${event.key === "ArrowLeft" ? "earlier" : "later"}.`,
                  );
                }}
              >
                {tab.title}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                  requestAnimationFrame(() => {
                    const next =
                      strip.current?.querySelector<HTMLButtonElement>(
                        'button[aria-current="page"]',
                      ) ??
                      strip.current?.parentElement?.querySelector<HTMLButtonElement>(
                        'button[title="Open documents"]',
                      );
                    next?.focus({ preventScroll: true });
                  });
                }}
                title="Close tab"
                aria-label={`Close ${tab.title}`}
                className="interactive focus-ring flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                style={{ width: 18, height: 18, color: "var(--text-muted)" }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <OpenDocuments />
      <span className="sr-only" role="status">
        {announcement}
      </span>

      {/* Right actions: one quiet row — save state, favorite, Share, ⋯, Agent (NP-PG-06). */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isRealNote && <SyncStateBadge key="sync" variant="header" />}
        {isRealNote && (
          <IconButton
            onClick={() =>
              toggleFavorite({
                id: activeTab!.noteId,
                title: activeTab!.title,
                type: activeTab!.type,
              })
            }
            title={isFav ? "Remove from Favorites" : "Add to Favorites"}
            active={isFav}
          >
            <Star
              size={16}
              fill={isFav ? "var(--color-accent)" : "none"}
              color={isFav ? "var(--color-accent)" : undefined}
            />
          </IconButton>
        )}
      </div>
      {/* Keep sharing at the same keyed parent on desktop and mobile. */}
      <ShareButton key="share" />
      {isRealNote && <PageActionsButton key="page-actions" page={{ id: activeTab!.noteId, path: null, title: activeTab!.title }} />}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {queries && agentClient && activeEditor && !activeEditor.isDestroyed && (
          <HeaderSelectionAsk key="agent-selection" editor={activeEditor} register={(attach) => { attachSelection.current = attach; }} />
        )}
        {/* Labelled Agent button with an activity dot while a turn runs. */}
        <button
          type="button"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            // With text selected in the page, the selection rides along (unsent, like
            // every other "Ask agent" entry); otherwise the panel opens on the page.
            attachSelection.current?.();
            setContextPanelTab("agent");
            if (!useUIStore.getState().contextPanelOpen) toggleContextPanel();
          }}
          title="AI Agent"
          aria-label={agentActive ? "AI Agent (working)" : "AI Agent"}
          className="tabbar-labelled interactive focus-ring"
        >
          <Bot size={15} aria-hidden />
          <span>Agent</span>
          {agentActive && <span className="tabbar-activity-dot" aria-hidden />}
        </button>
        {/* Panel toggle = opens Metadata by default */}
        <IconButton
          onClick={() => {
            if (!contextPanelOpen) setContextPanelTab("metadata");
            toggleContextPanel();
          }}
          title="Info panel (⌘⇧\)"
          active={contextPanelOpen}
        >
          <PanelRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}

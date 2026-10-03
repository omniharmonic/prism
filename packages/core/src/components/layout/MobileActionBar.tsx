import { isVaultNoteId } from "../../lib/noteIdentity";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ContentType } from "../../lib/types";
import "../ui/mobile-workspace.css";
import {
  PanelLeft,
  Search,
  MessageSquare,
  Copy,
  MoreHorizontal,
  Info,
  Bot,
  Star,
  Network,
  Settings as SettingsIcon,
  X,
  FilePlus,
  History,
  Sparkles,
} from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useNoteShortcuts } from "../navigation/NoteShortcuts";
import { BottomSheet, type SheetItem } from "../ui/BottomSheet";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { InboxNavButton } from "../inbox/InboxNavButton";
import { useUnreadCount } from "../../lib/notifications/hooks";
import { Settings } from "./Settings";
import { FontSwitch } from "../renderers/DocumentChrome";
import { useAgentAvailable } from "../../data/AgentClientContext";
import { openAgentChat, isAskableNoteId } from "../../lib/agent/chatStore";

/** Mobile destinations reuse the existing workspace routes and drawers. */
export function MobileActionBar() {
  const {
    openTabs,
    activeTabId,
    setActiveTab,
    closeTab,
    toggleSidebar,
    sidebarOpen,
    contextPanelTab,
    openTab,
    openCommandBar,
    contextPanelOpen,
    toggleContextPanel,
    setContextPanelTab,
    setGraphFullscreen,
  } = useUIStore();

  const { favoriteIds, toggleFavorite } = useNoteShortcuts();
  const docFont = useUIStore((s) => s.docFont);
  const docFontSetter = useUIStore((s) => s.docFontSetter);

  const moreButton = useRef<HTMLButtonElement>(null);
  const keyboardEditing = useKeyboardEditing();
  const [newOpen, setNewOpen] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  // Server agent sessions (WP3.2): full-screen chat instead of the side panel.
  const agentChat = useAgentAvailable();

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isRealNote = isVaultNoteId(activeTab?.noteId);
  const isFav = isRealNote && favoriteIds.includes(activeTab!.noteId);

  const openPanel = (tab: "metadata" | "agent" | "history") => {
    setContextPanelTab(tab);
    if (!contextPanelOpen) toggleContextPanel();
    setMoreOpen(false);
  };

  const openMessages = () => {
    setMoreOpen(false);
    useUIStore.setState({ sidebarOpen: false, contextPanelOpen: false });
    openTab("vault-messages", "Messages", "vault-messages" as ContentType);
  };
  const inbox = useUnreadCount();
  const moreItems: SheetItem[] = [
    ...(inbox.available ? [{ icon: <MessageSquare size={19} />, label: "Messages", onClick: openMessages }] : []),
    {
      icon: <FilePlus size={19} />,
      label: "New page",
      onClick: () => {
        setMoreOpen(false);
        setNewOpen(true);
      },
    },
    {
      icon: <Copy size={19} />,
      label: "Open documents",
      detail: String(openTabs.length),
      onClick: () => {
        setMoreOpen(false);
        setTabsOpen(true);
      },
    },
    {
      icon: <Info size={19} />,
      label: "Details & metadata",
      startsGroup: true,
      onClick: () => openPanel("metadata"),
    },
    ...(agentChat
      ? [
          ...(isAskableNoteId(activeTab?.noteId)
            ? [
                {
                  icon: <Sparkles size={19} />,
                  label: "Ask about this note",
                  onClick: () => {
                    setMoreOpen(false);
                    openAgentChat({ ask: { noteId: activeTab!.noteId, noteTitle: activeTab!.title } });
                  },
                } as SheetItem,
              ]
            : []),
          {
            icon: <Bot size={19} />,
            label: "Agent chat",
            onClick: () => {
              setMoreOpen(false);
              openAgentChat();
            },
          } as SheetItem,
        ]
      : [
          {
            icon: <Bot size={19} />,
            label: "Ask the agent",
            onClick: () => openPanel("agent"),
          } as SheetItem,
        ]),
    ...(isRealNote
      ? [
          {
            icon: <History size={19} />,
            label: "Version history",
            onClick: () => openPanel("history"),
          } as SheetItem,
        ]
      : []),
    {
      icon: <Network size={19} />,
      label: "Open graph view",
      onClick: () => {
        setGraphFullscreen(true);
        setMoreOpen(false);
      },
    },
    ...(isRealNote
      ? [
          {
            icon: <Star size={19} fill={isFav ? "var(--color-accent)" : "none"} />,
            label: isFav ? "Remove from favorites" : "Add to favorites",
            active: isFav,
            onClick: () => {
              toggleFavorite({ id: activeTab!.noteId, title: activeTab!.title, type: activeTab!.type });
              setMoreOpen(false);
            },
          } as SheetItem,
        ]
      : []),
    {
      icon: <SettingsIcon size={19} />,
      label: "Settings",
      startsGroup: true,
      onClick: () => {
        setMoreOpen(false);
        setSettingsOpen(true);
      },
    },
  ];

  return (
    <>
      <nav aria-label="Mobile workspace" className="prism-mobile-navigation" hidden={keyboardEditing}>
        <MobileButton label="Notes" active={sidebarOpen} onClick={toggleSidebar}>
          <PanelLeft size={20} />
        </MobileButton>
        {/* Inbox (wave 2A) takes the Messages slot wherever the server has a
            notifications inbox; Messages then lives in More. Shells without one
            (legacy desktop) keep Messages here. */}
        <InboxNavButton>
          {({ icon, label, onClick, available }) => available ? (
            <MobileButton label={label} text="Inbox" active={activeTab?.noteId === "notifications"}
              onClick={() => { useUIStore.setState({ sidebarOpen: false, contextPanelOpen: false }); onClick(); }}>
              {icon}
            </MobileButton>
          ) : (
            <MobileButton label="Messages" active={activeTab?.noteId === "vault-messages"} onClick={openMessages}>
              <MessageSquare size={20} />
            </MobileButton>
          )}
        </InboxNavButton>
        <MobileButton label="Search" onClick={openCommandBar}>
          <Search size={20} />
        </MobileButton>
        <MobileButton
          label="Agent"
          active={contextPanelOpen && contextPanelTab === "agent"}
          onClick={() => openPanel("agent")}
        >
          <Bot size={20} />
        </MobileButton>
        <MobileButton
          buttonRef={moreButton}
          label="More"
          active={moreOpen || tabsOpen || newOpen || settingsOpen}
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal size={20} />
        </MobileButton>
      </nav>

      {/* Existing title-first creation, all formats and email compose remain available. */}
      {newOpen && <NewContentMenu returnFocus={moreButton.current} onClose={() => setNewOpen(false)} />}

      {/* Tab switcher */}
      <BottomSheet
        open={tabsOpen}
        onClose={() => setTabsOpen(false)}
        title={`Open documents · ${openTabs.length}`}
        returnFocusRef={moreButton}
      >
        <div className="pb-1">
          {openTabs.length === 0 && (
            <div className="px-5 py-6 text-sm text-center" style={{ color: "var(--text-muted)" }}>
              No open tabs
            </div>
          )}
          {openTabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div key={tab.id} className="prism-mobile-document-row" data-active={active}>
                <button
                  type="button"
                  className="prism-mobile-document-open"
                  aria-label={`Open ${tab.title}${tab.isDirty ? ", unsaved changes" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setTabsOpen(false);
                  }}
                >
                  {tab.isDirty && <span className="prism-mobile-document-dirty" aria-hidden="true" />}
                  <span className="prism-mobile-document-title">{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="prism-mobile-document-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
          <button
            onClick={() => {
              setTabsOpen(false);
              setNewOpen(true);
            }}
            type="button"
            className="prism-mobile-new-page"
          >
            <span className="flex items-center justify-center flex-shrink-0" style={{ width: 22 }}>
              <FilePlus size={19} />
            </span>
            New page
          </button>
        </div>
      </BottomSheet>

      {/* Note / context actions */}
      <BottomSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title={activeTab?.title || "Page actions"}
        returnFocusRef={moreButton}
        header={
          docFontSetter ? (
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Reading font
              </span>
              <FontSwitch value={docFont} onChange={docFontSetter} />
            </div>
          ) : undefined
        }
        items={moreItems}
      />

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function MobileButton({
  label,
  text,
  onClick,
  active = false,
  children,
  buttonRef,
}: {
  label: string;
  /** Visible caption when it differs from the accessible name (e.g. "Inbox, 3 unread"). */
  text?: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onClick();
      }}
    >
      {children}
      <span>{text ?? label}</span>
    </button>
  );
}

/** Let a software-keyboard composition own the bottom edge. Pinch zoom alone
 * never hides navigation, and neither the editor nor its reserved inset changes. */
function useKeyboardEditing() {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const element = document.activeElement as HTMLElement | null;
      const input = !!element?.closest('textarea,input,[contenteditable="true"]');
      setEditing(
        input && Math.abs(vv.scale - 1) < 0.05 && window.innerHeight - vv.height - vv.offsetTop > 120,
      );
    };
    const focus = () => queueMicrotask(update);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
    };
  }, []);
  return editing;
}

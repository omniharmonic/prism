import { useState } from "react";
import {
  PanelLeft,
  Search,
  Plus,
  Copy,
  MoreHorizontal,
  Info,
  Bot,
  Star,
  Network,
  Settings as SettingsIcon,
  X,
  FilePlus,
} from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useSettingsStore } from "../../app/stores/settings";
import { BottomSheet, type SheetItem } from "../ui/BottomSheet";
import { NewContentMenu } from "../navigation/NewContentMenu";
import { Settings } from "./Settings";
import { FontSwitch } from "../renderers/DocumentChrome";

/**
 * The floating glass command pill — the mobile signature. One frosted row of the
 * highest-frequency actions, docked in the thumb zone with content scrolling
 * beneath it. Depth (tabs, note actions, creation, settings) lives in bottom
 * sheets rather than a wrapped toolbar, so the bar itself is always one line.
 */
export function MobileActionBar() {
  const {
    openTabs,
    activeTabId,
    setActiveTab,
    closeTab,
    toggleSidebar,
    openCommandBar,
    contextPanelOpen,
    toggleContextPanel,
    setContextPanelTab,
    setGraphFullscreen,
  } = useUIStore();

  const favorites = useSettingsStore((s) => s.favorites);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const docFont = useUIStore((s) => s.docFont);
  const docFontSetter = useUIStore((s) => s.docFontSetter);

  const [newOpen, setNewOpen] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isRealNote = !!activeTab && !activeTab.noteId.includes(":");
  const isFav = isRealNote && favorites.some((f) => f.id === activeTab!.noteId);

  const openPanel = (tab: "metadata" | "agent") => {
    setContextPanelTab(tab);
    if (!contextPanelOpen) toggleContextPanel();
    setMoreOpen(false);
  };

  const moreItems: SheetItem[] = [
    {
      icon: <Info size={19} />,
      label: "Details & metadata",
      onClick: () => openPanel("metadata"),
    },
    {
      icon: <Bot size={19} />,
      label: "Ask the agent",
      onClick: () => openPanel("agent"),
    },
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
      <div
        className="absolute left-0 right-0 flex justify-center pointer-events-none"
        style={{ bottom: 12, zIndex: "var(--z-sticky)" as unknown as number }}
      >
        <div className="command-pill pointer-events-auto flex items-center gap-0.5 px-1.5 py-1.5">
          <PillButton label="Files" onClick={toggleSidebar}>
            <PanelLeft size={20} />
          </PillButton>
          <PillButton label="Search" onClick={openCommandBar}>
            <Search size={20} />
          </PillButton>

          {/* Primary: new note */}
          <button
            onClick={() => setNewOpen(true)}
            aria-label="Create new"
            className="press focus-ring flex items-center justify-center flex-shrink-0 mx-0.5"
            style={{
              width: 46,
              height: 38,
              borderRadius: 999,
              background: "var(--color-accent)",
              color: "#fff",
              boxShadow: "0 2px 8px color-mix(in srgb, var(--color-accent) 45%, transparent)",
            }}
          >
            <Plus size={22} />
          </button>

          <PillButton label="Tabs" onClick={() => setTabsOpen(true)} badge={openTabs.length || undefined}>
            <Copy size={19} />
          </PillButton>
          <PillButton label="More" onClick={() => setMoreOpen(true)}>
            <MoreHorizontal size={20} />
          </PillButton>
        </div>
      </div>

      {/* New content — reuses the full create flow (type → path, tasks, compose) */}
      {newOpen && <NewContentMenu onClose={() => setNewOpen(false)} />}

      {/* Tab switcher */}
      <BottomSheet open={tabsOpen} onClose={() => setTabsOpen(false)} title={`${openTabs.length} open ${openTabs.length === 1 ? "tab" : "tabs"}`}>
        <div className="pb-1">
          {openTabs.length === 0 && (
            <div className="px-5 py-6 text-sm text-center" style={{ color: "var(--text-muted)" }}>
              No open tabs
            </div>
          )}
          {openTabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="interactive flex items-center gap-3 px-5"
                style={{
                  minHeight: 50,
                  background: active ? "var(--surface-selected)" : undefined,
                }}
                onClick={() => {
                  setActiveTab(tab.id);
                  setTabsOpen(false);
                }}
              >
                {tab.isDirty && (
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--color-accent)", flexShrink: 0 }} />
                )}
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: active ? 550 : 440 }}
                >
                  {tab.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label="Close tab"
                  className="interactive flex items-center justify-center flex-shrink-0"
                  style={{ width: 30, height: 30, color: "var(--text-muted)" }}
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
            className="interactive w-full flex items-center gap-3.5 px-5"
            style={{ minHeight: 50, color: "var(--color-accent)", borderTop: "1px solid var(--glass-border)", marginTop: 4, fontWeight: 500 }}
          >
            <span className="flex items-center justify-center flex-shrink-0" style={{ width: 22 }}>
              <FilePlus size={19} />
            </span>
            New note
          </button>
        </div>
      </BottomSheet>

      {/* Note / context actions */}
      <BottomSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title={activeTab?.title}
        header={
          docFontSetter ? (
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Reading font</span>
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

function PillButton({
  label,
  onClick,
  badge,
  children,
}: {
  label: string;
  onClick: () => void;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="press interactive focus-ring relative flex items-center justify-center flex-shrink-0"
      style={{ width: 44, height: 38, borderRadius: 999, color: "var(--text-secondary)" }}
    >
      {children}
      {badge !== undefined && (
        <span
          className="absolute flex items-center justify-center"
          style={{
            top: 2,
            right: 2,
            minWidth: 15,
            height: 15,
            padding: "0 4px",
            borderRadius: 999,
            fontSize: 9.5,
            fontWeight: 700,
            background: "var(--color-accent)",
            color: "#fff",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

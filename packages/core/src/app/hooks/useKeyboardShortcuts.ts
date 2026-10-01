import { useEffect } from "react";
import { useUIStore } from "../stores/ui";

export function useKeyboardShortcuts() {
  const { toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab } = useUIStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      switch (e.key) {
        case "w":
          // Close active tab instead of closing the window
          e.preventDefault();
          if (activeTabId) closeTab(activeTabId);
          break;
        case "b":
          // The document editor owns Cmd/Ctrl+B for rich-text bold.
          if ((e.target as HTMLElement | null)?.closest('[contenteditable="true"], input, textarea')) return;
          e.preventDefault();
          toggleSidebar();
          break;
        case "\\":
          e.preventDefault();
          toggleContextPanel();
          break;
        case "k":
          e.preventDefault();
          openCommandBar();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab]);
}

import { usePagesUI } from "../../lib/pages/store";
import { useEffect } from "react";
import { useUIStore } from "../stores/ui";

export function useKeyboardShortcuts() {
  const { toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab } = useUIStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.defaultPrevented) return;
      // A modal owns the current interaction. Do not change the underlying
      // document or open a second workspace overlay behind its inert boundary.
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
        if (["w", "b", "\\", "k"].includes(e.key)) e.preventDefault();
        return;
      }

      // ⌘\ = sidebar, ⌘⇧\ = info panel (NP-SB-11). By physical key: Shift turns "\" into "|".
      if (e.code === "Backslash" || e.key === "\\") {
        if (e.altKey) return;
        e.preventDefault();
        if (e.shiftKey) toggleContextPanel();
        else toggleSidebar();
        return;
      }
      // ⌘[ / ⌘] walk the visited pages (NP-SR-07). An editor that uses the keys
      // itself (code indent) has already claimed the event (defaultPrevented above).
      if ((e.key === "[" || e.key === "]") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (e.key === "[") useUIStore.getState().navBack();
        else useUIStore.getState().navForward();
        return;
      }

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
        case "k":
          e.preventDefault();
          openCommandBar();
          break;
        case "n":
          // ⌘N / Ctrl+N: a new "Untitled" page (NP-SB-13). Browsers keep this
          // combination for a new window, so it only arrives in the native app.
          if (e.shiftKey || e.altKey) return;
          e.preventDefault();
          usePagesUI.getState().openCreate({});
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab]);
}

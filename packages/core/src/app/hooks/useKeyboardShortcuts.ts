import { usePagesUI } from "../../lib/pages/store";
import { useEffect } from "react";
import { useUIStore } from "../stores/ui";
import { toggleTheme } from "../stores/settings";

/**
 * App-level bindings. THE table is `lib/shortcuts.ts` (`APP_SHORTCUTS`) — the
 * shortcut sheet and the command palette hints read it; a key bound here must
 * match its entry there (pinned by notion-sidebar.spec "the shortcut sheet's
 * shell rows are the working bindings"). ⌘B is Bold only: it is NOT bound here.
 */
export function useKeyboardShortcuts() {
  const { toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab } = useUIStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.defaultPrevented) return;
      // A modal owns the current interaction. Do not change the underlying
      // document or open a second workspace overlay behind its inert boundary.
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
        if (["w", "\\", "k"].includes(e.key)) e.preventDefault();
        return;
      }

      // ⌘\ = sidebar, ⌘⇧\ = info panel (NP-SB-11). By physical key: Shift turns "\" into "|".
      // Matched by character as well as by physical key: on ISO layouts "\" is not on
      // the ANSI Backslash key (IntlBackslash, or a different key altogether).
      if (e.code === "Backslash" || e.code === "IntlBackslash" || e.key === "\\" || (e.shiftKey && e.key === "|")) {
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

      // ⌘⇧L toggles the theme, ⌘, opens Settings (NP-SR-06: the palette shows the same hints).
      if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useUIStore.getState().setSettingsOpen(true);
        return;
      }

      switch (e.key) {
        case "w":
          // Close active tab instead of closing the window
          e.preventDefault();
          if (activeTabId) closeTab(activeTabId);
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

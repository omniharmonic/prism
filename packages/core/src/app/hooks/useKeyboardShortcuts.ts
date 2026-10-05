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
const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** A dialog owns the interaction: nothing is created or toggled behind it. */
const modalOpen = () => !!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');

/**
 * The native shell's File → New Page (⌘N): a payload-free `prism:new-page` window
 * event (apps/client/src-tauri/src/menu.rs). Same one-action create as the sidebar
 * button and the key itself; `openCreate({})` while a create is in flight is the
 * same request, so a menu item and a keydown for ONE key press make one page.
 */
export const NEW_PAGE_EVENT = "prism:new-page";

export function useKeyboardShortcuts() {
  const { toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab } = useUIStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.defaultPrevented) return;
      // A modal owns the current interaction. Do not change the underlying
      // document or open a second workspace overlay behind its inert boundary.
      if (modalOpen()) {
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
          // combination for a new window, so it only arrives in the native app
          // (where File → New Page carries it too: NEW_PAGE_EVENT below).
          if (e.shiftKey || e.altKey) return;
          // On Apple platforms the binding is ⌘N only: Ctrl+N is "next line" in every text field.
          if (isApple && !e.metaKey) return;
          e.preventDefault();
          usePagesUI.getState().openCreate({});
          break;
      }
    };

    const newPage = () => {
      if (modalOpen()) return;
      usePagesUI.getState().openCreate({});
    };
    window.addEventListener("keydown", handler);
    window.addEventListener(NEW_PAGE_EVENT, newPage);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener(NEW_PAGE_EVENT, newPage);
    };
  }, [toggleSidebar, toggleContextPanel, openCommandBar, activeTabId, closeTab]);
}

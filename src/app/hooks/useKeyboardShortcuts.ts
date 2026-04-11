import { useEffect } from "react";
import { useUIStore } from "../stores/ui";

export function useKeyboardShortcuts() {
  const { toggleSidebar, toggleContextPanel, openCommandBar } = useUIStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      switch (e.key) {
        case "b":
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
  }, [toggleSidebar, toggleContextPanel, openCommandBar]);
}

/**
 * THE table of app-level keyboard shortcuts shown in the shortcut sheet
 * (components/renderers/ShortcutSheet.tsx). TipTap key specs: "Mod" = ⌘ on Apple
 * platforms, Ctrl elsewhere.
 *
 * One place on purpose: when a binding moves (the shell rebinds the sidebar to
 * ⌘\ and the side panel to ⌘⇧\ — `app/hooks/useKeyboardShortcuts.ts`), change
 * it HERE and in the handler; the sheet follows. No key may appear twice with
 * two meanings (⌘B is Bold; ⌘/ is this sheet, the block menu is ⌘⇧/).
 */
export const APP_SHORTCUTS = {
  quickFind: "Mod-K",
  toggleSidebar: "Mod-\\",
  toggleSidePanel: "Mod-Shift-\\",
  navBack: "Mod-[",
  navForward: "Mod-]",
  settings: "Mod-,",
  toggleTheme: "Mod-Shift-L",
  closeTab: "Mod-W",
  newPage: "Mod-N",
  save: "Mod-S",
  askAgent: "Mod-J",
  shortcutSheet: "Mod-/",
  blockMenu: "Mod-Shift-/",
  find: "Mod-F",
  replace: "Mod-Alt-F",
} as const;
export type AppShortcut = keyof typeof APP_SHORTCUTS;

/**
 * A table entry in the command palette's hint form (`lib/shortcutHints.ts`):
 * "Mod-Shift-\\" → ["mod", "shift", "\\"]. The palette, the sheet and the handler
 * all read the SAME entry.
 */
export function shortcutKeys(name: AppShortcut): string[] {
  const parts = APP_SHORTCUTS[name].split("-").map((p) => (p === "" ? "-" : p));
  return parts.map((p) => (p === "Mod" || p === "Shift" || p === "Alt" ? p.toLowerCase() : p));
}

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
 * Bindings only a NATIVE shell can take. A browser tab never sees ⌘N / Ctrl+N
 * (the browser opens a window), so the web app must not advertise it: in the
 * Prism Client the key arrives through the File → New Page menu item (and, where
 * the webview gets the key itself, through `useKeyboardShortcuts`).
 */
export const NATIVE_ONLY_SHORTCUTS: ReadonlySet<AppShortcut> = new Set<AppShortcut>(["newPage"]);

/** A Tauri shell: the Prism Client (host hook) or the legacy desktop. */
export function inNativeShell(): boolean {
  return typeof window !== "undefined" && ("__PRISM_HOST__" in window || "__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Does this binding work where the app is running? The sheet and the palette list only those that do. */
export function shortcutAvailable(name: AppShortcut): boolean {
  return !NATIVE_ONLY_SHORTCUTS.has(name) || inNativeShell();
}

/**
 * A table entry in the command palette's hint form (`lib/shortcutHints.ts`):
 * "Mod-Shift-\\" → ["mod", "shift", "\\"]. The palette, the sheet and the handler
 * all read the SAME entry.
 * `undefined` where the binding does not work (a native-only key in a browser): no hint is shown.
 */
export function shortcutKeys(name: AppShortcut): string[] | undefined {
  if (!shortcutAvailable(name)) return undefined;
  const parts = APP_SHORTCUTS[name].split("-").map((p) => (p === "" ? "-" : p));
  return parts.map((p) => (p === "Mod" || p === "Shift" || p === "Alt" ? p.toLowerCase() : p));
}

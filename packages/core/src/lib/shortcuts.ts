/**
 * THE table of app-level keyboard shortcuts shown in the shortcut sheet
 * (components/renderers/ShortcutSheet.tsx). TipTap key specs: "Mod" = ⌘ on Apple
 * platforms, Ctrl elsewhere.
 *
 * One place on purpose: when a binding moves (the shell rebinds the sidebar to
 * ⌘\ and the side panel to ⌘⇧\ — `app/hooks/useKeyboardShortcuts.ts`), change
 * it HERE and in the handler; the sheet follows. No key may appear twice with
 * two meanings. Two keys are contextual, and the sheet names the context in the
 * row instead of listing the key twice: ⌘K (link with text selected, quick find
 * without) and ⌘/ (the block menu with the caret in a block — as in Notion —,
 * the shortcut sheet outside one; the sheet's own keys are ⌘⇧/ and a bare `?`).
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
  shortcutSheet: "Mod-Shift-/",
  blockMenu: "Mod-/",
  find: "Mod-F",
  replace: "Mod-Alt-F",
} as const;
export type AppShortcut = keyof typeof APP_SHORTCUTS;

/**
 * Bindings whose FEATURE lands from another branch. Data only: nothing handles these
 * keys here, so the sheet does not show a row while it is `pending` (it lists working
 * keys only, and its tests press what it lists). At integration, bind the key in its
 * handler and drop the entry's `pending` flag — the row then appears in `section`.
 * (⌘N "New page (desktop app)" is already in APP_SHORTCUTS.)
 */
export interface PendingShortcut { label: string; keys: string[]; section: "Text formatting" | "Blocks" | "Navigation" | "Markdown while typing"; literal?: boolean; pending: boolean }
export const PENDING_SHORTCUTS: PendingShortcut[] = [
  { label: "Copy link to this page", keys: ["Mod-L"], section: "Navigation", pending: true },
  { label: "Reopen the last closed tab", keys: ["Mod-Shift-T"], section: "Navigation", pending: true },
  { label: "Mark all as read (Inbox)", keys: ["Shift-A"], section: "Navigation", pending: true },
  { label: "Expand / collapse all toggles", keys: ["Mod-Alt-T"], section: "Blocks", pending: true },
  { label: "Select the block, then all blocks (press again)", keys: ["Mod-A"], section: "Blocks", pending: true },
  { label: "Emoji", keys: [":"], section: "Markdown while typing", literal: true, pending: true },
];

/**
 * A table entry in the command palette's hint form (`lib/shortcutHints.ts`):
 * "Mod-Shift-\\" → ["mod", "shift", "\\"]. The palette, the sheet and the handler
 * all read the SAME entry.
 */
export function shortcutKeys(name: AppShortcut): string[] {
  const parts = APP_SHORTCUTS[name].split("-").map((p) => (p === "" ? "-" : p));
  return parts.map((p) => (p === "Mod" || p === "Shift" || p === "Alt" ? p.toLowerCase() : p));
}

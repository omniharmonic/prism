import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { X } from "lucide-react";
import "./editor-blocks.css";

/**
 * Keyboard shortcut sheet (NP-ED-07): every editor, navigation and database
 * shortcut, written for the current platform. Opens with ⌘/ (Ctrl+/) whenever
 * the key was not taken by an editable block (there it opens the block menu),
 * and from Help → "Keyboard shortcuts" in the command bar.
 *
 * Self-mounting: `openShortcutSheet()` renders into its own root on <body>, so
 * every surface (workspace, share page, fixtures) gets it without a host mount.
 */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "Mod-Shift-K" → "⌘⇧K" on Apple platforms, "Ctrl+Shift+K" elsewhere. */
export function formatShortcut(spec: string): string {
  const names: Record<string, [string, string]> = {
    Mod: ["⌘", "Ctrl"], Alt: ["⌥", "Alt"], Shift: ["⇧", "Shift"], Enter: ["↵", "Enter"], Up: ["↑", "↑"], Down: ["↓", "↓"],
    Left: ["←", "←"], Right: ["→", "→"], Backspace: ["⌫", "Backspace"], Esc: ["Esc", "Esc"], Tab: ["Tab", "Tab"], Space: ["Space", "Space"],
  };
  const parts = spec.split("-").map((p) => (p === "" ? "-" : p));
  return parts.map((p) => names[p]?.[isMac ? 0 : 1] ?? (p.length === 1 ? p.toUpperCase() : p)).join(isMac ? "" : "+");
}

interface Row { label: string; keys: string[]; literal?: boolean }
interface Section { title: string; rows: Row[] }

const k = (label: string, ...keys: string[]): Row => ({ label, keys });
const typed = (label: string, ...keys: string[]): Row => ({ label, keys, literal: true });

export const SHORTCUT_SECTIONS: Section[] = [
  { title: "Text formatting", rows: [
    k("Bold", "Mod-B"), k("Italic", "Mod-I"), k("Underline", "Mod-U"), k("Strikethrough", "Mod-Shift-S"), k("Inline code", "Mod-E"),
    k("Link (with text selected)", "Mod-K"), k("Highlight (last colour)", "Mod-Shift-H"), k("Undo", "Mod-Z"), k("Redo", "Mod-Shift-Z"),
  ] },
  { title: "Blocks", rows: [
    k("Insert a block", "/"), k("Block menu / Turn into", "Mod-/"), k("Select the current block", "Esc"),
    k("Move the block selection", "Up", "Down"), k("Extend the block selection", "Shift-Up", "Shift-Down"),
    k("Move block up", "Mod-Shift-Up", "Alt-Shift-Up"), k("Move block down", "Mod-Shift-Down", "Alt-Shift-Down"),
    k("Duplicate block", "Mod-D"), k("Delete selected blocks", "Backspace"), k("Edit the selected block", "Enter"),
    k("Check a to-do / open a toggle", "Mod-Enter"), k("Nest / un-nest a list item", "Tab", "Shift-Tab"),
    k("Text", "Mod-Alt-0"), k("Heading 1–3", "Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3"),
    k("Bulleted list", "Mod-Shift-8"), k("Numbered list", "Mod-Shift-7"), k("To-do list", "Mod-Shift-9"), k("Quote", "Mod-Shift-B"), k("Code block", "Mod-Alt-C"),
  ] },
  { title: "Markdown while typing", rows: [
    typed("Heading 1–3", "#", "##", "###"), typed("Bulleted list", "-", "*", "+"), typed("Numbered list", "1."), typed("To-do", "[]"),
    typed("Quote", ">"), typed("Toggle", ">>"), typed("Code block", "```"), typed("Divider", "---"),
    typed("Bold / italic", "**text**", "*text*"), typed("Code / strikethrough", "`text`", "~~text~~"),
    typed("Link to a page", "[["), typed("Mention a person, page or date", "@"),
  ] },
  { title: "Find", rows: [
    k("Find in page", "Mod-F"), k("Find and replace", "Mod-Alt-F"), k("Next / previous match", "Enter", "Shift-Enter"),
  ] },
  { title: "Navigation", rows: [
    k("Quick find", "Mod-K"), k("New page (desktop app)", "Mod-N"), k("Save now", "Mod-S"), k("Ask agent about the selection", "Mod-J"),
    k("Toggle sidebar", "Mod-B"), k("Toggle side panel", "Mod-\\"), k("Close tab", "Mod-W"), k("Keyboard shortcuts", "Mod-/"),
  ] },
  { title: "Databases", rows: [
    k("Select all rows (table)", "Mod-A"), k("Select a range of rows", "Shift-Click"), k("Open a row in a new tab", "Mod-Click"),
    k("Close the row peek / clear selection", "Esc"), k("Next cell (simple table)", "Tab"), k("Previous cell (simple table)", "Shift-Tab"),
  ] },
];

function Sheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    search.current?.focus();
    const back = restore.current;
    return () => { back?.focus?.({ preventScroll: true }); };
  }, []);
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_SECTIONS;
    return SHORTCUT_SECTIONS.map((s) => ({ ...s, rows: s.rows.filter((r) => `${r.label} ${r.keys.map((x) => (r.literal ? x : formatShortcut(x))).join(" ")} ${s.title}`.toLowerCase().includes(q)) })).filter((s) => s.rows.length);
  }, [query]);
  return (
    <div className="prism-shortcuts-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="prism-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === "Tab") {
            // Two focusable controls: keep Tab inside the sheet.
            const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("input, button"));
            const i = els.indexOf(document.activeElement as HTMLElement);
            e.preventDefault();
            els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
          }
        }}
      >
        <div className="prism-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <input ref={search} type="search" aria-label="Search shortcuts" placeholder="Search shortcuts…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="prism-shortcuts-body">
          {sections.length === 0 && <p role="status" style={{ color: "var(--text-muted)", fontSize: 13 }}>No shortcut matches “{query}”.</p>}
          {sections.map((s) => (
            <section key={s.title} aria-label={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map((r) => (
                  <div className="prism-shortcuts-row" key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.keys.map((key, i) => <span key={key}>{i > 0 && <span aria-hidden="true"> · </span>}<kbd>{r.literal ? key : formatShortcut(key)}</kbd></span>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

export function closeShortcutSheet(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function openShortcutSheet(): void {
  if (root || typeof document === "undefined") return;
  host = document.createElement("div");
  host.setAttribute("data-prism-shortcuts", "");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Sheet onClose={closeShortcutSheet} />);
}

// ⌘/ (Ctrl+/) anywhere the key was not already used: an editable block's handler
// (BlockHandles, capture phase) prevents default and opens its block menu instead.
let installed = false;
export function installShortcutSheetKey(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "/" || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]') && !target.closest(".tiptap")) return; // typing in a field
    if (!root && document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return; // another modal owns the moment
    event.preventDefault();
    if (root) closeShortcutSheet(); else openShortcutSheet();
  });
}
installShortcutSheetKey();

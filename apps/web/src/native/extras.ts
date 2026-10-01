// Native-shell extras (WP4.2): the page half of "Export note…" and drag-drop.
// Native build only (main.tsx calls initNativeExtras() when isNative).
//
// The shell (apps/client/src-tauri) does the privileged parts:
//  - Export: the menu dispatches `prism:export-note`; we build the content and
//    call `__PRISM_SHELL__.exportNote(content, name, format)`. The shell shows
//    the native save panel and writes only to the path the USER picks. We never
//    supply a path.
//  - Drop: the shell reads dropped .md/.txt files (size caps, UTF-8 only) and
//    dispatches `prism:files-dropped` with their CONTENT; we create the notes
//    through the normal gateway client (active vault, offline outbox, grants).
//    Everything else is reported as "not supported yet".
import { marked } from "marked";
import TurndownService from "turndown";
import { useUIStore } from "@prism/core";
import * as rest from "../parachute/rest";

interface Shell {
  toast?(msg: string): void;
  exportNote?(content: string, suggestedName: string, format: string): Promise<string | null>;
}
const shell = (): Shell | undefined => (window as unknown as { __PRISM_SHELL__?: Shell }).__PRISM_SHELL__;
const toast = (m: string) => shell()?.toast?.(m);

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const HTMLISH = /^\s*<(p|h[1-6]|ul|ol|div|blockquote|pre|table|section|article|figure|hr)\b/i;

/** Notes hold HTML for documents (TipTap) and raw text for everything else. */
export function toExportContent(content: string, format: "markdown" | "html"): string {
  const isHtml = HTMLISH.test(content);
  if (format === "markdown") return isHtml ? turndown.turndown(content) : content;
  return isHtml ? content : (marked.parse(content, { async: false }) as string);
}

/** A bare file name for the save panel; the shell sanitises it again. */
function titleOf(note: { path: string | null; metadata: Record<string, unknown> | null; id: string }): string {
  const t = note.metadata?.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  const leaf = note.path?.split("/").filter(Boolean).pop();
  return leaf || note.id;
}

async function exportActiveNote(format: "markdown" | "html"): Promise<void> {
  const ui = useUIStore.getState();
  const tab = ui.openTabs.find((t) => t.id === ui.activeTabId);
  if (!tab || tab.noteId.includes(":")) {
    toast("Open a note first, then export it.");
    return;
  }
  try {
    const note = await rest.getNote(tab.noteId);
    const name = await shell()?.exportNote?.(toExportContent(note.content ?? "", format), titleOf(note), format);
    if (name) toast(`Exported ${name}`);
  } catch (e) {
    toast(`Export failed: ${(e as Error)?.message ?? e}`);
  }
}

interface Dropped {
  notes: Array<{ name: string; content: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

const stem = (name: string) => name.replace(/\.(md|markdown|txt)$/i, "");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Dropped text → the HTML the document editor stores. */
export function droppedToContent(name: string, text: string): string {
  if (/\.txt$/i.test(name)) {
    return text
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
  return marked.parse(text, { async: false }) as string;
}

async function importDropped(d: Dropped): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  let created = 0;
  let firstId: string | null = null;
  let firstTitle = "";
  const failed: string[] = [];
  for (const n of d.notes) {
    try {
      const note = await rest.createNote({
        content: droppedToContent(n.name, n.content),
        path: `vault/imports/${day}/${slug(stem(n.name))}-${Math.random().toString(16).slice(2, 6)}`,
        tags: ["document"],
        metadata: { title: stem(n.name), source: "prism-client-drop" },
      });
      created++;
      if (!firstId) {
        firstId = note.id;
        firstTitle = stem(n.name);
      }
    } catch {
      failed.push(n.name);
    }
  }
  const parts: string[] = [];
  if (created) parts.push(`Created ${created} note${created === 1 ? "" : "s"} from dropped files.`);
  if (failed.length) parts.push(`Couldn't save: ${failed.join(", ")}.`);
  const attach = d.skipped.filter((s) => s.reason === "Attachments aren't supported yet.");
  if (attach.length) parts.push(`Attachments aren't supported yet (${attach.map((s) => s.name).join(", ")}).`);
  const other = d.skipped.filter((s) => s.reason !== "Attachments aren't supported yet.");
  if (other.length) parts.push(other.map((s) => `${s.name}: ${s.reason}`).join(" "));
  if (parts.length) toast(parts.join(" "));
  if (firstId) useUIStore.getState().openTab(firstId, firstTitle, "document");
}

let started = false;
export function initNativeExtras(): void {
  if (started) return;
  started = true;
  window.addEventListener("prism:export-note", (e) => {
    const f = (e as CustomEvent<{ format?: string }>).detail?.format;
    void exportActiveNote(f === "html" ? "html" : "markdown");
  });
  window.addEventListener("prism:files-dropped", (e) => {
    const d = (e as CustomEvent<Dropped>).detail;
    if (!d || !Array.isArray(d.notes) || !Array.isArray(d.skipped)) return;
    void importDropped(d);
  });
}

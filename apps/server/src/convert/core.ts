/**
 * The conversions whose cost depends on NOTE CONTENT: Markdown → HTML (marked),
 * HTML → Markdown (turndown), HTML ⇄ ProseMirror JSON (TipTap over happy-dom)
 * and the Yjs seed of a document. Pure functions of their input.
 *
 * This module is loaded in TWO places and must behave identically in both: the
 * conversion worker thread (transfer/worker.ts) and — for small, pre-checked
 * inputs only — the main thread (convert/service.ts, which is the ONLY main-thread
 * caller). It must never import the database, the config or the network.
 *
 * Costs measured on the 16 GB host under load (see docs in CLAUDE.md "Content
 * conversion"): marked is quadratic on emphasis runs, turndown and the
 * ProseMirror DOM parser recurse per nesting level (stack overflow ~2,000 deep),
 * and even ORDINARY content costs seconds per megabyte in generateJSON /
 * generateHTML — so nothing here may run on the server's event loop unbounded.
 */
import { Window } from "happy-dom";
import * as Y from "yjs";
import { generateJSON, generateHTML, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { collabExtensions } from "@prism/core/editor-schema";
import { marked } from "marked";
import TurndownService from "turndown";

// TipTap's generate{JSON,HTML} need a DOM at call time; provide a lightweight
// one. (These globals are read when the functions run, never at import.)
const _win = new Window();
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= _win;
g.document ??= _win.document;
g.DOMParser ??= _win.DOMParser;

/** TipTap's default XML fragment name. */
export const FIELD = "default";
export const exts = collabExtensions();
export const schema = getSchema(exts);

/** A ProseMirror document as JSON (the shared collab schema). */
export type DocJson = { type: string; content?: unknown[]; [k: string]: unknown };

/** Collab's rule: a body that starts with `<` is stored HTML, anything else is Markdown. */
export const isStoredHtml = (content: string): boolean => content.trim().startsWith("<");

/** Markdown → HTML, exactly as collab seeds a document (marked defaults, unsanitised). */
export function markdownToHtmlSync(md: string): string {
  return marked.parse(md) as string;
}

/** A note body (stored HTML, or Markdown) → ProseMirror JSON. */
export function contentToDocJsonSync(content: string): DocJson {
  const src = content ?? "";
  const html = isStoredHtml(src) ? src : markdownToHtmlSync(src);
  return generateJSON(html || "<p></p>", exts) as DocJson;
}

/** HTML → ProseMirror JSON, with no Markdown step (the suggestion helpers' parse). */
export function htmlToDocJsonSync(html: string): DocJson {
  return generateJSON(html, exts) as DocJson;
}

/** ProseMirror JSON → the HTML a collab store writes. */
export function docJsonToHtmlSync(json: unknown): string {
  return generateHTML(json as never, exts);
}

/** A note body → the encoded state of a fresh Y.Doc holding it in the shared fragment. */
export function contentToSeedSync(content: string): Uint8Array {
  return Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, contentToDocJsonSync(content), FIELD));
}

let plainTurndown: TurndownService | null = null;
/** HTML → Markdown for an agent reading a document note (the MCP resource's flavour). */
export function htmlToMarkdownSync(html: string): string {
  plainTurndown ??= new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return plainTurndown.turndown(html);
}

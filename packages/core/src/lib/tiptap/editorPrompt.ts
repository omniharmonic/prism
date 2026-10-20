import type { Editor } from "@tiptap/core";

/**
 * The editor's in-app "type an address" field (`components/renderers/EditorPrompt.tsx`).
 *
 * It replaces `window.prompt()`, which the Prism Client's web view (macOS and iOS) answers
 * with `null` without showing anything — Embed, Web bookmark, Image from URL and the toolbar's
 * Link / Image did nothing there. Both editors mount ONE `<EditorPrompt editor>`; a command asks
 * for it with `requestEditorPrompt`, which captures where the caret (or the selection) is NOW.
 * The field keeps that place mapped through every transaction made while it is open (a
 * collaborator typing above it), so the block lands where the caret was.
 */
export type EditorPromptKind = "image" | "embed" | "bookmark" | "link";

export interface EditorPromptRequest {
  kind: EditorPromptKind;
  from: number;
  to: number;
  /** The field's starting value (an existing link's address). */
  value?: string;
}

export const EDITOR_PROMPT_EVENT = "prism:editor-prompt";

/** Open the field for `kind` at the current selection. False when no field is mounted for this editor. */
export function requestEditorPrompt(editor: Editor, kind: EditorPromptKind, value?: string): boolean {
  if (editor.isDestroyed) return false;
  const { from, to } = editor.state.selection;
  const detail: { request: EditorPromptRequest; handled: boolean } = { request: { kind, from, to, value }, handled: false };
  try { editor.view.dom.dispatchEvent(new CustomEvent(EDITOR_PROMPT_EVENT, { detail })); } catch { return false; }
  return detail.handled;
}

/** http(s), or a path on this server ("/…", never "//host"). Never javascript: / data: / blob:. A bare domain gets https://. */
export function imageAddress(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\s\\\u0000-\u001f]/.test(value)) return null;
  if (/^https?:\/\/[^/]/i.test(value) || /^\/(?!\/)/.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return null;
}

/** A web address for an embed / bookmark: a bare domain ("youtu.be/…") gets https://. */
export function webAddress(raw: string): string {
  const value = raw.trim();
  return /^[\w.-]+\.[a-z]{2,}(\/|\?|#|$)/i.test(value) ? `https://${value}` : value;
}

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { usePageActivity } from "./usePageActivity";
import { lastEditedBy, writerOf } from "../../lib/history/attribution";
import { formatWhen } from "../history/labels";
import type { Note } from "../../lib/types";

/** Plain text of a stored body (HTML or Markdown) — no DOM needed. */
export function plainText(content: string): string {
  return (content ?? "")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/blockquote|\/pre|\/div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Words and characters the way Notion counts them: words split on whitespace,
 *  characters excluding line breaks. Pure. */
export function countText(text: string): { words: number; characters: number } {
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  const characters = [...text.replace(/[\r\n]/g, "")].length;
  return { words, characters };
}

/**
 * Page info (NP-PG-17): the footer of the page ⋯ menu — word and character count,
 * created, last edited and who last edited it. Standalone: the chrome's ⋯ menu
 * mounts it with the open note (and the live editor, when there is one, so the
 * counts follow unsaved typing).
 */
export function PageInfo({ note, editor }: { note: Note; editor?: Editor | null }) {
  const [liveText, setLiveText] = useState<string | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return setLiveText(null);
    const read = () => setLiveText(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " "));
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  // The server names the last editor (never an email); the owner path resolves the raw stamp.
  const activity = usePageActivity(note);
  const counts = countText(liveText ?? plainText(note.content));
  const writer = activity.data?.lastEditor ?? writerOf({ metadata: note.metadata, producedAt: note.updatedAt }, activity.directory);
  const by = lastEditedBy(writer);
  const row = (label: string, value: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <dt style={{ color: "var(--text-muted)" }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--text-secondary)", textAlign: "right", overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
  return (
    <dl className="prism-page-info" aria-label="Page info" style={{ margin: 0, padding: "8px 12px 10px", display: "grid", gap: 4, fontSize: 12, lineHeight: 1.5, borderTop: "1px solid var(--glass-border)" }}>
      {row("Word count", counts.words.toLocaleString())}
      {row("Characters", counts.characters.toLocaleString())}
      {note.createdAt && row("Created", formatWhen(note.createdAt))}
      {note.updatedAt && row("Last edited", formatWhen(note.updatedAt))}
      {by && row("Last edited by", by)}
    </dl>
  );
}

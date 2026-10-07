import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Marked } from "marked";
import { Bot, FileText, LayoutTemplate, Upload } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useAgentAvailable } from "../../data/AgentClientContext";
import { openAgentChat } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { TEMPLATE_TAG, isTrashed } from "../../lib/pages/model";
import { sanitizeHtml } from "../../lib/html/sanitize";
import "./FormattingBar.css";

const IMPORT_MAX_BYTES = 2_000_000;
const markdown = new Marked({ gfm: true });

/** Imported text → editor HTML. Markdown/plain go through marked; HTML is sanitised. */
export function importToHtml(name: string, text: string): string {
  if (/\.html?$/i.test(name)) return sanitizeHtml(text);
  return sanitizeHtml(markdown.parse(text, { async: false }) as string);
}

/**
 * NP-PG-14: an empty, editable page offers Empty, Template, Import and Ask
 * agent. Everything here only fills THIS page's editor (autosave or the live
 * doc then saves it as usual); the row vanishes the moment the page has content.
 */
export function EmptyPageStarters({ editor, noteId, title }: { editor: Editor; noteId: string; title: string }) {
  const client = useVaultClient();
  const tree = useVaultTree();
  const agent = useAgentAvailable();
  const [empty, setEmpty] = useState(() => editor.isEmpty);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const update = () => setEmpty(editor.isEmpty);
    editor.on("update", update);
    editor.on("create", update);
    return () => { editor.off("update", update); editor.off("create", update); };
  }, [editor]);
  if (!empty || !editor.isEditable) return null;
  const templates = (tree.data ?? []).filter((n) => n.tags?.includes(TEMPLATE_TAG) && !isTrashed(n) && n.id !== noteId);
  const useTemplate = async (id: string) => {
    setError("");
    try {
      const template = await client.getNote(id);
      if (!editor.isEmpty) return; // the user started typing meanwhile — never overwrite
      editor.chain().focus().setContent(sanitizeHtml(template.content ?? ""), { emitUpdate: true }).run();
      setChoosing(false);
    } catch {
      setError("That template could not be opened.");
    }
  };
  const importFile = async (f: File | undefined) => {
    setError("");
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) { setError("That file is too large to import here (2 MB max)."); return; }
    const text = await f.text();
    if (!editor.isEmpty) return;
    editor.chain().focus().setContent(importToHtml(f.name, text), { emitUpdate: true }).run();
  };
  return (
    <div className="empty-page-starters" role="group" aria-label="Start this page">
      <p className="empty-page-starters-hint">Press Enter to write, or start with</p>
      <div className="empty-page-starters-row">
        <button type="button" className="empty-page-starter focus-ring" onClick={() => editor.commands.focus()}><FileText size={15} aria-hidden /> Empty page</button>
        <button type="button" className="empty-page-starter focus-ring" aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}><LayoutTemplate size={15} aria-hidden /> Template</button>
        <button type="button" className="empty-page-starter focus-ring" onClick={() => file.current?.click()}><Upload size={15} aria-hidden /> Import</button>
        {agent && (
          <button type="button" className="empty-page-starter focus-ring" onClick={() => {
            useUIStore.getState().setContextPanelTab("agent");
            openAgentChat({ ask: { noteId, noteTitle: title } });
          }}><Bot size={15} aria-hidden /> Ask agent</button>
        )}
        <input ref={file} type="file" hidden accept=".md,.markdown,.txt,.html,.htm,text/markdown,text/plain,text/html" aria-label="Import a file into this page"
          onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {choosing && (
        <ul className="empty-page-templates" aria-label="Templates">
          {templates.length ? templates.slice(0, 12).map((t) => (
            <li key={t.id}><button type="button" className="empty-page-starter focus-ring" onClick={() => void useTemplate(t.id)}>{t.path?.split("/").pop() ?? t.id}</button></li>
          )) : <li className="empty-page-starters-hint">No templates yet. Tag a page “template” to use it here.</li>}
        </ul>
      )}
      {error && <p role="alert" className="empty-page-starters-hint">{error}</p>}
    </div>
  );
}

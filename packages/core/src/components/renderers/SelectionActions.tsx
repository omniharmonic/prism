import type { Editor } from "@tiptap/react";
import { Bold, Italic, Code, Sparkles } from "lucide-react";
import { useSelectionAsk, useSelectionAskShortcut } from "../../lib/agent/useSelectionAsk";
import "./SelectionActions.css";

/** The same editing commands as the full toolbar, plus an unsent agent handoff. */
export function SelectionActions({ editor, allowFormatting }: { editor: Editor; allowFormatting: boolean }) {
  const action = useSelectionAsk(editor);
  useSelectionAskShortcut(editor, action.ask, action.hasClient);
  return <>
    {action.available && <button type="button" aria-label="Ask agent about selection" title={action.canAsk ? "Ask agent about selection (⌘J / Ctrl+J)" : action.reason}
      disabled={!action.canAsk || !action.selected} onMouseDown={event => event.preventDefault()} onClick={() => action.ask()}>
      <Sparkles size={14} aria-hidden="true" /> Ask agent
    </button>}
    {allowFormatting && [
      { label: "Bold selection", name: "bold", icon: <Bold size={14} />, run: () => editor.chain().focus().toggleBold().run() },
      { label: "Italic selection", name: "italic", icon: <Italic size={14} />, run: () => editor.chain().focus().toggleItalic().run() },
      { label: "Code selection", name: "code", icon: <Code size={14} />, run: () => editor.chain().focus().toggleCode().run() },
    ].map(item => <button key={item.name} type="button" aria-label={item.label} aria-pressed={editor.isActive(item.name)} title={item.label}
      onMouseDown={event => event.preventDefault()} onClick={item.run}>{item.icon}</button>)}
  </>;
}

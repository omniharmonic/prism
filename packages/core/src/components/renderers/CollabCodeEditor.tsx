import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type { AwarenessProvider, CollabUser } from "./CollabEditor";
import { useIsMobile } from "../../app/hooks/useIsMobile";

/**
 * Real-time collaborative code editor — CodeMirror 6 bound to a Yjs `Y.Text`
 * (the "codemirror" field) via `y-codemirror.next`'s `yCollab`. The server seeds
 * and persists that Y.Text as PLAIN SOURCE (no HTML), so what you type is exactly
 * what lands in Parachute. Remote cursors/selections come from Yjs awareness.
 *
 * Note: unlike the document editor, code has no comments/suggestions — those are
 * prose concepts. This is pure collaborative text with syntax highlighting.
 */
export function CollabCodeEditor({
  ydoc,
  provider,
  user,
  language,
  editable = true,
}: {
  ydoc: Y.Doc;
  provider: AwarenessProvider;
  user: CollabUser;
  language: string;
  editable?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!hostRef.current) return;
    const ytext = ydoc.getText("codemirror");
    const awareness = provider.awareness as Awareness | null;
    // yCollab reads the local "user" awareness field for the remote-caret label/color.
    awareness?.setLocalStateField("user", { name: user.name, color: user.color, colorLight: user.color + "33" });

    const undoManager = new Y.UndoManager(ytext);
    const langExt = getLanguageExtension(language);

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...closeBracketsKeymap, ...searchKeymap, indentWithTab]),
      // yCollab supplies the doc content + sync + remote cursors + collaborative undo.
      yCollab(ytext, awareness, { undoManager }),
      oneDark,
      EditorView.theme({
        // 16px on touch devices prevents iOS Safari from auto-zooming the page
        // when the editor gains focus (it zooms any focused field below 16px).
        "&": { height: "100%", fontSize: isMobile ? "16px" : "13px", background: "transparent" },
        ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", WebkitOverflowScrolling: "touch" },
      }),
      EditorView.editable.of(editable),
      EditorState.readOnly.of(!editable),
    ];
    if (langExt) extensions.push(langExt);

    const view = new EditorView({
      state: EditorState.create({ extensions }), // no initial doc — yCollab seeds from Y.Text
      parent: hostRef.current,
    });
    viewRef.current = view;

    return () => {
      undoManager.destroy();
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild only when the doc/provider/editability/language/size identity changes.
  }, [ydoc, provider, language, editable, user.name, user.color, isMobile]);

  return <div ref={hostRef} style={{ height: "100%", minHeight: "60vh", overflow: "auto" }} />;
}

function getLanguageExtension(lang: string): Extension | null {
  switch (lang) {
    case "typescript":
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
    case "jsx":
      return javascript({ jsx: true });
    case "python":
      return python();
    case "html":
      return html();
    case "css":
    case "scss":
      return css();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "rust":
      return rust();
    case "sql":
      return sql();
    default:
      return null;
  }
}

/** Map a note path/metadata to a CodeMirror language id (shared with CodeRenderer's map). */
export function detectCodeLanguage(path: string | null, metadata: Record<string, unknown> | null): string {
  if (metadata?.["language"] && typeof metadata["language"] === "string") return metadata["language"];
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase();
  const EXT_MAP: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", css: "css", scss: "scss",
    html: "html", htm: "html", json: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", md: "markdown", sql: "sql", sh: "shell", bash: "shell",
    xml: "xml", swift: "swift",
  };
  return EXT_MAP[ext || ""] || "plaintext";
}

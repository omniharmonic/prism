import { useCallback, useRef, useEffect } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
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
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useSettingsStore } from "../../app/stores/settings";
import type { Extension } from "@codemirror/state";

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

function detectLanguage(path: string | null, metadata: Record<string, unknown> | null): string {
  if (metadata?.language && typeof metadata.language === "string") return metadata.language;
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

// Light theme that uses Prism's CSS variables
const prismLightTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text-primary)" },
  ".cm-gutters": { backgroundColor: "var(--bg-surface)", color: "var(--text-muted)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "var(--glass-hover)" },
  ".cm-activeLine": { backgroundColor: "var(--glass-hover)" },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(var(--accent-rgb, 99,102,241), 0.2)" },
  ".cm-foldGutter": { color: "var(--text-muted)" },
}, { dark: false });

export default function CodeRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const language = detectLanguage(note.path, meta);
  const contentRef = useRef(note.content || "");
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme === "dark";

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave } = useAutoSave(note.id, getContent);
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  useEffect(() => {
    if (!editorRef.current) return;

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
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          contentRef.current = update.state.doc.toString();
          scheduleSaveRef.current();
        }
      }),
      isDark ? oneDark : prismLightTheme,
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
      }),
    ];

    if (langExt) extensions.push(langExt);

    const state = EditorState.create({
      doc: contentRef.current,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // Re-create editor when theme or language changes
  }, [language, isDark, note.id]);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-4 py-1.5 text-xs flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span style={{ color: "var(--text-secondary)" }}>
          {language} {note.path && `— ${note.path.split("/").pop()}`}
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          {isSaving ? "Saving..." : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : ""}
        </span>
      </div>
      <div ref={editorRef} className="flex-1 min-h-0 overflow-auto" />
    </div>
  );
}

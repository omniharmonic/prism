import { useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";

// Detect language from file extension or metadata
function detectLanguage(path: string | null, metadata: Record<string, unknown> | null): string {
  if (metadata?.language && typeof metadata.language === "string") {
    return metadata.language;
  }

  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase();

  const EXT_MAP: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    c: "c", cpp: "cpp", h: "c",
    cs: "csharp",
    css: "css", scss: "scss",
    html: "html", htm: "html",
    json: "json",
    yaml: "yaml", yml: "yaml",
    toml: "ini",
    md: "markdown",
    sql: "sql",
    sh: "shell", bash: "shell", zsh: "shell",
    xml: "xml",
    svg: "xml",
    dockerfile: "dockerfile",
    graphql: "graphql",
    swift: "swift",
    kt: "kotlin",
    lua: "lua",
    r: "r",
    php: "php",
  };

  return EXT_MAP[ext || ""] || "plaintext";
}

export default function CodeRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const language = detectLanguage(note.path, meta);
  const contentRef = useRef(note.content);

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave, saveNow } = useAutoSave(note.id, getContent);

  const handleChange = useCallback((value: string | undefined) => {
    contentRef.current = value || "";
    scheduleSave();
  }, [scheduleSave]);

  return (
    <div className="flex flex-col h-full">
      {/* Language label */}
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

      {/* Monaco editor */}
      <div className="flex-1">
        <Editor
          language={language}
          value={note.content}
          onChange={handleChange}
          theme="vs-dark"
          options={{
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            minimap: { enabled: true },
            lineNumbers: "on",
            wordWrap: "on",
            scrollBeyondLastLine: false,
            padding: { top: 16 },
            renderWhitespace: "selection",
            bracketPairColorization: { enabled: true },
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
          }}
          onMount={(editor) => {
            // Cmd+S to save
            editor.addCommand(
              // eslint-disable-next-line no-bitwise
              2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
              () => saveNow(),
            );
          }}
        />
      </div>
    </div>
  );
}

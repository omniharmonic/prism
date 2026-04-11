import { useCallback, useRef, useState } from "react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";

function detectLanguage(path: string | null, metadata: Record<string, unknown> | null): string {
  if (metadata?.language && typeof metadata.language === "string") return metadata.language;
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase();
  const EXT_MAP: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", css: "css", scss: "scss",
    html: "html", htm: "html", json: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", md: "markdown", sql: "sql", sh: "shell", bash: "shell",
    xml: "xml", swift: "swift",
  };
  return EXT_MAP[ext || ""] || "plaintext";
}

export default function CodeRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const language = detectLanguage(note.path, meta);
  const [content, setContent] = useState(note.content || "");
  const contentRef = useRef(note.content || "");

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave } = useAutoSave(note.id, getContent);

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
      <div className="flex-1 flex overflow-auto">
        <div
          className="flex-shrink-0 text-right pr-3 pl-3 pt-3 select-none"
          style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: "1.6" }}
        >
          {content.split("\n").map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            contentRef.current = e.target.value;
            scheduleSave();
          }}
          spellCheck={false}
          className="flex-1 resize-none outline-none pt-3 pb-8 pr-4"
          style={{
            background: "transparent",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: "1.6",
            tabSize: 2,
            whiteSpace: "pre",
            overflowWrap: "normal",
          }}
        />
      </div>
    </div>
  );
}

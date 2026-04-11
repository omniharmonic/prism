import { useState, useCallback, useRef, useEffect } from "react";
import { Eye, Code, Columns } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";

export default function WebsiteRenderer({ note }: RendererProps) {
  const [view, setView] = useState<"split" | "code" | "preview">("split");
  const [content, setContent] = useState(note.content || "");
  const contentRef = useRef(note.content || "");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave } = useAutoSave(note.id, getContent);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    contentRef.current = e.target.value;
    scheduleSave();
  };

  // Update preview when content changes
  useEffect(() => {
    if (iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) { doc.open(); doc.write(content); doc.close(); }
    }
  }, [content]);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-4 py-1.5 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {note.path?.split("/").pop() || "Website"}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
            {([["split", Columns], ["code", Code], ["preview", Eye]] as const).map(([v, Icon]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="p-1.5"
                style={{ background: view === v ? "var(--glass-active)" : "transparent" }}
              >
                <Icon size={13} style={{ color: "var(--text-primary)" }} />
              </button>
            ))}
          </div>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {isSaving ? "Saving..." : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : ""}
          </span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {(view === "split" || view === "code") && (
          <div className={view === "split" ? "w-1/2" : "w-full"} style={{ borderRight: view === "split" ? "1px solid var(--glass-border)" : "none" }}>
            <textarea
              value={content}
              onChange={handleChange}
              spellCheck={false}
              className="w-full h-full resize-none outline-none p-4"
              style={{
                background: "transparent",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: "1.6",
                tabSize: 2,
                whiteSpace: "pre",
              }}
            />
          </div>
        )}
        {(view === "split" || view === "preview") && (
          <div className={view === "split" ? "w-1/2" : "w-full"} style={{ background: "white" }}>
            <iframe
              ref={iframeRef}
              title="Preview"
              sandbox="allow-scripts"
              className="w-full h-full border-none"
            />
          </div>
        )}
      </div>
    </div>
  );
}

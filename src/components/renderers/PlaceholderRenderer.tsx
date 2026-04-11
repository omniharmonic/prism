import { FileQuestion } from "lucide-react";
import type { RendererProps } from "./RendererProps";

export default function PlaceholderRenderer({ note }: RendererProps) {
  const type = (note.metadata as Record<string, unknown>)?.type as string || "unknown";

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <FileQuestion size={48} style={{ color: "var(--text-muted)" }} />
      <p className="text-lg font-medium" style={{ color: "var(--text-secondary)" }}>
        Renderer not yet implemented
      </p>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Content type: <code className="glass px-1.5 py-0.5 rounded text-xs">{type}</code>
      </p>
      {/* Show raw content as fallback */}
      <div className="w-full max-w-2xl mt-4">
        <pre
          className="glass-inset p-4 text-sm overflow-auto rounded-lg max-h-[60vh]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}
        >
          {note.content || "(empty)"}
        </pre>
      </div>
    </div>
  );
}

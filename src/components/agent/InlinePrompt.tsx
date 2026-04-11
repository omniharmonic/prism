import { useState, useRef, useEffect, useCallback } from "react";
import { X, Check, Loader2 } from "lucide-react";
import { agentApi } from "../../lib/agent/client";

interface InlinePromptProps {
  noteId: string;
  selection: string;
  position: { x: number; y: number };
  onAccept: (replacement: string) => void;
  onReject: () => void;
}

export function InlinePrompt({ noteId, selection, position, onAccept, onReject }: InlinePromptProps) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);

    try {
      const replacement = await agentApi.edit(noteId, selection, prompt);
      setResult(replacement);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [noteId, selection, prompt, loading]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (result) {
        onAccept(result);
      } else {
        handleSubmit();
      }
    }
    if (e.key === "Escape") {
      onReject();
    }
  };

  return (
    <div
      className="fixed z-50 glass-elevated rounded-xl shadow-2xl overflow-hidden"
      style={{
        left: `${Math.min(position.x, window.innerWidth - 400)}px`,
        top: `${Math.min(position.y + 20, window.innerHeight - 300)}px`,
        width: 380,
      }}
    >
      {/* Input */}
      {!result && (
        <div className="flex items-center gap-2 p-2">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What should I do with this?"
            disabled={loading}
            className="flex-1 h-8 rounded-lg px-3 text-sm outline-none"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-primary)",
            }}
          />
          {loading ? (
            <Loader2 size={16} className="animate-spin" style={{ color: "var(--color-accent)" }} />
          ) : (
            <button
              onClick={onReject}
              className="p-1.5 rounded hover:bg-[var(--glass-hover)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 pb-2 text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {/* Diff view */}
      {result && (
        <div className="p-3 space-y-2">
          <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Suggested edit:
          </div>

          {/* Original */}
          <div
            className="px-2 py-1 rounded text-sm line-through opacity-60"
            style={{ background: "rgba(235, 87, 87, 0.1)", color: "var(--color-danger)" }}
          >
            {selection}
          </div>

          {/* Replacement */}
          <div
            className="px-2 py-1 rounded text-sm"
            style={{ background: "rgba(111, 207, 151, 0.1)", color: "var(--color-success)" }}
          >
            {result}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onReject}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-[var(--glass-hover)]"
              style={{ color: "var(--text-secondary)" }}
            >
              <X size={12} /> Reject
            </button>
            <button
              onClick={() => onAccept(result)}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              <Check size={12} /> Accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

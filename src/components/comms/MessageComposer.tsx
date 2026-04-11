import { useState, useRef } from "react";
import { Send } from "lucide-react";

interface MessageComposerProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageComposer({ onSend, disabled, placeholder }: MessageComposerProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className="flex items-end gap-2 p-3"
      style={{ borderTop: "1px solid var(--glass-border)" }}
    >
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder || "Type a message..."}
        rows={1}
        className="flex-1 resize-none rounded-xl px-4 py-2 text-sm outline-none"
        style={{
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          color: "var(--text-primary)",
          maxHeight: 120,
          minHeight: 36,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        className="p-2 rounded-full transition-colors disabled:opacity-30"
        style={{ background: "var(--color-accent)", color: "white" }}
      >
        <Send size={16} />
      </button>
    </div>
  );
}

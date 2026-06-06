import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2, Bot, FileInput, Replace, PenLine, ToggleLeft, ToggleRight } from "lucide-react";
import { agentApi } from "../../lib/agent/client";
import { useUIStore } from "../../app/stores/ui";
import { vaultApi } from "../../lib/parachute/client";
import { useQueryClient } from "@tanstack/react-query";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export function PanelChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { openTabs, activeTabId, setPendingEdit, setGhostText } = useUIStore();
  const queryClient = useQueryClient();
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const noteId = activeTab?.noteId;
  // Don't pass virtual note IDs (matrix:...) to the agent
  const effectiveNoteId = noteId && !noteId.includes(":") ? noteId : undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const response = await agentApi.chat(text, effectiveNoteId);
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: response.message,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Check if the agent modified the note via MCP (re-fetch and compare)
      if (effectiveNoteId) {
        try {
          const freshNote = await vaultApi.getNote(effectiveNoteId);
          // Invalidate the query cache so the editor picks up changes
          queryClient.invalidateQueries({ queryKey: ["vault", "note", effectiveNoteId] });
          queryClient.invalidateQueries({ queryKey: ["vault"] });

          // If the content changed, show it as ghost text for review
          if (freshNote.content && editMode) {
            setGhostText({
              noteId: effectiveNoteId,
              content: freshNote.content,
              position: "end",
            });
          }
        } catch {
          // Note fetch failed — agent may not have edited it, that's fine
        }
      }
    } catch (e) {
      const errorMsg: ChatMessage = {
        role: "assistant",
        content: `Error: ${String(e)}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, effectiveNoteId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <Bot size={14} style={{ color: "var(--color-accent)" }} />
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Claude
        </span>
        {effectiveNoteId && (
          <>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              · {activeTab?.title}
            </span>
            <button
              onClick={() => setEditMode(!editMode)}
              className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors"
              style={{
                background: editMode ? "var(--color-accent)" : "transparent",
                color: editMode ? "white" : "var(--text-muted)",
                border: editMode ? "none" : "1px solid var(--glass-border)",
              }}
              title={editMode ? "Edit mode: responses auto-insert into document" : "Chat mode: responses stay in chat"}
            >
              {editMode ? <ToggleRight size={11} /> : <ToggleLeft size={11} />}
              Edit
            </button>
          </>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-center pt-8 space-y-2">
            <Bot size={24} className="mx-auto" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Ask Claude anything about your document
            </p>
            <div className="space-y-1">
              {["Summarize this document", "Suggest improvements", "What are the key points?"].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="block w-full text-left text-xs px-3 py-1.5 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className="max-w-[90%] px-3 py-2 rounded-xl text-sm"
              style={{
                background: msg.role === "user" ? "var(--color-accent)" : "var(--glass)",
                color: msg.role === "user" ? "white" : "var(--text-primary)",
                borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              }}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
            {/* Apply to document buttons for assistant messages */}
            {msg.role === "assistant" && effectiveNoteId && (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <button
                  onClick={() => {
                    setGhostText({
                      noteId: effectiveNoteId,
                      content: msg.content,
                      position: "end",
                    });
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
                  style={{ background: "var(--color-accent)", color: "white" }}
                >
                  <PenLine size={10} /> Insert into document
                </button>
                <button
                  onClick={() => {
                    setPendingEdit({
                      noteId: effectiveNoteId,
                      content: msg.content,
                      mode: "append",
                    });
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-muted)" }}
                >
                  <FileInput size={10} /> Append
                </button>
                <button
                  onClick={() => {
                    setPendingEdit({
                      noteId: effectiveNoteId,
                      content: msg.content,
                      mode: "replace",
                    });
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Replace size={10} /> Replace
                </button>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 px-2">
            <Loader2 size={14} className="animate-spin" style={{ color: "var(--color-accent)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Claude is thinking...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 p-2" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude..."
          rows={1}
          disabled={loading}
          className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
            maxHeight: 100,
            minHeight: 36,
          }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="p-2 rounded-full transition-colors disabled:opacity-30"
          style={{ background: "var(--color-accent)", color: "white" }}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

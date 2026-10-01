import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";
import { requestReceipt, clearRequestReceipt } from "../../lib/drafts/requestReceipt";

interface MessageComposerProps {
  onSend: (body: string, options: { requestId?: string }) => void | Promise<void>;
  draftScope?: string | null;
  draftKey: string;
  retrySafe?: boolean;
  enterToSend?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageComposer(props: MessageComposerProps) {
  return <ScopedMessageComposer key={JSON.stringify([props.draftScope, props.draftKey])} {...props} />;
}

function ScopedMessageComposer({ onSend, disabled, placeholder, draftScope, draftKey, retrySafe, enterToSend = true }: MessageComposerProps) {
  const draft = useScopedDraft("message", draftScope || null, draftKey);
  const { text, setText } = draft;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      // Stay below the server's seven-day action-ledger retention window.
      const receipt = retrySafe && draftScope ? await requestReceipt(draftScope, draftKey, trimmed, { namespace: "message", maxAgeMs: 6 * 24 * 60 * 60 * 1000 }) : undefined;
      if (!mounted.current) return;
      await onSend(trimmed, { requestId: receipt?.id });
      draft.clearIfUnchanged(text);
      if (receipt && draftScope) clearRequestReceipt(draftScope, draftKey, receipt.id, "message");
    } catch (error) {
      setError(`Sending was not confirmed. Your draft is kept here. Check the conversation before sending again.${error instanceof Error ? ` ${error.message}` : ""}`);
    } finally {
      inFlight.current = false;
      setSending(false);
      if (mounted.current) requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <div className="shrink-0 p-3" style={{ borderTop: "1px solid var(--glass-border)" }}>
      {error && <p role="alert" className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>{error}</p>}
      {draft.error && <p role="status" className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>{draft.error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef} aria-label="Message" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
            if (!enterToSend && !event.metaKey && !event.ctrlKey) return;
            // Touch keyboards keep Enter for line breaks; hardware users may
            // always send with Cmd/Ctrl+Enter.
            if (matchMedia("(pointer: coarse)").matches && !event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            void handleSend();
          }}
          disabled={disabled || sending} placeholder={placeholder || "Write a message…"} rows={2}
          className="flex-1 min-w-0 resize-none rounded-lg px-3 py-2 text-sm"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border-strong)", color: "var(--text-primary)", fontSize: 16, maxHeight: 160, minHeight: 44 }}
        />
        <button type="button" aria-label={sending ? "Sending message" : "Send message"} aria-busy={sending}
          onClick={() => void handleSend()} disabled={disabled || sending || !text.trim()}
          className="rounded-lg flex items-center justify-center shrink-0"
          style={{ width: 44, height: 44, background: "var(--action-bg)", color: "var(--action-fg)" }}>
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>
    </div>
  );
}

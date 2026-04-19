import { useState, useCallback, useRef } from "react";
import { Send, Reply, Mail, Clock, User, Check, X } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { gmailApi } from "../../lib/matrix/client";
import { Button } from "../ui/Button";

type SendStatus = "idle" | "sending" | "sent" | "error";

export default function EmailRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const status = (meta?.status as string) || "received";

  if (status === "draft") {
    return <EmailComposer note={note} />;
  }

  // Render from Parachute note content — email sync stores subject, from, date, and body
  return <VaultEmailView note={note} />;
}

/** Renders an email from Parachute note content — used when Gmail API isn't configured. */
function VaultEmailView({ note }: { note: RendererProps["note"] }) {
  const meta = note.metadata as Record<string, unknown> | null;
  const subject = (meta?.subject as string) || "";
  const from = (meta?.from as string) || "";
  const date = (meta?.date as string) || "";
  const labels = (meta?.labels as string[]) || [];
  const isUnread = meta?.isUnread as boolean;
  const messageCount = (meta?.messageCount as number) || 1;
  const account = (meta?.account as string) || "benjamin@opencivics.co";
  const threadId = (meta?.threadId as string) || (meta?.gmail_id as string) || (meta?.thread_id as string) || "";
  const [showReply, setShowReply] = useState(false);

  // Parse the note content — email_sync stores it as markdown with "# Subject" header
  // and "**From:** ...\n**Date:** ...\n\n---" per message
  const messages = parseEmailContent(note.content, from, date);

  // Build reply metadata
  const replyTo = extractEmail(from);
  const replySubject = subject.startsWith("Re: ") ? subject : `Re: ${subject}`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
        <div className="flex items-center gap-2">
          {isUnread && (
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: "var(--color-accent)" }} />
          )}
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            {subject || "Email"}
          </h2>
        </div>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="flex items-center gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
            <User size={11} /> {from}
          </span>
          {date && (
            <span className="flex items-center gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <Clock size={11} /> {date}
            </span>
          )}
          {messageCount > 1 && (
            <span className="flex items-center gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <Mail size={11} /> {messageCount} messages
            </span>
          )}
        </div>
        <div className="flex gap-2 mt-2">
          {replyTo && (
            <Button size="sm" variant="ghost" icon={<Reply size={14} />}
              onClick={() => setShowReply(true)}>Reply</Button>
          )}
        </div>
        {labels.length > 0 && (
          <div className="flex gap-1.5 mt-2">
            {labels.filter(l => !["INBOX", "UNREAD"].includes(l)).map((label) => (
              <span key={label} className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: "var(--glass)", color: "var(--text-secondary)", border: "1px solid var(--glass-border)" }}>
                {label.replace("CATEGORY_", "").toLowerCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Message bodies */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {messages.length > 0 ? messages.map((msg, i) => (
          <div key={i} className="glass p-4 rounded-lg">
            {msg.from && (
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{msg.from}</span>
                {msg.date && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{msg.date}</span>}
              </div>
            )}
            {msg.body ? (
              <pre className="text-sm whitespace-pre-wrap" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
                {msg.body}
              </pre>
            ) : (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                Email body not yet synced. Full content will appear after the next sync cycle.
              </p>
            )}
          </div>
        )) : (
          <div className="glass p-4 rounded-lg">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Email body not yet synced. Full content will appear after the next sync cycle.
            </p>
          </div>
        )}
      </div>

      {/* Reply bar */}
      {showReply && replyTo && (
        <EmailReplyBar
          account={account}
          to={replyTo}
          subject={replySubject}
          threadId={threadId}
          onSent={() => {}}
          onClose={() => setShowReply(false)}
        />
      )}
    </div>
  );
}

/** Extract a bare email address from a "Name <email>" or plain "email" string. */
function extractEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1];
  // Already a bare email?
  if (raw.includes("@")) return raw.trim();
  return "";
}

/** Inline reply bar — similar to the Matrix MessageComposer but styled for email. */
function EmailReplyBar({
  account,
  to,
  subject,
  threadId,
  onSent,
  onClose,
}: {
  account: string;
  to: string;
  subject: string;
  threadId: string;
  onSent: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSendStatus("sending");
    try {
      const recipient = extractEmail(to) || to;
      await gmailApi.send(account, [recipient], subject, trimmed, undefined, threadId || undefined);
      setSendStatus("sent");
      setBody("");
      onSent();
      // Reset back to idle after a brief success flash
      setTimeout(() => {
        setSendStatus("idle");
        onClose();
      }, 1500);
    } catch {
      setSendStatus("error");
      setTimeout(() => setSendStatus("idle"), 2500);
    }
  }, [account, to, subject, threadId, body, onSent, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="flex-shrink-0 px-4 py-3 space-y-2"
      style={{ borderTop: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
    >
      {/* Reply header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <Reply size={12} />
          <span>Replying to <strong style={{ color: "var(--text-secondary)" }}>{to}</strong></span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Textarea + send */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sendStatus === "sending" || sendStatus === "sent"}
          placeholder="Write your reply..."
          rows={2}
          autoFocus
          className="flex-1 resize-none rounded-xl px-4 py-2 text-sm outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
            maxHeight: 160,
            minHeight: 48,
          }}
        />
        <button
          onClick={handleSend}
          disabled={sendStatus === "sending" || sendStatus === "sent" || !body.trim()}
          className="p-2 rounded-full transition-colors disabled:opacity-30"
          style={{
            background: sendStatus === "sent" ? "var(--color-success)" : sendStatus === "error" ? "var(--color-danger)" : "var(--color-accent)",
            color: "white",
          }}
        >
          {sendStatus === "sending" ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : sendStatus === "sent" ? (
            <Check size={16} />
          ) : (
            <Send size={16} />
          )}
        </button>
      </div>

      {/* Status hint */}
      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
        {sendStatus === "sent" && "Sent!"}
        {sendStatus === "error" && "Failed to send. Try again."}
        {sendStatus === "idle" && (
          <>{navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to send</>
        )}
      </div>
    </div>
  );
}

/** Parse email_sync's markdown content into individual messages. */
function parseEmailContent(content: string, fallbackFrom: string, fallbackDate: string): Array<{ from: string; date: string; body: string }> {
  if (!content) return [{ from: fallbackFrom, date: fallbackDate, body: "" }];

  // email_sync format: "# Subject\n\n**From:** sender\n**Date:** date\n\n---\n\n"
  const sections = content.split("---").filter(s => s.trim());
  const messages: Array<{ from: string; date: string; body: string }> = [];

  for (const section of sections) {
    const lines = section.trim().split("\n");
    let from = fallbackFrom;
    let date = fallbackDate;
    const bodyLines: string[] = [];
    let pastHeader = false;

    for (const line of lines) {
      if (line.startsWith("# ")) continue; // Skip title
      const fromMatch = line.match(/^\*\*From:\*\*\s*(.+)/);
      const dateMatch = line.match(/^\*\*Date:\*\*\s*(.+)/);
      if (fromMatch) { from = fromMatch[1].trim(); continue; }
      if (dateMatch) { date = dateMatch[1].trim(); pastHeader = true; continue; }
      if (pastHeader || (!line.startsWith("**") && line.trim())) {
        pastHeader = true;
        bodyLines.push(line);
      }
    }

    messages.push({ from, date, body: bodyLines.join("\n").trim() });
  }

  return messages.length > 0 ? messages : [{ from: fallbackFrom, date: fallbackDate, body: "" }];
}

function EmailComposer({ note }: { note: RendererProps["note"] }) {
  const meta = note.metadata as Record<string, unknown> | null;
  const [to, setTo] = useState((meta?.to as string[])?.join(", ") || "");
  const [subject, setSubject] = useState((meta?.subject as string) || "");
  const [body, setBody] = useState(note.content || "");
  const [account, setAccount] = useState((meta?.account as string) || "benjamin@opencivics.co");
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    setSending(true);
    try {
      const recipients = to.split(",").map((s) => s.trim()).filter(Boolean);
      await gmailApi.send(account, recipients, subject, body);
    } finally {
      setSending(false);
    }
  }, [account, to, subject, body]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-3 space-y-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>From</label>
          <select value={account} onChange={(e) => setAccount(e.target.value)}
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
            <option value="benjamin@opencivics.co">benjamin@opencivics.co</option>
            <option value="omniharmonicagent@gmail.com">omniharmonicagent@gmail.com</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
        </div>
      </div>
      <div className="flex-1 p-6">
        <textarea value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Write your email here... (plain text only)"
          className="w-full h-full resize-none outline-none text-sm"
          style={{ background: "transparent", color: "var(--text-primary)", fontFamily: "var(--font-sans)" }} />
      </div>
      <div className="flex justify-end px-6 py-3" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <Button variant="primary" icon={<Send size={14} />} onClick={handleSend} loading={sending}>Send</Button>
      </div>
    </div>
  );
}

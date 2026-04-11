import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Archive, Reply } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { gmailApi } from "../../lib/matrix/client";
import type { GmailMessage } from "../../lib/matrix/types";
import { Button } from "../ui/Button";

export default function EmailRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const threadId = (meta?.gmail_id as string) || (meta?.thread_id as string) || "";
  const account = (meta?.account as string) || "";
  const status = (meta?.status as string) || "received";
  const queryClient = useQueryClient();

  // For received emails, fetch thread
  const { data: thread, isLoading } = useQuery({
    queryKey: ["gmail", "thread", account, threadId],
    queryFn: () => gmailApi.getThread(account, threadId),
    enabled: !!threadId && !!account && status !== "draft",
  });

  if (status === "draft") {
    return <EmailComposer note={note} />;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading email...</div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>
          Email thread not found. Configure account and thread ID in metadata.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="px-6 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          {thread.subject}
        </h2>
        <div className="flex gap-2 mt-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<Reply size={14} />}
            onClick={() => {/* TODO: open reply composer */}}
          >
            Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Archive size={14} />}
            onClick={async () => {
              await gmailApi.archive(account, threadId);
              queryClient.invalidateQueries({ queryKey: ["gmail"] });
            }}
          >
            Archive
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {thread.messages.map((msg) => (
          <EmailMessage key={msg.id} message={msg} />
        ))}
      </div>
    </div>
  );
}

function EmailMessage({ message }: { message: GmailMessage }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="glass p-4 rounded-lg">
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {message.fromName || message.from}
          </span>
          <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>
            {message.date}
          </span>
        </div>
        {message.isUnread && (
          <span className="w-2 h-2 rounded-full" style={{ background: "var(--color-accent)" }} />
        )}
      </div>

      {expanded && (
        <div className="mt-3">
          <div className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
            To: {message.to.join(", ")}
            {message.cc && <> · Cc: {message.cc.join(", ")}</>}
          </div>
          <pre
            className="text-sm whitespace-pre-wrap"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}
          >
            {message.body}
          </pre>
        </div>
      )}
    </div>
  );
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
      // TODO: update note status to "sent"
    } finally {
      setSending(false);
    }
  }, [account, to, subject, body]);

  return (
    <div className="flex flex-col h-full">
      {/* Compose header */}
      <div className="px-6 py-3 space-y-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>From</label>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          >
            <option value="benjamin@opencivics.co">benjamin@opencivics.co</option>
            <option value="omniharmonicagent@gmail.com">omniharmonicagent@gmail.com</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>To</label>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs w-12" style={{ color: "var(--text-muted)" }}>Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-6">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your email here... (plain text only)"
          className="w-full h-full resize-none outline-none text-sm"
          style={{
            background: "transparent",
            color: "var(--text-primary)",
            fontFamily: "var(--font-sans)",
          }}
        />
      </div>

      {/* Send bar */}
      <div className="flex justify-end px-6 py-3" style={{ borderTop: "1px solid var(--glass-border)" }}>
        <Button
          variant="primary"
          icon={<Send size={14} />}
          onClick={handleSend}
          loading={sending}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

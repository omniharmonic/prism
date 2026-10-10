import { EmailThreadStatus } from "../comms/EmailThreadStatus";
import { ConversationBack, ConversationOpenPage } from "../comms/conversationChrome";
import "../comms/email-workspace.css";
import { splitEmailQuote } from "../../lib/messages/emailQuote";
import { messageInitials } from "../comms/messageAppearance";
import { AgentConversationSummary, AgentReplyDraft } from "../comms/AgentReplyDraft";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";
import { useState, useCallback, useRef } from "react";
import {
  Send,
  Reply,
  Mail,
  X,
  Archive,
  MailOpen,
  Paperclip,
} from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { gmailApi } from "../../lib/matrix/client";
import { Button } from "../ui/Button";
import {
  useLiveActions,
  useLiveActionsAvailability,
  useLiveActionsClient,
  type LiveActionsState,
} from "../../data/LiveActionsContext";
import {
  liveActionErrorText,
  type LiveActionsClient,
} from "../../lib/actions/client";

import { useIsWeb } from "../../data/Platform";
import { MessageComposer } from "../comms/MessageComposer";
import { parseEmailContent } from "../../lib/messages/emailThread";

export default function EmailRenderer({
  note,
  readOnly = false,
}: RendererProps) {
  readOnly = readOnly || (!!note._caps && !note._caps.includes("edit"));
  const actionClient = useLiveActionsClient();
  const scope = actionClient?.scope?.() || null;
  const meta = note.metadata as Record<string, unknown> | null;
  const status = (meta?.status as string) || "received";

  if (status === "draft") {
    return (
      <EmailComposer
        key={JSON.stringify([scope, note.id])}
        note={note}
        readOnly={readOnly}
      />
    );
  }

  // Render from Parachute note content — email sync stores subject, from, date, and body
  return (
    <VaultEmailView
      key={JSON.stringify([scope, note.id])}
      note={note}
      scope={scope}
      readOnly={readOnly}
    />
  );
}

/** Renders an email from Parachute note content — used when Gmail API isn't configured. */
function VaultEmailView({
  note,
  scope,
  readOnly,
}: {
  note: RendererProps["note"];
  scope: string | null;
  readOnly: boolean;
}) {
  const meta = note.metadata as Record<string, unknown> | null;
  const subject = (meta?.subject as string) || "";
  const from = (meta?.from as string) || "";
  const date = (meta?.date as string) || "";
  const labels = (meta?.labels as string[]) || [];
  const isUnread = meta?.isUnread as boolean;
  const messageCount = (meta?.messageCount as number) || 1;
  const account = (meta?.account as string) || "";
  const threadId =
    (meta?.threadId as string) ||
    (meta?.gmail_id as string) ||
    (meta?.thread_id as string) ||
    "";
  const [showReply, setShowReply] = useState(false);
  const [agentIntent, setAgentIntent] = useState<"reply" | "summary" | null>(null);
  const [agentDock, setAgentDock] = useState<HTMLDivElement | null>(null);
  // Web/native: Proton Bridge via the server (WP1.5 live actions) when it offers
  // email actions and this note is a stored message (it has a Message-ID).
  // Desktop has no provider → `live` is null → the existing Tauri path.
  const { client: liveEmail, state: liveState } =
    useLiveActionsAvailability("email");
  const live =
    !readOnly && liveEmail && typeof meta?.messageId === "string"
      ? liveEmail
      : null;
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [read, setRead] = useState<boolean>(!isUnread);
  const runAction = useCallback(
    async (fn: () => Promise<unknown>, ok: string) => {
      setActionMsg(null);
      try {
        await fn();
        setActionMsg(ok);
      } catch (e) {
        setActionMsg(liveActionErrorText(e));
      }
    },
    [],
  );

  // Parse the note content — email_sync stores it as markdown with "# Subject" header
  // and "**From:** ...\n**Date:** ...\n\n---" per message
  const messages = parseEmailContent(
    note.content,
    from,
    date,
    typeof meta?.source === "string" ? meta.source : undefined,
  );
  const isWeb = useIsWeb();
  const canReply = !readOnly && (!!live || (!isWeb && !!account));
  // Why the mailbox actions are not on offer — shown beside them, in the same
  // row, so a greyed Reply is never the whole story (and never ends up under a
  // phone's bottom bar, where a line below the message did).
  const unavailable = canReply
    ? null
    : emailUnavailableReason({
        readOnly,
        isWeb,
        state: liveState,
        stored: typeof meta?.messageId === "string",
      });

  // Build reply metadata
  // Reply-To wins when stored (the server applies the same rule).
  const replyTo = extractEmail(
    (typeof meta?.replyTo === "string" && meta.replyTo) || from,
  );
  const replySubject = subject.startsWith("Re: ") ? subject : `Re: ${subject}`;

  return (
    <div className="prism-email-workspace">
      <div className="prism-email-layout">
        <div className="prism-email-main">
          {/* Header */}
          <div
            className="prism-email-header"
            style={{
              borderBottom: "1px solid var(--glass-border)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex items-center gap-2">
              <ConversationBack />
              {!read && (
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: "var(--color-accent)" }}
                />
              )}
              <h2
                className="text-lg font-semibold min-w-0 flex-1 break-words"
                style={{ color: "var(--text-primary)" }}
              >
                {subject || "Email"}
              </h2>
              <ConversationOpenPage />
            </div>
            <p className="prism-email-source">
              <Mail size={13} aria-hidden="true" />
              {meta?.source === "proton-bridge" ? "Proton Bridge" : "Email"}
              {messageCount > 1 && <span> · {messageCount} messages</span>}
            </p>
            <EmailThreadStatus note={note} readOnly={readOnly} />
            <div className="flex flex-wrap gap-2 mt-2">
              {replyTo && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Reply size={14} />}
                  disabled={!canReply}
                  aria-describedby={
                    canReply ? undefined : "prism-email-unavailable"
                  }
                  aria-expanded={canReply ? showReply : undefined}
                  onClick={() => setShowReply(true)}
                >
                  Reply
                </Button>
              )}
              {live && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Archive size={14} />}
                    onClick={() =>
                      runAction(
                        () => live.emailArchive({ noteId: note.id }),
                        "Archived",
                      )
                    }
                  >
                    Archive
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<MailOpen size={14} />}
                    onClick={() =>
                      runAction(
                        async () => {
                          await live.emailMarkRead({ noteId: note.id }, !read);
                          setRead(!read);
                        },
                        read ? "Marked unread" : "Marked read",
                      )
                    }
                  >
                    {read ? "Mark unread" : "Mark read"}
                  </Button>
                </>
              )}
              {actionMsg && (
                <span
                  className="text-xs self-center"
                  style={{ color: "var(--text-muted)" }}
                >
                  {actionMsg}
                </span>
              )}
            </div>
            {unavailable && (
              <p
                id="prism-email-unavailable"
                role="status"
                className="prism-email-unavailable"
              >
                {unavailable}
              </p>
            )}
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {labels
                  .filter((l) => !["INBOX", "UNREAD"].includes(l))
                  .map((label) => (
                    <span
                      key={label}
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{
                        background: "var(--glass)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--glass-border)",
                      }}
                    >
                      {label.replace("CATEGORY_", "").toLowerCase()}
                    </span>
                  ))}
              </div>
            )}
          </div>

          {/* Message bodies */}
          <div className="prism-email-messages">
            {messages.length > 0 ? (
              messages.map((msg, i) => {
                const parts = splitEmailQuote(msg.body);
                const attachments = msg.details.filter((detail) =>
                  detail.startsWith("Attachments: "),
                );
                const recipients = msg.details.filter(
                  (detail) => !detail.startsWith("Attachments: "),
                );
                return (
                  <article
                    key={i}
                    className="prism-email-message"
                    aria-label={`Email from ${msg.from || "unknown sender"}`}
                  >
                    <header className="prism-email-author">
                      <span className="prism-email-avatar" aria-hidden="true">
                        {messageInitials(
                          msg.from.replace(/<[^>]*>$/, "").trim() || msg.from,
                        )}
                      </span>
                      <div>
                        <strong>{msg.from || "Sender unavailable"}</strong>
                        {recipients.length > 0 && (
                          <p>{recipients.join("\n")}</p>
                        )}
                      </div>
                      {msg.date && <time>{msg.date}</time>}
                    </header>
                    {msg.body ? (
                      <div className="prism-email-body">
                        <pre>{parts.visible}</pre>
                        {parts.folded && (
                          <details className="prism-email-quoted">
                            <summary className="focus-ring">
                              Show {parts.kind}
                            </summary>
                            <pre>{parts.folded}</pre>
                          </details>
                        )}
                      </div>
                    ) : (
                      <p className="prism-email-empty">
                        Email body not yet synced. Full content will appear
                        after the next sync cycle.
                      </p>
                    )}
                    {attachments.length > 0 && (
                      <section
                        className="prism-email-attachments"
                        aria-label="Attachments listed in source"
                      >
                        {attachments.map((label, index) => (
                          <div key={index}>
                            <Paperclip size={19} aria-hidden="true" />
                            <span>
                              <strong>
                                {label.slice("Attachments: ".length)}
                              </strong>
                              <small>
                                Listed in the imported email. Download is
                                unavailable on this connection.
                              </small>
                            </span>
                          </div>
                        ))}
                      </section>
                    )}
                  </article>
                );
              })
            ) : (
              <div
                className="border p-4 rounded-xl [overflow-wrap:anywhere]"
                style={{ borderColor: "var(--glass-border)" }}
              >
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Email body not yet synced. Full content will appear after the
                  next sync cycle.
                </p>
              </div>
            )}
          </div>

          <AgentConversationSummary
            noteId={note.id}
            title={subject || "Email conversation"}
            dockTarget={agentDock}
            active={agentIntent === "summary"}
            onActivate={() => setAgentIntent("summary")}
          />
          {/* Reply bar */}
          {showReply && replyTo && canReply && (
            <EmailReplyBar
              scope={scope}
              agentDock={agentDock}
              agentActive={agentIntent === "reply"}
              onAgentActivate={() => setAgentIntent("reply")}
              account={account}
              source={typeof meta?.source === "string" ? meta.source : "Email"}
              to={replyTo}
              subject={replySubject}
              threadId={threadId}
              live={live}
              noteId={note.id}
              onSent={() => {
                setActionMsg("Reply sent.");
                setShowReply(false);
              }}
              onClose={() => setShowReply(false)}
            />
          )}
        </div>
        <div ref={setAgentDock} className="prism-email-agent-dock" />
      </div>
    </div>
  );
}

/**
 * One short, plain sentence for why this email cannot be replied to (or
 * archived / marked read) here. The copy follows `liveActionErrorText`.
 */
function emailUnavailableReason({
  readOnly,
  isWeb,
  state,
  stored,
}: {
  readOnly: boolean;
  isWeb: boolean;
  state: LiveActionsState;
  stored: boolean;
}): string {
  if (readOnly) return "You can read this email but not reply to it.";
  if (!isWeb) return "This email has no sending account, so it can't be replied to here.";
  switch (state) {
    case "loading":
      return "Checking whether email can be sent from here…";
    case "disabled":
      return "Replying is turned off on this server.";
    case "unconfigured":
      return "The server has no mail credential yet, so it can't send a reply.";
    case "not-allowed":
      return "Only the server owner can reply to email from Prism.";
    case "unreachable":
      return "Could not reach the server to check whether email can be sent.";
    case "no-client":
      return "Replying to email isn't available on this connection.";
    case "ready":
      return stored
        ? "Replying to this email isn't available."
        : "This email was saved without a message ID, so Prism can't reply to it.";
  }
}

/** Extract a bare email address from a "Name <email>" or plain "email" string. */
function extractEmail(raw: string): string {
  // The LAST angle-addr outside quoted strings / comments, so a display name like
  // `"Eve <eve@evil>" <real@example>` yields the real address (mirrors the
  // server's RFC 5322 parser; the server re-derives and refuses a mismatch).
  let inQuote = false;
  let depth = 0;
  let start = -1;
  let last = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0 && ch === "<") start = i + 1;
    else if (depth === 0 && ch === ">" && start >= 0) {
      last = raw.slice(start, i).trim();
      start = -1;
    }
  }
  if (last) return last;
  // Already a bare email?
  if (raw.includes("@") && !raw.includes("<")) return raw.trim();
  return "";
}

/** A reply uses the same scoped acknowledgement/draft flow as messaging. */
function EmailReplyBar({
  agentDock,
  agentActive,
  onAgentActivate,
  account,
  source,
  to,
  subject,
  threadId,
  live,
  noteId,
  scope,
  onSent,
  onClose,
}: {
  agentDock: HTMLElement | null;
  agentActive: boolean;
  onAgentActivate: () => void;
  account: string;
  source: string;
  to: string;
  subject: string;
  threadId: string;
  live?: LiveActionsClient | null;
  noteId: string;
  scope: string | null;
  onSent: () => void;
  onClose: () => void;
}) {
  const isWeb = useIsWeb();
  const ccDraft = useScopedDraft("email-cc", scope, JSON.stringify([noteId, account, to]));
  const cc = [...new Set(ccDraft.text.split(",").map(value => value.trim()).filter(Boolean))];
  const ccValid = cc.every(address => address.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(address));
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="prism-email-reply" style={{ background: "var(--bg-surface)" }}>
      <div className="flex items-center gap-2 px-4 pt-3 text-xs">
        <Reply size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 break-all">
          Replying to <strong>{to}</strong>
        </span>
        <button
          aria-label="Close email reply"
          onClick={onClose}
          className="interactive focus-ring flex h-10 w-10 items-center justify-center rounded-lg"
        >
          <X size={16} />
        </button>
      </div>
      <div className="space-y-2 px-4 pt-2 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-muted)]">
          <span>From: {live ? "Connected server mailbox" : account}</span>
          <span>Source: {source === "proton-bridge" ? "Proton Bridge" : source}</span>
        </div>
        <label className="flex min-w-0 items-center gap-3"><span className="w-10 shrink-0 text-[var(--text-muted)]">To</span><input aria-label="Reply recipients" readOnly value={to} className="min-h-control min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-transparent px-3 text-sm" /></label>
        <label className="flex min-w-0 items-center gap-3"><span className="w-10 shrink-0 text-[var(--text-muted)]">Cc</span><input aria-label="Reply Cc" value={ccDraft.text} onChange={event => ccDraft.setText(event.target.value)} disabled={submitting} placeholder="Optional addresses, separated by commas" className="min-h-control min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-transparent px-3 text-sm" autoComplete="off" spellCheck={false} /></label>
        {!ccValid && <p role="alert" className="text-[var(--color-danger)]">Enter complete email addresses separated by commas.</p>}
        {ccDraft.error && <p role="status">{ccDraft.error}</p>}
        <details className="text-[var(--text-muted)]"><summary className="cursor-pointer py-1">Reply details</summary><p className="mt-1 break-words">Subject: {subject}</p>{live && account && <p className="mt-1 break-words">Stored email account: {account}. The connected server mailbox determines the sending account.</p>}</details>
      </div>
      <AgentReplyDraft active={agentActive} onActivate={onAgentActivate} dockTarget={agentDock} scope={scope} noteId={noteId} title={subject} draftKey={`email:${JSON.stringify([noteId, account, to])}`} destination={JSON.stringify({ to: [to], cc })} disabled={submitting || !ccValid || (isWeb && !live)} />
      <MessageComposer
        draftScope={scope}
        draftKey={`email:${JSON.stringify([noteId, account, to])}`}
        retrySafe={!!live}
        deliveryContext={JSON.stringify({ to: [to], cc })}
        enterToSend={false}
        focusOnOpen
        placeholder="Write your reply…"
        disabled={isWeb && !live}
        sendDisabled={!ccValid}
        onSend={async (body, options) => {
          if (!ccValid) throw Error("Check Cc addresses before sending.");
          setSubmitting(true);
          try {
          if (live) {
            if (!scope || live.scope?.() !== scope)
              throw new Error(
                "Workspace changed. Reopen the email before replying.",
              );
            await live.emailReply(
              { noteId, expectTo: [to], body, ...(cc.length ? { cc } : {}) },
              { idempotencyKey: options.requestId },
            );
          } else {
            if (isWeb)
              throw new Error("Email is unavailable on this connection.");
            await gmailApi.send(
              account,
              [to],
              subject,
              body,
              cc.length ? cc : undefined,
              threadId || undefined,
            );
          }
          ccDraft.clearIfUnchanged(ccDraft.text);
          onSent();
          } finally { setSubmitting(false); }
        }}
      />
    </div>
  );
}

function EmailComposer({
  note,
  readOnly,
}: {
  note: RendererProps["note"];
  readOnly: boolean;
}) {
  const isWeb = useIsWeb();
  const inFlight = useRef(false);
  const meta = note.metadata as Record<string, unknown> | null;
  const [to, setTo] = useState((meta?.to as string[])?.join(", ") || "");
  const [subject, setSubject] = useState((meta?.subject as string) || "");
  const [body, setBody] = useState(note.content || "");
  const [account, setAccount] = useState((meta?.account as string) || "");
  const [sending, setSending] = useState(false);
  // Web/native: send via the server's Proton Bridge path (WP1.5) — always from
  // the Bridge account, whatever the From picker says. Desktop: Tauri as before.
  const liveEmail = useLiveActions("email");
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    if (
      readOnly ||
      (!isWeb && !account.trim()) ||
      inFlight.current ||
      !to.trim() ||
      !body.trim() ||
      (isWeb && !liveEmail)
    )
      return;
    inFlight.current = true;
    setSending(true);
    setSendError(null);
    try {
      const recipients = to
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (liveEmail)
        await liveEmail.emailSend({ to: recipients, subject, body });
      else await gmailApi.send(account, recipients, subject, body);
    } catch (e) {
      setSendError(liveActionErrorText(e));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, [account, to, subject, body, liveEmail, isWeb, readOnly]);

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      <div
        className="px-6 py-3 space-y-2"
        style={{ borderBottom: "1px solid var(--glass-border)" }}
      >
        <div className="flex items-center gap-2">
          <label
            className="text-xs w-12"
            style={{ color: "var(--text-muted)" }}
          >
            From
          </label>
          {isWeb ? (
            <span
              className="text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              Connected server mailbox
            </span>
          ) : (
            <input
              aria-label="Sending account"
              type="email"
              disabled={readOnly}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="Choose the sending account"
              className="min-h-control min-w-0 flex-1 rounded-lg border px-3 text-sm"
              style={{
                background: "var(--glass)",
                borderColor: "var(--glass-border)",
                color: "var(--text-primary)",
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          <label
            className="text-xs w-12"
            style={{ color: "var(--text-muted)" }}
          >
            To
          </label>
          <input
            aria-label="Email recipients"
            disabled={readOnly}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-primary)",
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <label
            className="text-xs w-12"
            style={{ color: "var(--text-muted)" }}
          >
            Subject
          </label>
          <input
            aria-label="Email subject"
            disabled={readOnly}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 h-7 rounded px-2 text-sm outline-none"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-primary)",
            }}
          />
        </div>
      </div>
      <div className="flex-1 p-6">
        <textarea
          aria-label="Email body"
          readOnly={readOnly}
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
      <div
        className="flex justify-end px-6 py-3"
        style={{ borderTop: "1px solid var(--glass-border)" }}
      >
        <Button
          variant="primary"
          icon={<Send size={14} />}
          onClick={handleSend}
          loading={sending}
          disabled={
            readOnly ||
            (!isWeb && !account.trim()) ||
            !to.trim() ||
            !body.trim() ||
            (isWeb && !liveEmail)
          }
        >
          Send
        </Button>
        {isWeb && !liveEmail && (
          <p role="status" className="text-xs">
            Email sending is unavailable on this connection.
          </p>
        )}
        {sendError && (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {sendError}
          </span>
        )}
      </div>
    </div>
  );
}

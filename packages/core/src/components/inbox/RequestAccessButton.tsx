import { useState } from "react";
import { KeyRound, Check } from "lucide-react";
import { notificationsApi, type AccessLevel } from "../../lib/notifications/client";
import "./inbox.css";

/**
 * "Request access" (NP-CO-13). The server always answers 202 — whether the page
 * exists, whether you already have access — so the UI always says "Request sent"
 * and never learns anything about a page it cannot see. Only a transport failure
 * (offline, server without the route) shows an error.
 */
export function RequestAccessButton({ noteId, level = "view", label, compact = false }: {
  noteId: string;
  level?: AccessLevel;
  label?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const send = async () => {
    setState("sending");
    try {
      await notificationsApi.requestAccess({ noteId, level });
      setState("sent");
    } catch {
      setState("error");
    }
  };
  const text = label ?? (level === "view" ? "Request access" : "Request edit access");
  return (
    <span className={compact ? "prism-request-access-inline" : "prism-request-access"} data-testid="request-access">
      {state === "sent" ? (
        <span role="status" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          <Check size={14} /> Request sent. The owner will be notified.
        </span>
      ) : (
        <button type="button" className="prism-inbox-btn" data-variant={compact ? "outline" : "primary"} disabled={state === "sending"} onClick={() => void send()}>
          <KeyRound size={14} /> {state === "sending" ? "Sending…" : text}
        </button>
      )}
      {state === "error" && <span role="alert" className="text-xs text-[var(--color-danger)]">Couldn’t send the request. Check your connection and try again.</span>}
    </span>
  );
}

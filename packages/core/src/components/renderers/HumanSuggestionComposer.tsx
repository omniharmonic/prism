import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { X } from "lucide-react";
import { HUMAN_COLLAB_LIMITS, type HumanCollabCommand, type HumanCollabResult } from "../../lib/collab/commands";
import {
  captureHumanSelection,
  humanRangeProblem,
  humanTextProblem,
  suggestionTextProblem,
  type CapturedHumanSelection,
} from "../../lib/collab/human/validation";
import { HUMAN_COMMAND_COPY, HumanCommandFailure } from "../../lib/collab/human/failure";

/** How a suggest-only person's changes reach the server (POST /api/collab/:id/commands). */
export interface HumanCommandChannel {
  /** Resolves only on a confirmed 200; throws {@link HumanCommandFailure} otherwise. */
  send(command: HumanCollabCommand): Promise<HumanCollabResult>;
  /** Connected AND synced: a capture taken now matches what the server holds. */
  ready: boolean;
}

export type ComposerKind = "suggest" | "comment";
type SuggestAction = "replace" | "delete" | "before" | "after";
/** Line breaks a suggestion may not carry (incl. U+2028/U+2029): typed or pasted ones become a space. */
const LINE_BREAKS = new RegExp("[\\r\\n\\u2028\\u2029]+", "g");
const ACTIONS: Array<{ id: SuggestAction; label: string }> = [
  { id: "replace", label: "Replace" },
  { id: "delete", label: "Delete" },
  { id: "before", label: "Insert before" },
  { id: "after", label: "Insert after" },
];

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));

/** Message for a failure: the per-code copy, else the server's (safe) message. */
export function humanFailureText(e: unknown): string {
  if (e instanceof HumanCommandFailure) return HUMAN_COMMAND_COPY[e.code] ?? e.message;
  return e instanceof Error && e.message ? e.message : "The change could not be sent.";
}

/**
 * The suggestion / comment composer for people who may SUGGEST but not edit
 * (NP-CO-12). Their live socket is read-only, so nothing they do here touches
 * the shared Y.Doc: the selected range, its exact quote and the document revision
 * are captured together, synchronously, and sent as ONE bounded command that the
 * server authors. Rules it keeps:
 *  - one paragraph, plain single-line text (validated before sending);
 *  - the request is immutable once sent: a retry after an unknown outcome
 *    resends the SAME requestId and body (the server applies it at most once);
 *  - a conflict (409) keeps the text and asks for the passage again — the draft
 *    never silently moves;
 *  - ids are trusted only from a 200.
 */
export function HumanSuggestionComposer({
  editor,
  ydoc,
  channel,
  kind,
  initialAction = "replace",
  anchorRect,
  onClose,
  onDone,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  channel: HumanCommandChannel;
  kind: ComposerKind;
  initialAction?: SuggestAction | "empty";
  anchorRect: { top: number; left: number };
  onClose: () => void;
  onDone: (message: string, result: HumanCollabResult) => void;
}) {
  const [anchor, setAnchor] = useState<CapturedHumanSelection | null>(null);
  const [action, setAction] = useState<SuggestAction | "empty">(initialAction);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<HumanCollabCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  // Capture once, synchronously, when the composer opens (before focus moves).
  const capture = async () => {
    setError("");
    try {
      const captured = await captureHumanSelection(editor, ydoc, kind === "comment" ? "comment" : action === "empty" ? "empty" : "replace", channel.ready);
      setAnchor(captured);
      return captured;
    } catch (e) {
      setAnchor(null);
      setError(e instanceof Error ? e.message : "Select a passage first.");
      return null;
    }
  };
  useEffect(() => {
    void capture().then(() => input.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The range this action targets, from the ONE captured anchor. */
  const rangeFor = (a: CapturedHumanSelection, act: SuggestAction | "empty") =>
    act === "before" ? { from: a.from, to: a.from } : act === "after" ? { from: a.to, to: a.to } : { from: a.from, to: a.to };

  const problem = (() => {
    if (!anchor) return null;
    if (kind === "comment") {
      if (!text.trim()) return null;
      if (text.length > HUMAN_COLLAB_LIMITS.commentText) return "Keep comments within 4,000 characters.";
      return humanTextProblem(text, "comment");
    }
    const { from, to } = rangeFor(anchor, action);
    const range = from === to ? humanRangeProblem(anchor.doc, from, to, "suggest") : null;
    if (range) return range;
    if (action === "delete") return null;
    if (!text) return null;
    return suggestionTextProblem({ ...anchor, from, to }, text);
  })();
  const empty = kind === "comment" ? !text.trim() : action !== "delete" && !text;

  async function submit(retry: boolean) {
    if (lock.current) return;
    if (!channel.ready) return setError(HUMAN_COMMAND_COPY.not_ready!);
    let command = retry ? pending : null;
    if (!command) {
      if (!anchor || problem || empty) return;
      const { from, to } = rangeFor(anchor, action);
      const base = { requestId: uuid(), createdAt: Date.now(), revision: anchor.revision };
      command =
        kind === "comment"
          ? { ...base, kind: "comment", from: anchor.from, to: anchor.to, quote: anchor.quote, text: text.trim() }
          : { ...base, kind: "suggest", from, to, quote: anchor.doc.textBetween(from, to, "\n", "￼"), text: action === "delete" ? "" : text };
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setCanRetry(false);
    setPending(command);
    try {
      const result = await channel.send(command);
      setPending(null);
      onDone(kind === "comment" ? "Comment added." : "Suggestion sent for review.", result);
    } catch (e) {
      setError(humanFailureText(e));
      if (e instanceof HumanCommandFailure && e.retrySame) {
        setCanRetry(true); // keep `pending`: the retry resends this exact request
      } else {
        setPending(null);
        if (e instanceof HumanCommandFailure && e.needsReanchor) setAnchor(null);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const single = kind === "suggest";
  const quoteShown = anchor ? (kind === "comment" || action === "replace" || action === "delete" ? anchor.originalQuote : anchor.originalQuote) : "";
  return (
    <div
      role="dialog"
      aria-label={kind === "comment" ? "Comment on selection" : "Suggest an edit"}
      className="prism-human-composer"
      data-revision-parity={anchor?.parity}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        top: Math.min(anchorRect.top, (typeof window !== "undefined" ? window.innerHeight : 800) - 300),
        left: anchorRect.left,
        zIndex: 60,
        width: "min(340px, calc(100vw - 16px))",
        padding: 12,
        borderRadius: 12,
        border: "1px solid var(--glass-border)",
        background: "var(--bg-surface, #1a1a1f)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.3)",
        display: "grid",
        gap: 10,
        fontSize: 13,
        color: "var(--text-primary)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>{kind === "comment" ? "Comment" : "Suggest an edit"}</strong>
        <button type="button" aria-label="Close" onClick={onClose} style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
          <X size={15} />
        </button>
      </div>
      {anchor ? (
        quoteShown && (
          <blockquote style={{ margin: 0, padding: "4px 8px", borderLeft: "2px solid var(--color-accent)", color: "var(--text-secondary)", maxHeight: 72, overflow: "auto", overflowWrap: "anywhere" }}>
            {quoteShown}
          </blockquote>
        )
      ) : (
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>Select the passage again{text ? " — your text is kept" : ""}.</p>
      )}
      {single && anchor && action !== "empty" && (
        <div role="radiogroup" aria-label="Kind of change" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={action === a.id}
              disabled={!!pending}
              onClick={() => setAction(a.id)}
              style={{ minHeight: 30, padding: "4px 9px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: `1px solid ${action === a.id ? "var(--color-accent)" : "var(--glass-border)"}`, background: action === a.id ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent", color: action === a.id ? "var(--color-accent)" : "var(--text-secondary)", fontWeight: action === a.id ? 600 : 500 }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {(kind === "comment" || action !== "delete") &&
        (single ? (
          <input
            ref={input}
            aria-label={action === "replace" ? "Replacement text" : "Text to insert"}
            value={text}
            disabled={!!pending}
            maxLength={HUMAN_COLLAB_LIMITS.text}
            onChange={(e) => setText(e.target.value.replace(LINE_BREAKS, " "))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit(false);
              }
            }}
            placeholder={action === "replace" ? "Replace with…" : "Text to insert…"}
            style={{ minHeight: 36, fontSize: 16, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--glass-border)", background: "var(--glass, transparent)", color: "var(--text-primary)", outline: "none" }}
          />
        ) : (
          <textarea
            ref={input}
            aria-label="Comment"
            rows={3}
            value={text}
            disabled={!!pending}
            maxLength={HUMAN_COLLAB_LIMITS.commentText}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(false);
            }}
            placeholder="Add a comment…"
            style={{ resize: "vertical", fontSize: 16, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--glass-border)", background: "var(--glass, transparent)", color: "var(--text-primary)", outline: "none" }}
          />
        ))}
      {single && anchor && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>One paragraph at a time, a single line. An editor reviews it before it changes the page.</p>}
      {problem && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--color-danger, #ef4444)" }}>{problem}</p>}
      {error && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--color-danger, #ef4444)" }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        {!anchor && !pending && (
          <button type="button" onClick={() => void capture()} style={{ minHeight: 32, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--glass-border)", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: 12.5 }}>
            Use current selection
          </button>
        )}
        {canRetry && pending ? (
          <button type="button" disabled={busy} onClick={() => void submit(true)} style={{ minHeight: 32, padding: "5px 12px", borderRadius: 7, border: "none", background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)", fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !anchor || !!problem || empty || !channel.ready}
            onClick={() => void submit(false)}
            style={{ minHeight: 32, padding: "5px 12px", borderRadius: 7, border: "none", background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)", fontWeight: 600, cursor: "pointer", fontSize: 12.5, opacity: busy || !anchor || !!problem || empty || !channel.ready ? 0.5 : 1 }}
          >
            {busy ? "Sending…" : kind === "comment" ? "Comment" : "Suggest"}
          </button>
        )}
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";
import { humanCollabRevision, type HumanCollabCommand, type HumanCollabSend } from "../../lib/collab/commands";
export interface HumanCommands { send: HumanCollabSend; enabled: boolean; scope: string | null; noteId: string }
type Anchor = Pick<HumanCollabCommand, "from" | "to" | "quote" | "revision">;
interface Draft { text: string; kind: "suggest" | "comment"; anchor?: Anchor; pending?: HumanCollabCommand }
const EMPTY: Draft = { text: "", kind: "suggest" };
export function HumanSuggestionComposer({ editor, ydoc, commands }: { editor: Editor; ydoc: Y.Doc; commands: HumanCommands }) {
  const saved = useScopedDraft("human-suggestion", commands.scope, commands.noteId);
  let draft: Draft = EMPTY;
  try { const parsed = JSON.parse(saved.text); if (parsed && typeof parsed.text === "string" && ["suggest", "comment"].includes(parsed.kind)) draft = parsed; } catch { /* empty or unavailable draft */ }
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const capture = async (kind: Draft["kind"]) => {
    if (lock.current || draft.pending) return;
    const { from, to } = editor.state.selection;
    const doc = editor.state.doc;
    const quote = doc.textBetween(from, to, "\n", "\ufffc");
    if (kind === "comment" && from === to) { setError("Select text in the document before adding a comment."); return; }
    if (quote.length > 10_000) { setError("Select a passage of at most 10,000 characters."); return; }
    lock.current = true; setBusy(true);
    try {
      const revision = await humanCollabRevision(doc.toJSON(), ydoc.getMap("comments").toJSON());
      saved.setText(JSON.stringify({ ...draft, kind, anchor: { from, to, quote, revision } }));
      setError(""); setNotice("");
    } finally { lock.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (lock.current || !commands.enabled || !draft.anchor && !draft.pending) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    const command = draft.pending ?? { ...draft.anchor!, requestId: crypto.randomUUID(), createdAt: Date.now(), kind: draft.kind, text: draft.text };
    const pendingText = JSON.stringify({ ...draft, pending: command });
    try {
      if (!saved.setText(pendingText)) throw new Error("Keep this draft open. Local request storage must be available before submitting safely.");
      await commands.send(command);
      saved.clearIfUnchanged(pendingText);
      setNotice(command.kind === "comment" ? "Comment added." : "Suggested change submitted for review.");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if ([400, 401, 403, 404, 409].includes(status ?? 0)) saved.setText(JSON.stringify({ text: draft.text, kind: draft.kind }));
      setError(e instanceof Error ? e.message : "Could not confirm this change. Retry the same request.");
    } finally { lock.current = false; setBusy(false); }
  };
  const editing = !!draft.anchor || !!draft.pending || !!draft.text;
  const insertion = draft.anchor?.from === draft.anchor?.to;
  return <section className="my-4 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--glass-border)", background: "var(--bg-surface)" }} aria-label="Suggest changes">
    <p className="mb-3">Select a passage to suggest a replacement or deletion, or place the cursor to insert text. Changes need an editor’s review.</p>
    <div className="flex flex-wrap gap-2">
      <button className="focus-ring rounded-lg border px-3 py-2" disabled={busy || !!draft.pending || !commands.enabled} onMouseDown={e => e.preventDefault()} onClick={() => void capture("suggest")}>{draft.anchor ? "Use current selection" : "Suggest a change"}</button>
      <button className="focus-ring rounded-lg border px-3 py-2" disabled={busy || !!draft.pending || !commands.enabled} onMouseDown={e => e.preventDefault()} onClick={() => void capture("comment")}>Comment on selection</button>
    </div>
    {editing && <div className="mt-3 space-y-3">
      {draft.anchor && <div><strong>{draft.kind === "comment" ? "Comment on" : insertion ? "Insert at cursor" : "Selected text"}</strong><blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 pl-3">{draft.anchor.quote || "No text will be removed."}</blockquote></div>}
      {!draft.anchor && !draft.pending && <p role="status">Your draft is kept. Select the current passage and review it again before submitting.</p>}
      <label className="block">{draft.kind === "comment" ? "Comment" : "Proposed text"}<textarea className="mt-1 w-full rounded-lg border p-3 text-base" rows={3} maxLength={10_000} value={draft.text} disabled={busy || !!draft.pending} onChange={e => saved.setText(JSON.stringify({ ...draft, text: e.target.value }))} /></label>
      {draft.kind === "suggest" && draft.anchor && <p>{draft.text ? (insertion ? "Insert the proposed text as a suggestion." : "Mark the selected text for deletion and insert the proposed replacement.") : (insertion ? "Enter text to insert." : "Leave proposed text empty to suggest deleting this passage.")}</p>}
      {draft.pending && <p>Awaiting confirmation. Retry checks the same request and will not submit a duplicate.</p>}
      <button className="focus-ring rounded-lg border px-3 py-2" disabled={busy || !commands.enabled || !draft.anchor && !draft.pending || !draft.pending && (!draft.text && (draft.kind === "comment" || insertion))} onClick={() => void submit()}>{busy ? "Submitting…" : draft.pending ? "Check submission" : draft.kind === "comment" ? "Add comment" : "Submit suggestion"}</button>
      {!draft.pending && <button className="focus-ring ml-2 rounded-lg px-3 py-2" disabled={busy} onClick={() => { saved.setText(""); setError(""); }}>Discard draft</button>}
    </div>}
    {!commands.enabled && <p className="mt-2" role="status">Reconnect before submitting. Your draft stays here.</p>}
    {(error || saved.error) && <p className="mt-2" role="alert">{error || saved.error}</p>}
    {notice && <p className="mt-2" role="status">{notice}</p>}
  </section>;
}

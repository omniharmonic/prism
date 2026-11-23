/**
 * What a live-editor page falls back to when the server answers `too_complex`:
 * the note's body is too large or complex to convert for the live editor.
 *
 * The server opens NO live document for such a note, so nothing reaches this
 * device's Yjs state. The stored note is intact and the plain REST path works on
 * it: this view reads it (GET /notes/:id), shows it as plain text — never parsed
 * as Markdown or HTML here either — and, for people who may edit, offers a plain
 * text editor that saves with a compare-and-set PATCH. Fixing the content (or
 * splitting the page) is what brings the live editor back.
 */
import { leafTitle } from "@prism/core/pages";
import { useCallback, useEffect, useState } from "react";
import { htmlToText } from "@prism/core/import-export";
import { serverFetch } from "../transport";
import { apiBase } from "../config";
import { captureWriteContext } from "../offline/writeScope";

/** A body stored by the live editor is HTML; anything else is Markdown / text. */
const isStoredHtml = (s: string) => s.trim().startsWith("<");
/** Above this the text is shown cut (the editor always gets the whole body). */
const SHOW_MAX = 400_000;

type Loaded = { content: string; updatedAt: string | null; title: string };

export function PlainTextPage({ noteId, canEdit, embedded, onOpenLive }: { noteId: string; canEdit: boolean; embedded: boolean; onOpenLive: () => void }) {
  const [note, setNote] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { headers } = await captureWriteContext();
      const r = await serverFetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, { headers, cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const n = (await r.json()) as { content?: string; updatedAt?: string | null; path?: string | null; metadata?: { title?: unknown } | null };
      const title = (typeof n.metadata?.title === "string" && n.metadata.title) || leafTitle(n.path, n.metadata) || "Page";
      setNote({ content: n.content ?? "", updatedAt: n.updatedAt ?? null, title });
    } catch {
      setError("This page could not be loaded. Check your connection and try again.");
    }
  }, [noteId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!note || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { headers } = await captureWriteContext();
      const r = await serverFetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ content: draft, ...(note.updatedAt ? { if_updated_at: note.updatedAt } : {}) }),
      });
      if (r.status === 409 || r.status === 428) {
        setError("This page changed somewhere else while you were editing. Copy your text, then reload the page.");
        return;
      }
      if (!r.ok) {
        setError(r.status === 403 ? "You can't edit this page." : "Your changes could not be saved. Try again.");
        return;
      }
      const n = (await r.json()) as { updatedAt?: string | null };
      setNote({ ...note, content: draft, updatedAt: n.updatedAt ?? null });
      setEditing(false);
      setSaved(true);
    } catch {
      setError("Your changes could not be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const shown = note ? (isStoredHtml(note.content) ? htmlToText(note.content) : note.content) : "";
  const button: React.CSSProperties = { height: 34, padding: "0 14px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle, #3334)", background: "transparent", color: "var(--text-primary)", fontSize: "var(--text-sm)", cursor: "pointer" };
  const primary: React.CSSProperties = { ...button, border: "none", background: "var(--color-accent)", color: "#fff", fontWeight: 550 };

  return (
    <div data-testid="plain-text-page" style={{ minHeight: embedded ? "40vh" : "100dvh", padding: "24px 16px", background: "var(--bg-base)" }}>
      <div style={{ maxWidth: "var(--page-max-width, 1080px)", margin: "0 auto" }}>
        <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>{note?.title ?? "Page"}</h1>
        <div role="status" style={{ marginTop: 12, padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle, #3334)", color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
          This page is too large or complex for the live editor, so it is shown as plain text. Nothing in it has been changed.
          {canEdit ? " You can edit it as plain text — shortening or splitting it brings the live editor back." : ""}
          {note && isStoredHtml(note.content) ? " This page's stored format is HTML: the text is shown here, and the plain-text editor shows its HTML source." : ""}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {canEdit && note && !editing && (
            <button type="button" style={primary} onClick={() => { setDraft(note.content); setSaved(false); setEditing(true); }}>
              Edit as plain text
            </button>
          )}
          {editing && (
            <>
              <button type="button" style={primary} disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
              <button type="button" style={button} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </>
          )}
          {!editing && <button type="button" style={button} onClick={onOpenLive}>{saved ? "Open in the live editor" : "Try the live editor again"}</button>}
        </div>
        {error && <p role="alert" style={{ marginTop: 12, color: "var(--color-danger, #ef4444)", fontSize: "var(--text-sm)" }}>{error}</p>}
        {saved && !editing && <p role="status" style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>Saved.</p>}
        {!note && !error && <p role="status" style={{ marginTop: 16, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>Loading…</p>}
        {note && editing && (
          <textarea
            aria-label="Page content as plain text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            style={{ marginTop: 14, width: "100%", minHeight: "60vh", padding: 12, borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle, #3334)", background: "var(--surface, transparent)", color: "var(--text-primary)", font: "13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace", resize: "vertical" }}
          />
        )}
        {note && !editing && (
          <pre data-testid="plain-text-body" style={{ marginTop: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-primary)", font: "14px/1.6 var(--font-sans, system-ui)", userSelect: "text" }}>
            {shown.length > SHOW_MAX ? `${shown.slice(0, SHOW_MAX)}\n\n… (${(shown.length - SHOW_MAX).toLocaleString()} more characters — use “Edit as plain text” to see everything)` : shown}
          </pre>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import { marked } from "marked";
import { sanitizeHtml } from "@prism/core";
import { GATEWAY_ORIGIN } from "../config";

/**
 * Public, anonymous, read-only view of a PUBLICATION (Horizon B). The human URL
 * is /p/:slug (a client route; this component). It fetches the publication
 * manifest + per-note content from the same-origin gateway at /api/p/*, which
 * authorizes every read through `effectiveLevel` server-side — the browser holds
 * no token and can only ever see notes inside the publication.
 *
 * P1 spine: title + a flat note nav + the selected note rendered as sanitized
 * HTML (wikilinks flattened to plain text). The richer Wiki template (renderer
 * parity, backlinks, scoped wikilink navigation, search, graph) lands in P2.
 */

interface NavNote {
  id: string;
  title: string;
  path: string | null;
  tags: string[];
}
interface Manifest {
  slug: string;
  title: string;
  template: string;
  theme: unknown | null;
  homeNoteId: string | null;
  passwordRequired: boolean;
  notes: NavNote[];
}
interface PubNote {
  id: string;
  content: string;
  path: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  title: string;
}

const api = (path: string) => `${GATEWAY_ORIGIN}/api/p${path}`;

export function PublicationView({ slug, noteId }: { slug: string; noteId: string | null }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(noteId);
  const [note, setNote] = useState<PubNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);

  // Load the manifest once per slug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}`));
        if (!r.ok) {
          if (!cancelled) setError(r.status === 404 ? "This publication doesn’t exist." : "Couldn’t load this publication.");
          return;
        }
        const m = (await r.json()) as Manifest;
        if (cancelled) return;
        setManifest(m);
        setActiveId((cur) => cur ?? m.homeNoteId ?? m.notes[0]?.id ?? null);
      } catch {
        if (!cancelled) setError("Couldn’t reach the server.");
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  // Load the active note's content whenever it changes.
  useEffect(() => {
    if (!activeId) { setNote(null); return; }
    let cancelled = false;
    setNoteLoading(true);
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}/notes/${encodeURIComponent(activeId)}`));
        if (!r.ok) { if (!cancelled) setNote(null); return; }
        const n = (await r.json()) as PubNote;
        if (!cancelled) setNote(n);
      } catch {
        if (!cancelled) setNote(null);
      } finally {
        if (!cancelled) setNoteLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug, activeId]);

  // Navigate within the publication without a full reload (keeps the URL honest
  // so links/back work). Wikilinks remain flattened in P1.
  const open = useCallback((id: string) => {
    setActiveId(id);
    try {
      window.history.pushState(null, "", `/p/${encodeURIComponent(slug)}/notes/${encodeURIComponent(id)}`);
    } catch { /* ignore */ }
  }, [slug]);

  // Honor browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/p\/[^/]+\/notes\/(.+)$/);
      setActiveId(m ? decodeURIComponent(m[1]) : (manifest?.homeNoteId ?? manifest?.notes[0]?.id ?? null));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [manifest]);

  if (error) {
    return (
      <Centered>
        <p style={{ color: "var(--text-secondary, #aaa)" }}>{error}</p>
      </Centered>
    );
  }
  if (!manifest) {
    return <Centered><p style={{ color: "var(--text-muted, #888)" }}>Loading…</p></Centered>;
  }

  const html = note ? sanitizeHtml(renderBody(note.content)) : "";

  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
          fontWeight: 600,
          fontSize: 15,
        }}
      >
        {manifest.title}
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
            overflowY: "auto",
            padding: "12px 8px",
          }}
        >
          {manifest.notes.map((n) => (
            <button
              key={n.id}
              onClick={() => open(n.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 6,
                border: "none",
                background: n.id === activeId ? "var(--glass-hover, rgba(255,255,255,0.08))" : "transparent",
                color: n.id === activeId ? "var(--text-primary, #fff)" : "var(--text-secondary, #bbb)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {n.title}
            </button>
          ))}
          {manifest.notes.length === 0 && (
            <p style={{ color: "var(--text-muted, #777)", fontSize: 12, padding: "6px 10px" }}>No published notes.</p>
          )}
        </nav>
        <main style={{ flex: 1, overflowY: "auto", padding: "0 24px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 0 96px" }}>
            {noteLoading && <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>}
            {!noteLoading && note && (
              <article className="prose-editor" dangerouslySetInnerHTML={{ __html: html }} />
            )}
            {!noteLoading && !note && activeId && (
              <p style={{ color: "var(--text-secondary, #aaa)" }}>This note isn’t available.</p>
            )}
            <footer
              style={{
                marginTop: 64,
                paddingTop: 16,
                borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                fontSize: 12,
                color: "var(--text-muted, #777)",
              }}
            >
              Published via Prism
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>{children}</div>
  );
}

/** Render note body to HTML. HTML content passes through (sanitized by caller);
 *  markdown is converted. Wikilinks collapse to plain text in P1 (scoped
 *  in-publication navigation arrives with the P2 Wiki template). */
function renderBody(content: string): string {
  const c = content ?? "";
  if (c.trim().startsWith("<")) return c;
  const flattened = c.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, name?: string) => name || target.split("/").pop() || target,
  );
  return marked.parse(flattened) as string;
}

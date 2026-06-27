import { Suspense, useCallback, useEffect, useState } from "react";
import { GATEWAY_ORIGIN } from "../config";
import { getTemplate } from "./templates/registry";
import type { PubGraph, PubNote, PublicationManifest } from "./templates/types";

/**
 * Public, anonymous, read-only view of a PUBLICATION (Horizon B). The human URL
 * is /p/:slug (a client route; this component). It fetches the publication
 * manifest + per-note content + the publication-scoped graph from the
 * same-origin gateway at /api/p/*, which authorizes every read server-side via
 * `effectiveLevel` — the browser holds no token and can only ever see notes
 * inside the publication.
 *
 * This component is the DATA SHELL: it owns fetching, the active-note + URL
 * state, popstate handling, and a (placeholder) password-required awareness. All
 * presentation lives in a template selected from the registry by
 * `manifest.template` (default: "wiki"), so new templates drop in without
 * touching this shell.
 */

const api = (path: string) => `${GATEWAY_ORIGIN}/api/p${path}`;

export function PublicationView({ slug, noteId }: { slug: string; noteId: string | null }) {
  const [manifest, setManifest] = useState<PublicationManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(noteId);
  const [note, setNote] = useState<PubNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [graph, setGraph] = useState<PubGraph | null>(null);

  // Load the manifest once per slug.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}`));
        if (!r.ok) {
          if (!cancelled)
            setError(
              r.status === 404
                ? "This publication doesn’t exist."
                : "Couldn’t load this publication.",
            );
          return;
        }
        const m = (await r.json()) as PublicationManifest;
        if (cancelled) return;
        setManifest(m);
        setActiveId((cur) => cur ?? m.homeNoteId ?? m.notes[0]?.id ?? null);
      } catch {
        if (!cancelled) setError("Couldn’t reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Load the publication-scoped graph once per slug (drives backlinks). Best
  // effort — a missing graph just means no backlinks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}/graph`));
        if (!r.ok) return;
        const g = (await r.json()) as PubGraph;
        if (!cancelled) setGraph(g);
      } catch {
        /* no backlinks without a graph */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Load the active note's content whenever it changes.
  useEffect(() => {
    if (!activeId) {
      setNote(null);
      return;
    }
    let cancelled = false;
    setNoteLoading(true);
    (async () => {
      try {
        const r = await fetch(
          api(`/${encodeURIComponent(slug)}/notes/${encodeURIComponent(activeId)}`),
        );
        if (!r.ok) {
          if (!cancelled) setNote(null);
          return;
        }
        const n = (await r.json()) as PubNote;
        if (!cancelled) setNote(n);
      } catch {
        if (!cancelled) setNote(null);
      } finally {
        if (!cancelled) setNoteLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, activeId]);

  // Navigate within the publication without a full reload (keeps the URL honest
  // so links/back work).
  const onNavigate = useCallback(
    (id: string) => {
      setActiveId(id);
      try {
        window.history.pushState(
          null,
          "",
          `/p/${encodeURIComponent(slug)}/notes/${encodeURIComponent(id)}`,
        );
      } catch {
        /* ignore */
      }
      // Scroll the article back to top on navigation.
      try {
        window.scrollTo({ top: 0 });
      } catch {
        /* ignore */
      }
    },
    [slug],
  );

  // Honor browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/p\/[^/]+\/notes\/(.+)$/);
      setActiveId(
        m
          ? decodeURIComponent(m[1])
          : manifest?.homeNoteId ?? manifest?.notes[0]?.id ?? null,
      );
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
    return (
      <Centered>
        <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>
      </Centered>
    );
  }

  // Placeholder for password-gated publications: the gateway already enforces
  // access, but a future UI can prompt here when `manifest.passwordRequired`.
  // TODO(L-Pub-Wiki): render a password prompt screen when the server adds the
  // unlock endpoint.

  const Template = getTemplate(manifest.template);

  return (
    <Suspense fallback={<Centered><p style={{ color: "var(--text-muted, #888)" }}>Loading…</p></Centered>}>
      <Template
        manifest={manifest}
        slug={slug}
        activeId={activeId}
        note={note}
        noteLoading={noteLoading}
        onNavigate={onNavigate}
        graph={graph}
      />
    </Suspense>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      {children}
    </div>
  );
}

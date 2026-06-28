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
  // Password gate: the server marks `passwordRequired` and, while locked,
  // withholds the nav (notes: []) and 401s the note/graph reads. We surface a
  // prompt; a successful unlock sets an httpOnly cookie, after which we bump
  // `reloadKey` to re-fetch everything. `locked` drives whether to show it.
  const [locked, setLocked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Load the manifest once per slug (and after a successful unlock).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}`), { credentials: "include" });
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
        // Locked when password-gated and the server withheld the nav.
        const isLocked = m.passwordRequired && m.notes.length === 0;
        setLocked(isLocked);
        if (!isLocked) setActiveId((cur) => cur ?? m.homeNoteId ?? m.notes[0]?.id ?? null);
      } catch {
        if (!cancelled) setError("Couldn’t reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, reloadKey]);

  // Load the publication-scoped graph once per slug (drives backlinks). Best
  // effort — a missing graph just means no backlinks.
  useEffect(() => {
    if (locked) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}/graph`), { credentials: "include" });
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
  }, [slug, locked, reloadKey]);

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
          { credentials: "include" },
        );
        if (!r.ok) {
          // A 401 on a password-gated publication means the unlock lapsed —
          // fall back to the prompt rather than showing an empty article.
          if (!cancelled) {
            setNote(null);
            if (r.status === 401) setLocked(true);
          }
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
  }, [slug, activeId, reloadKey]);

  // Submit the publication password; on success the server sets the unlock
  // cookie and we re-fetch everything via `reloadKey`.
  const onUnlock = useCallback(
    async (password: string): Promise<boolean> => {
      try {
        const r = await fetch(api(`/${encodeURIComponent(slug)}/auth`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ password }),
        });
        if (!r.ok) return false;
        setLocked(false);
        setReloadKey((k) => k + 1);
        return true;
      } catch {
        return false;
      }
    },
    [slug],
  );

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

  // Password-gated and still locked: show the unlock prompt instead of the
  // (withheld) publication. A correct password sets the cookie + re-fetches.
  if (locked) {
    return <PasswordGate title={manifest.title} onUnlock={onUnlock} />;
  }

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

/** Centered unlock prompt for a password-gated publication. */
function PasswordGate({
  title,
  onUnlock,
}: {
  title: string;
  onUnlock: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setWrong(false);
    const ok = await onUnlock(password);
    if (!ok) {
      setWrong(true);
      setBusy(false);
    }
    // On success the parent re-fetches and unmounts this component.
  };

  return (
    <Centered>
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "min(320px, 100%)",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary, #eee)", margin: 0 }}>
          {title}
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary, #aaa)", margin: 0 }}>
          This publication is password protected.
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          style={{
            padding: "10px 12px",
            fontSize: 16,
            borderRadius: 8,
            border: "1px solid var(--border, #333)",
            background: "var(--bg-input, var(--bg-secondary, #1a1a1a))",
            color: "var(--text-primary, #eee)",
            outline: "none",
          }}
        />
        {wrong && (
          <p style={{ fontSize: 13, color: "var(--accent-danger, #e5484d)", margin: 0 }}>
            Incorrect password.
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          style={{
            padding: "10px 12px",
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 8,
            border: "none",
            cursor: busy || !password ? "default" : "pointer",
            opacity: busy || !password ? 0.6 : 1,
            background: "var(--accent, #4f8cff)",
            color: "var(--accent-fg, #fff)",
          }}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </Centered>
  );
}

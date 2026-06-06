import { useEffect, useState } from "react";
import { marked } from "marked";
import { loadConnection, DEFAULT_VAULT_URL, DEFAULT_VAULT_NAME } from "../config";

/**
 * Read-only public view of a single note — the "share a link like a Google Doc"
 * surface. No app chrome, no login required (when the vault serves it publicly).
 *
 * Resolution order:
 *   1. Parachute's public published-note endpoint `GET /vault/{name}/view/{id}`
 *      (returns rendered HTML, no auth) — the intended public path.
 *   2. An authenticated read via the viewer's own stored connection (owner
 *      preview / collaborators who already have access).
 *
 * NOTE: truly anonymous sharing depends on the vault exposing `/view` publicly.
 * On vaults where it 401s, only path (2) succeeds. See the repo plan/README.
 */
export function ShareView({ noteId }: { noteId: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; html: string; title: string }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const conn = loadConnection();
      const vaultUrl = conn?.vaultUrl ?? DEFAULT_VAULT_URL;
      const vaultName = conn?.vaultName ?? DEFAULT_VAULT_NAME;

      // 1. Public published-note endpoint (no auth).
      try {
        const pub = await fetch(
          `${vaultUrl}/vault/${vaultName}/view/${encodeURIComponent(noteId)}`,
        );
        if (pub.ok) {
          const ct = pub.headers.get("content-type") ?? "";
          const body = await pub.text();
          if (!cancelled) {
            setState({
              status: "ok",
              title: deriveTitle(body),
              html: ct.includes("html") ? body : renderMarkdown(body),
            });
          }
          return;
        }
      } catch {
        /* fall through to authenticated read */
      }

      // 2. Authenticated read (viewer has access).
      if (conn) {
        try {
          const r = await fetch(
            `${vaultUrl}/vault/${vaultName}/api/notes/${encodeURIComponent(noteId)}`,
            { headers: { Authorization: `Bearer ${conn.token}` } },
          );
          if (r.ok) {
            const note = await r.json();
            if (!cancelled) {
              const name = (note.path || "").split("/").pop() || noteId;
              setState({ status: "ok", title: name, html: renderMarkdown(note.content || "") });
            }
            return;
          }
        } catch {
          /* fall through to error */
        }
      }

      if (!cancelled) {
        setState({
          status: "error",
          message:
            "This note isn’t publicly available. The vault owner needs to publish it (Parachute public view).",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  return (
    <div style={{ minHeight: "100dvh", padding: "0 16px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 0 96px" }}>
        {state.status === "loading" && (
          <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>
        )}
        {state.status === "error" && (
          <p style={{ color: "var(--text-secondary, #aaa)" }}>{state.message}</p>
        )}
        {state.status === "ok" && (
          <article
            className="prose-editor"
            dangerouslySetInnerHTML={{ __html: state.html }}
          />
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
          Shared via Prism
        </footer>
      </div>
    </div>
  );
}

/** Render markdown to HTML, collapsing `[[target|name]]` wikilinks to plain text
 *  (the public viewer can't navigate into the vault). */
function renderMarkdown(md: string): string {
  const clean = md.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, name?: string) => name || target.split("/").pop() || target,
  );
  return marked.parse(clean) as string;
}

/** Best-effort title: first markdown/HTML heading, else the first line. */
function deriveTitle(body: string): string {
  const md = body.match(/^#\s+(.+)$/m);
  if (md) return md[1].trim();
  const h = body.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h) return h[1].replace(/<[^>]+>/g, "").trim();
  return "Shared note";
}

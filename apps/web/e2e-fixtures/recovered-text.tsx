/**
 * "Recovered text" fixture: the real RecoveredText card and the live document's
 * "Recover text" link over an in-page fake of the owner routes (fictional data).
 *
 *   (default)   the card, as Network → Server mounts it, for the server owner
 *   ?forbidden  the list answers 403 (anyone but the server owner)
 *   ?empty      nothing kept, nothing unsaved
 *   ?notice     the document notice; with &owner the viewer is the server owner
 *   ?dark
 * `window.prismRecovered`: `calls` (every request), `state` (what the "server" holds).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { RecoveredText, RecoverTextLink, setServerFetch, setTransferContextHeaders } from "@prism/core/shell";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const at = Date.UTC(2026, 9, 2, 15, 30);
type Kept = { id: number; vaultId: string; noteId: string; at: number; reason: string; kind: string; bytes: number };
type Unsaved = { vaultId: string; noteId: string; reason: string; permanent: boolean; since: number; attempts: number };
const KEPT: Kept[] = [
  { id: 7, vaultId: "primary", noteId: "plan", at, reason: "uncertain_base", kind: "document", bytes: 61 },
  { id: 8, vaultId: "primary", noteId: "gone", at: at - 86_400_000, reason: "no_base", kind: "document", bytes: 12_400 },
];
const UNSAVED: Unsaved[] = [
  { vaultId: "primary", noteId: "huge", reason: "too_many_nodes", permanent: true, since: at, attempts: 4 },
  { vaultId: "primary", noteId: "slow", reason: "vault_unreachable", permanent: false, since: at, attempts: 2 },
];
const state = {
  setAside: params.has("empty") ? [] : KEPT,
  rows: params.has("empty") ? [] : UNSAVED,
  bodies: { 7: "Launch plan\n\nThe paragraph I was typing when the newer copy arrived.", 8: "Old text of a page that no longer exists." } as Record<number, string>,
  notes: { plan: { id: "plan", path: "Projects/Launch plan" }, huge: { id: "huge", path: "Archive/Everything.md", metadata: { title: "Everything we know" } }, slow: { id: "slow", path: "Notes/Standup" } } as Record<string, unknown>,
};
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
Object.assign(window, { prismRecovered: { calls, state } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

setTransferContextHeaders(() => ({ "X-Prism-Vault": "primary" }));
setServerFetch(async (input, init = {}) => {
  const url = new URL(input, location.origin);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  calls.push({ method, path: url.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : null, headers });
  if (url.pathname.startsWith("/api/admin/") && params.has("forbidden")) return json({ error: "forbidden" }, 403);
  if (url.pathname === "/api/admin/collab/unsaved") return json({ rows: state.rows, setAside: state.setAside });
  const kept = /^\/api\/admin\/collab\/set-aside\/(\d+)$/.exec(url.pathname);
  if (kept) {
    const id = Number(kept[1]);
    const row = state.setAside.find((r) => r.id === id);
    if (!row) return json({ error: "not_found" }, 404);
    if (method === "DELETE") { state.setAside = state.setAside.filter((r) => r.id !== id); return json({ ok: true }); }
    return json({ ...row, body: state.bodies[id] });
  }
  const discard = /^\/api\/admin\/collab\/unsaved\/([^/]+)\/discard$/.exec(url.pathname);
  if (discard && method === "POST") {
    const body = (typeof init.body === "string" ? JSON.parse(init.body) : {}) as { confirm?: boolean; force?: boolean };
    const row = state.rows.find((r) => r.noteId === discard[1]);
    if (!row) return json({ error: "not_found" }, 404);
    if (body.confirm !== true) return json({ error: "confirm_required" }, 400);
    if (!row.permanent && body.force !== true) return json({ error: "not_permanent" }, 409);
    state.rows = state.rows.filter((r) => r !== row);
    return json({ ok: true, discarded: true, live: false });
  }
  const note = /^\/api\/notes\/([^/?]+)$/.exec(url.pathname);
  if (note) return state.notes[note[1]!] ? json(state.notes[note[1]!]) : json({ error: "not_found" }, 404);
  return json({ error: "not_found" }, 404);
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 16, minHeight: "100dvh", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <h1 style={{ fontSize: 18 }}>Server operations</h1>
      {params.has("notice") ? (
        <p role="status" data-testid="collab-notice" className="rounded-lg border p-3 text-sm">
          Changes made elsewhere replaced part of this page.{" "}
          <RecoverTextLink noteId="plan" owner={params.has("owner")} />
        </p>
      ) : <RecoveredText />}
      <p data-testid="after">End of the panel.</p>
    </main>
  </React.StrictMode>,
);

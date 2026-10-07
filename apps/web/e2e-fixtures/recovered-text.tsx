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
import { RecoveredText, ReplacedNotice, setServerFetch, setTransferContextHeaders } from "@prism/core/shell";
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
  { vaultId: "primary", noteId: "blank", reason: "vault_413", permanent: true, since: at, attempts: 1 },
];
const state = {
  setAside: params.has("empty") ? [] : KEPT,
  rows: params.has("empty") ? [] : UNSAVED,
  bodies: { 7: "Launch plan\n\nThe paragraph I was typing when the newer copy arrived.", 8: "Old text of a page that no longer exists." } as Record<number, string>,
  // What GET /api/tree lists for this viewer: ids, paths and (where it differs from the file name) titles. No bodies.
  tree: [
    { id: "plan", path: "Projects/Launch plan", tags: [], updatedAt: "2026-10-02T15:00:00.000Z" },
    { id: "huge", path: "Archive/Everything.md", title: "Everything we know", tags: [], updatedAt: "2026-10-02T15:00:00.000Z" },
    { id: "slow", path: "Notes/Standup", tags: [], updatedAt: "2026-10-02T15:00:00.000Z" },
    { id: "blank", path: "Notes/Untitled", tags: [], updatedAt: "2026-10-02T15:00:00.000Z" },
  ] as Array<Record<string, unknown>>,
  /** The tree answers only once this is released (a slow name lookup). */
  holdTree: params.has("slow-names"),
  /** The next N reads of the list fail (the server cannot be reached). */
  failLists: 0,
  /** What a discard answers: the server kept the text first (`kept`), or could not (`set_aside_failed`). */
  discard: "kept" as "kept" | "nothing-kept" | "set_aside_failed",
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
  if (url.pathname === "/api/admin/collab/unsaved") {
    if (state.failLists > 0) { state.failLists--; throw new TypeError("Failed to fetch"); }
    return json({ rows: state.rows, setAside: state.setAside });
  }
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
    if (state.discard === "set_aside_failed") return json({ error: "set_aside_failed", retry: true, detail: "the page's unsaved text could not be kept first, so nothing was discarded" }, 503);
    state.rows = state.rows.filter((r) => r !== row);
    return json({ ok: true, discarded: true, live: false, kept: state.discard === "kept" });
  }
  if (url.pathname === "/api/tree") {
    while (state.holdTree) await new Promise((r) => setTimeout(r, 50));
    return json(state.tree);
  }
  return json({ error: "not_found" }, 404);
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 16, minHeight: "100dvh", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <h1 style={{ fontSize: 18 }}>Server operations</h1>
      {params.has("notice") ? (
        <ReplacedNotice noteId="plan" owner={params.has("owner")} text="Changes made elsewhere replaced part of this page." onDismiss={() => undefined} />
      ) : <RecoveredText />}
      <p data-testid="after">End of the panel.</p>
    </main>
  </React.StrictMode>,
);

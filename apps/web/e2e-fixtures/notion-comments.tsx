/**
 * Page-level discussion fixture (NP-CO-02): the real PageDiscussion +
 * CommentsSidebar over two local Y.Docs that sync like two clients of one live
 * document ("you" and "the other person"). Fictional data; no server.
 *
 * ?level=edit (default)  you write on the shared doc directly (an editor's socket)
 * ?level=suggest         your side is read-only; changes go through a fake of the
 *                        server's command endpoint (`window.prismDiscussion`:
 *                        `commands`, `failNext`) which authors them on the doc
 * ?level=view            no composer; existing threads are still shown
 * ?dark
 */
import React from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentsSidebar, PageDiscussion } from "@prism/core";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
import "../../../packages/core/src/styles/workspace.css";
import "../../../packages/core/src/styles/collab.css";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const level = (params.get("level") ?? "edit") as "edit" | "suggest" | "view";

// Two clients of one document: every update on one is applied to the other.
const mine = new Y.Doc();
const theirs = new Y.Doc();
mine.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "sync") Y.applyUpdate(theirs, u, "sync"); });
theirs.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "sync") Y.applyUpdate(mine, u, "sync"); });

const me = { name: "You", color: "#2563eb" };
const other = { name: "Mira", color: "#16a34a" };
const controls = {
  commands: [] as Array<Record<string, unknown>>,
  failNext: "" as string,
  threads: () => mine.getMap("comments").toJSON(),
  /** An anchored thread, as the editor would make one. */
  seedAnchored: () => {
    theirs.transact(() => {
      const t = new Y.Map<unknown>();
      t.set("id", "c-anchored");
      t.set("quote", "the spring launch");
      t.set("resolved", false);
      const arr = new Y.Array<unknown>();
      arr.push([{ author: other.name, color: other.color, text: "Is this date fixed?", createdAt: 1 }]);
      t.set("comments", arr);
      theirs.getMap("comments").set("c-anchored", t);
    });
  },
};
Object.assign(window, { prismDiscussion: controls });

// The suggest-level path: the "server" authors the change on the shared document.
const serverItem = (text: string) => ({ id: crypto.randomUUID(), author: me.name, actorId: "h_fixture", color: me.color, text, createdAt: Date.now(), agent: false });
const server = async (command: Record<string, unknown>, apply: () => void) => {
  controls.commands.push(command);
  await new Promise((r) => setTimeout(r, 60));
  if (controls.failNext) { const message = controls.failNext; controls.failNext = ""; throw new Error(message); }
  theirs.transact(apply, "server");
};
const actions = level === "suggest" ? {
  pageComment: (text: string) => server({ kind: "page-comment", text }, () => {
    const id = `c-${crypto.randomUUID()}`;
    const t = new Y.Map<unknown>();
    t.set("id", id); t.set("quote", ""); t.set("page", true); t.set("resolved", false);
    const arr = new Y.Array<unknown>();
    arr.push([serverItem(text)]);
    t.set("comments", arr);
    theirs.getMap("comments").set(id, t);
  }),
  reply: (threadId: string, text: string) => server({ kind: "reply", threadId, text }, () => { ((theirs.getMap("comments").get(threadId) as Y.Map<unknown>).get("comments") as Y.Array<unknown>).push([serverItem(text)]); }),
  resolve: (threadId: string, resolved: boolean) => server({ kind: "resolve", threadId, resolved }, () => { (theirs.getMap("comments").get(threadId) as Y.Map<unknown>).set("resolved", resolved); }),
  remove: (threadId: string) => server({ kind: "delete-comment", threadId }, () => { theirs.getMap("comments").delete(threadId); }),
  canDelete: (thread: { comments: Array<{ author: string }> }) => thread.comments.every((c) => c.author === me.name),
} : undefined;

function Fixture() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 24, padding: 24, minHeight: "100vh", background: "var(--bg-base)", color: "var(--text-primary)", ["--content-measure" as string]: "640px" }}>
      <main aria-label="Your view">
        <h1 style={{ fontSize: 34, margin: "0 0 12px" }}>Launch plan</h1>
        <PageDiscussion ydoc={mine} user={me} canComment={level !== "view"} actions={actions} />
        <p style={{ color: "var(--text-secondary)" }}>The brief for the spring launch: goals, scope and milestones.</p>
        <aside aria-label="Comments sidebar" style={{ marginTop: 24, maxWidth: 320 }}>
          <CommentsSidebar ydoc={mine} user={me} canComment={level !== "view"} actions={actions} noteId={new URLSearchParams(location.search).get("note")} />
        </aside>
      </main>
      <main aria-label="Other person's view">
        <h1 style={{ fontSize: 34, margin: "0 0 12px" }}>Launch plan</h1>
        <PageDiscussion ydoc={theirs} user={other} canComment />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider></React.StrictMode>,
);

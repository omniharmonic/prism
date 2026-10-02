import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PublicationView } from "../src/publish/PublicationView";
const params = new URLSearchParams(location.search);
const controls = {
  manifestStatus: params.has("unavailable") ? 503 : 200,
  noteStatus: {} as Record<string, number>,
  protected: params.has("protected"),
  empty: params.has("empty"),
  unlocked: false,
  authCalls: 0,
  hold: "",
  release: null as (() => void) | null,
  setSlug: (_slug: string) => {},
};
Object.assign(window, { prismPublicationFixture: controls });
const originalFetch = window.fetch.bind(window);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
window.fetch = async (input, init) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const path = new URL(raw, location.origin).pathname;
  if (!path.startsWith("/api/p/")) return originalFetch(input, init);
  const [, , , slug, action, id] = path.split("/");
  if (action === "auth") {
    controls.authCalls++;
    if (JSON.parse(String(init?.body)).password !== "fixture-secret")
      return json({}, 401);
    controls.unlocked = true;
    return json({ ok: true });
  }
  const locked = controls.protected && !controls.unlocked;
  const notes = controls.empty
    ? []
    : ["first", "second"].map((id) => ({
        id,
        title: id === "first" ? "First page" : "Second page",
        path: id + ".md",
        tags: [],
      }));
  if (!action)
    return json(
      {
        slug,
        title: slug === "other" ? "Other publication" : "Prism field guide",
        template: "wiki",
        theme: null,
        homeNoteId: locked ? null : (notes[0]?.id ?? null),
        passwordRequired: controls.protected,
        locked,
        notes: locked ? [] : notes,
        mapFeatureCount: 0,
      },
      controls.manifestStatus,
    );
  if (locked) return json({}, 401);
  if (action === "graph") return json({ nodes: [], edges: [] });
  if (action === "map") return json({ features: [] });
  if (action === "notes") {
    if (controls.hold === id)
      await new Promise<void>((resolve) => {
        controls.release = resolve;
      });
    if (controls.noteStatus[id!]) return json({}, controls.noteStatus[id!]);
    return json({
      id,
      title: id === "first" ? "First page" : "Second page",
      path: id + ".md",
      tags: [],
      metadata: {},
      content: `<p>PRISM_PUBLICATION_${slug}_${id}_BODY</p>`,
    });
  }
  return json({}, 404);
};
function App() {
  const [slug, setSlug] = useState("guide");
  controls.setSlug = setSlug;
  return <PublicationView slug={slug} noteId={null} />;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

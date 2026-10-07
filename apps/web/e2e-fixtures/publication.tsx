import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PublicationView } from "../src/publish/PublicationView";
// NP-ED-24: one instance of every block type, the same data the server test uses.
import { PARITY_PAGE_HTML } from "../../server/test/fixtures/parity-blocks";
const params = new URLSearchParams(location.search);
const longTitle = "PRISM_SITE_STUDIO_UI_VERIFIED".repeat(4);
const pageTitle = (id: string) =>
  params.has("typography") ? "Shared understanding" : params.has("long-content")
    ? longTitle
    : id === "first"
      ? "First page"
      : "Second page";
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
        title: pageTitle(id!),
        path: id + ".md",
        tags: [],
      }));
  if (!action)
    return json(
      {
        slug,
        title: params.has("long-content")
          ? longTitle
          : slug === "other"
            ? "Other publication"
            : "Prism field guide",
        template: params.get("template") ?? "wiki",
        theme: params.has("custom-navigation")
          ? {
              navigation: {
                version: 1,
                sections: [
                  {
                    title: "Start here",
                    noteIds: ["second", "secret-private"],
                  },
                  {
                    title: "PRIVATE_ONLY_SECTION",
                    noteIds: ["secret-private-other"],
                  },
                ],
              },
            }
          : params.has("malformed-navigation")
            ? { navigation: { version: 99, sections: "invalid" } }
            : params.has("malformed-theme")
              ? {
                  accent: { invalid: true },
                  logoUrl: 42,
                  font: ["serif"],
                  coverUrl: {},
                  description: 3,
                }
              : params.has("font") ? {font: params.get("font")} : null,

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
  // Wave 3: the publication-scoped attachment route (a 1×1 PNG for the one known id).
  if (action === "attachments") {
    (controls as { attachmentReads?: string[] }).attachmentReads = [...((controls as { attachmentReads?: string[] }).attachmentReads ?? []), path];
    if (id !== "a_fixtureImage0000000000") return json({ error: "not_found" }, 404);
    return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0)), { headers: { "content-type": "image/png" } });
  }
  if (action === "notes") {
    if (controls.hold === id)
      await new Promise<void>((resolve) => {
        controls.release = resolve;
      });
    if (controls.noteStatus[id!]) return json({}, controls.noteStatus[id!]);
    return json({
      id,
      title: pageTitle(id!),
      path: id + ".md",
      tags: [],
      metadata: {},
      content:
        `<p>PRISM_PUBLICATION_${slug}_${id}_BODY</p>` +
        (params.has("font")
          ? "<h2>Reading together</h2><pre><code>const source = true;</code></pre>"
          : "") +
        (params.has("attachments") ? `<p><img src="/api/attachments/a_fixtureImage0000000000" alt="Field photo"></p><p><a href="/api/attachments/a_fixtureImage0000000000">Download the photo</a></p><p><img src="https://example.test/api/attachments/a_other" alt="Elsewhere"></p>` : "") +
        (params.has("blocks") ? PARITY_PAGE_HTML : "") +
        // Markdown task items after an HTML block, a mixed list, and a to-do list the editor stored.
        (params.has("todos") ? `\n\n- [x] Booked the room\n- [ ] Send the agenda\n\nAlso:\n\n- an ordinary point\n- [x] done, in a mixed list\n\n<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Stored task</p></div></li></ul>\n` : "") +
        (params.has("typography") ? `<h1>A place for shared understanding</h1><h2>Working together</h2><p>Shared context makes our notes easier to read and revisit.</p><p>${"UNBROKEN_TOKEN_".repeat(12)}</p>` : "") +
        (params.has("long-content")
          ? `<h2>${longTitle}</h2><p><a href="https://example.test/">${longTitle}</a></p><pre><code>${longTitle.repeat(4)}</code></pre>`
          : ""),
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

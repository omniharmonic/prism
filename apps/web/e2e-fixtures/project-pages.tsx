/**
 * Project pages fixture (Phase 0): the pages-and-navigation fixture (the real
 * workspace over an in-page fake server) plus notes tagged `project` at the vault's
 * convention `vault/projects/<slug>/PROJECT`, with MARKDOWN bodies as the ingesters
 * write them. Fictional data; never connects to a live server.
 *
 *  - `food`   no title, no name → named by its folder ("Bioregional food chain")
 *  - `named`  `metadata.name` → "Watershed Council"
 *  - `big`    a ~53,000-character Markdown body (the size of the largest real one)
 *  - `task1`  a task filed under the project folder (an ordinary page beside it)
 *
 * The tree route here answers as the real server does for these notes: a row carries
 * `title` (for a container-named page, its `name` when it has no title).
 */
import { projectRelatedPage, type ProjectSection } from "@prism/core/projects";
import type { Note } from "@prism/core";
import { isTrashed } from "../../../packages/core/src/lib/pages/model";
import { largeMarkdown } from "./project-pages-data";

const BODY = [
  "# Bioregional Food Chain",
  "",
  "**Status:** active. Stewarded with [[Ada Park]] — see the *working agreement*.",
  "",
  "## Goals",
  "",
  "- Map every grower within **fifty miles**",
  "- Publish the `supply.csv` table",
  "",
  "> Food moves at the speed of trust.",
].join("\n");

let seeded: Note[] = [];
Object.assign(window, {
  prismFixtureExtension: {
    seed(notes: Note[], doc: (id: string, path: string, html: string, extra?: Partial<Note>) => Note) {
      seeded = notes;
      const project = (id: string, slug: string, content: string, metadata: Record<string, unknown> = {}) =>
        doc(id, `vault/projects/${slug}/PROJECT`, content, { tags: ["project"], metadata: { type: "project", status: "active", ...metadata } });
      notes.push(
        project("food", "bioregional-food-chain", BODY, { lead: "Ada Park" }),
        project("named", "watershed", "A council of the **South Platte** basin.", { name: "Watershed Council" }),
        project("big", "front-range-commons", largeMarkdown()),
        doc("task1", "vault/projects/bioregional-food-chain/Call the growers", "<p>Ring round.</p>", { tags: ["task"], metadata: { type: "task", status: "todo", projects: ["food"] } }),
      );
    },
    async fetch(url: URL, method: string) {
      const related = /^\/api\/projects\/([^/]+)\/related$/.exec(url.pathname);
      if (related && method === "GET") {
        if (url.searchParams.get("fail") || location.search.includes("sections-error")) return Response.json({ error: "project_unavailable" }, { status: 503 });
        const project = seeded.find(note => note.id === decodeURIComponent(related[1]!));
        return project ? Response.json(projectRelatedPage(seeded, project, (url.searchParams.get("kind") ?? "documents") as ProjectSection, url.searchParams.get("after") ?? "")) : Response.json({}, { status: 404 });
      }
      if (url.pathname !== "/api/tree" || method !== "GET") return null;
      const container = (p: string | null) => !!p && /\/PROJECT$/.test(p);
      return Response.json(seeded.filter((n) => !isTrashed(n)).map((n) => {
        const title = typeof n.metadata?.title === "string" && n.metadata.title ? n.metadata.title : container(n.path) && typeof n.metadata?.name === "string" ? n.metadata.name : undefined;
        return { id: n.id, path: n.path, tags: n.tags, updatedAt: n.updatedAt, type: n.metadata?.type, ...(title ? { title } : {}) };
      }));
    },
  },
});

await import("./pages-nav");

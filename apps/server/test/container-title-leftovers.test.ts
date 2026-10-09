/**
 * Container-named pages (`<folder>/PROJECT`, README, index) in the places PR #33 left
 * printing the path leaf: `leafTitle` (the helper every such surface now asks) and the
 * graph's node titles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { leafTitle, pageTitle } from "@prism/core/pages";
import { graphNeighborhood } from "../src/graph";
import type { Note } from "../src/parachute";

test("leafTitle: the path leaf for ordinary pages, the real title for container-named ones", () => {
  assert.equal(leafTitle("vault/notes/Roadmap"), "Roadmap");
  assert.equal(leafTitle("Roadmap.md"), "Roadmap.md"); // unchanged: exactly what `split("/").pop()` gave
  assert.equal(leafTitle("vault/projects/opencivics/PROJECT"), "Opencivics");
  assert.equal(leafTitle("vault/projects/opencivics/PROJECT", { name: "OpenCivics" }), "OpenCivics");
  assert.equal(leafTitle("vault/projects/opencivics/PROJECT", { title: "OpenCivics Network", name: "x" }), "OpenCivics Network");
  assert.equal(leafTitle("docs/guides/README.md"), "Guides");
  assert.equal(leafTitle("wiki/index"), "Wiki");
  assert.equal(leafTitle("README"), "README"); // top level: no folder to take a name from
  assert.equal(leafTitle("vault/projects/x/Project"), "Project"); // case-sensitive: somebody's own title
  assert.equal(leafTitle(null), undefined);
  assert.equal(leafTitle(""), undefined);
  assert.equal(leafTitle(undefined) ?? "fallback", "fallback");
  assert.equal(pageTitle("vault/projects/opencivics/PROJECT"), "Opencivics");
});

test("graph: a container-named note is a node named by its title / name / folder, never PROJECT", () => {
  const note = (id: string, path: string, metadata: Record<string, unknown>, links: string[] = []): Note =>
    ({ id, path, tags: [], content: "", metadata, links: links.map((targetId) => ({ sourceId: id, targetId, relationship: "mentions" })) }) as unknown as Note;
  const g = graphNeighborhood([
    note("a", "vault/notes/Hub", {}, ["p1", "p2", "p3"]),
    note("p1", "vault/projects/opencivics/PROJECT", { name: "OpenCivics" }),
    note("p2", "vault/projects/food-chain/PROJECT", {}),
    note("p3", "vault/projects/prism/PROJECT", { title: "Prism" }),
  ], "a", 1, 50)!;
  const titles = Object.fromEntries(g.nodes.map((n) => [n.id, n.title]));
  assert.deepEqual(titles, { a: "Hub", p1: "OpenCivics", p2: "Food chain", p3: "Prism" });
  assert.ok(!JSON.stringify(g.nodes.map((n) => n.title)).includes("PROJECT"));
});

// ── Round 5 (2026-10-09): the remaining places that printed the path leaf ─────────────────────
// Found by reading every `split("/").pop()` / `lastIndexOf("/")` in the server and in core.
import { navTitle } from "../src/publication-content";
import { buildNotePrompt } from "../src/worker/skills";
import { pushNoteToGoogleDoc } from "../src/worker/googledocs";
import { blendResults } from "../../../packages/core/src/lib/search/blend";

const PROJECT = "vault/projects/bioregional-food-chain/PROJECT";

test("a published site lists a container-named page by its title or folder — never PROJECT", () => {
  const n = (metadata: Record<string, unknown>, content = ""): Note => ({ id: "p", path: PROJECT, tags: [], content, metadata }) as unknown as Note;
  assert.equal(navTitle(n({})), "Bioregional food chain");
  assert.equal(navTitle(n({ title: "Food Chain" })), "Food Chain");
  assert.equal(navTitle({ id: "o", path: "vault/notes/field-notes.md", tags: [], content: "", metadata: {} } as unknown as Note), "field notes", "an ordinary page is unchanged");
});

test("a background skill is told the page's name, and a Google Doc is created under it", async () => {
  const prompt = buildNotePrompt({ id: "p", path: PROJECT, tags: [], content: "body", metadata: {} } as unknown as Note, "2026-10-09", 2000);
  assert.ok(prompt.includes("Bioregional food chain"), prompt.slice(0, 200));
  assert.ok(!/\bPROJECT\b/.test(prompt.split("body")[0]!), "the file name is not offered as the title");
  const created: string[] = [];
  await pushNoteToGoogleDoc({ createDoc: async (title: string) => { created.push(title); return "doc-1"; }, writeDoc: async () => undefined } as never, { path: PROJECT, content: "x" });
  assert.deepEqual(created, ["Bioregional food chain"]);
  await pushNoteToGoogleDoc({ createDoc: async (title: string) => { created.push(title); return "doc-2"; }, writeDoc: async () => undefined } as never, { path: "vault/notes/Roadmap.md", content: "x" });
  assert.equal(created[1], "Roadmap", "an ordinary page is unchanged");
});

test("search: typing a container-named page's name puts it first (it matched on the word PROJECT before)", () => {
  const keyword = [{ id: "other", path: "vault/notes/Meeting about food" }, { id: "proj", path: PROJECT }];
  assert.deepEqual(blendResults([], keyword, ["bioregional", "food"]).map((r) => r.id), ["proj", "other"]);
  // …and the word "project" no longer makes every project page a title match.
  const many = [{ id: "a", path: "vault/projects/alpha/PROJECT" }, { id: "b", path: "vault/notes/Project plan" }];
  assert.deepEqual(blendResults([], many, ["project"]).map((r) => r.id), ["b", "a"]);
});

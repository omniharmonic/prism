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

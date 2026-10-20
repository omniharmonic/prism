/**
 * Notion sync (Phase 3) — the pure markdown↔blocks conversion (the substantive
 * part; the HTTP client needs a live token, exercised by verify-notion-sync.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, blocksToMarkdown, NotionClient, parseNotionSearch } from "../src/worker/notion";

test("markdownToBlocks maps headings, bullets, and paragraphs", () => {
  const blocks = markdownToBlocks("# H1\n## H2\n### H3\n- item\n* item2\n\nplain para");
  assert.deepEqual(blocks.map((b) => b.type), ["heading_1", "heading_2", "heading_3", "bulleted_list_item", "bulleted_list_item", "paragraph"]);
  assert.equal((blocks[0] as any).heading_1.rich_text[0].text.content, "H1");
  assert.equal((blocks[3] as any).bulleted_list_item.rich_text[0].text.content, "item");
});

test("blocksToMarkdown renders the block types back", () => {
  const md = blocksToMarkdown([
    { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "body" }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "a" }] } },
    { type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "done" }] } },
    { type: "code", code: { language: "ts", rich_text: [{ plain_text: "x=1" }] } },
    { type: "quote", quote: { rich_text: [{ plain_text: "q" }] } },
    { type: "divider", divider: {} },
  ]);
  assert.equal(md, "# Title\nbody\n- a\n- [x] done\n```ts\nx=1\n```\n> q\n---");
});

test("round-trips markdown through blocks (headings + bullets + paragraphs)", () => {
  const src = "# Weekly Sync\n## Agenda\n- one\n- two\nsome notes here";
  const round = blocksToMarkdown(markdownToBlocks(src) as any);
  assert.equal(round, src);
});

test("extractText tolerates both plain_text and text.content shapes + empty", () => {
  const md = blocksToMarkdown([
    { type: "paragraph", paragraph: { rich_text: [{ text: { content: "via text.content" } }] } },
    { type: "paragraph", paragraph: { rich_text: [] } },
  ]);
  assert.equal(md, "via text.content\n");
});

test("searchPages posts a page-only /search and maps the picker rows (WP4.3)", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        results: [
          { id: "p1", url: "https://notion.so/p1", icon: { type: "emoji", emoji: "📝" }, properties: { Name: { type: "title", title: [{ plain_text: "Road" }, { plain_text: "map" }] } } },
          { id: "p2", properties: { title: { type: "title", title: [] } }, icon: { type: "external", external: { url: "https://x" } } },
          { nope: true },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const pages = await new NotionClient("secret_x", fake).searchPages("  road ");
  assert.equal(calls[0]!.url, "https://api.notion.com/v1/search");
  assert.deepEqual(calls[0]!.body, { page_size: 50, filter: { property: "object", value: "page" }, query: "road" });
  assert.deepEqual(pages, [
    { id: "p1", title: "Roadmap", url: "https://notion.so/p1", icon: "📝" },
    { id: "p2", title: "Untitled", url: "", icon: null },
  ]);
  await new NotionClient("secret_x", fake).searchPages("");
  assert.equal(calls[1]!.body.query, undefined, "an empty query lists everything");
  assert.deepEqual(parseNotionSearch(null), []);
});

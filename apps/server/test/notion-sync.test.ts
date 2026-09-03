/**
 * Notion sync (Phase 3) — the pure markdown↔blocks conversion (the substantive
 * part; the HTTP client needs a live token, exercised by verify-notion-sync.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, blocksToMarkdown } from "../src/worker/notion";

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

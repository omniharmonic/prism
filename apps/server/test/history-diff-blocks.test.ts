/** Version-history text diffs show block-editor changes that carry no text of their own. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentAsText, diffText } from "../../../packages/core/src/lib/history/diff";

test("toggles, callouts, images and colours become readable lines", () => {
  const text = contentAsText('<details data-type="toggle"><summary>Q</summary><p>A</p></details><div data-type="callout" data-emoji="⚠️"><p>Careful</p></div><img src="/a/chart.png"><p data-block-color="blue_background">Blue</p><p><span data-text-color="red">red</span> <mark data-color="x">hi</mark></p>');
  assert.match(text, /▸ Q\nA/);
  assert.match(text, /⚠️ Careful/);
  assert.match(text, /\[Image: chart\.png\]/);
  assert.match(text, /\[blue background\] Blue/);
  assert.match(text, /\[red text\] red \[highlight\] hi/);
});

test("a colour-only or image-only change is a changed line, not an empty diff", () => {
  const colour = diffText(contentAsText("<p>Same words</p>"), contentAsText('<p data-block-color="red">Same words</p>'));
  assert.ok(colour.added + colour.removed > 0, "colour change shows");
  const image = diffText(contentAsText("<p>x</p>"), contentAsText('<p>x</p><img src="/b.png" alt="Diagram">'));
  assert.ok(image.rows.some((r) => r.kind === "add" && r.text.includes("[Image: Diagram]")));
});

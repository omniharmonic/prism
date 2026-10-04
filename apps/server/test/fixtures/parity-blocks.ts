/**
 * NP-ED-24 — one small instance of every block type of NP-ED-08 … NP-ED-19, as the
 * editor stores it, with what must still be there after each pipeline:
 *
 *   stored    substrings of the note's stored HTML (the server's HTML ⇄ Yjs round trip)
 *   markdown  what the Markdown export must contain
 *   html      what the HTML export must contain
 *   selector  an element the PUBLISHED page must show (and `text`, its visible text)
 *
 * Pure data (no imports): shared by the server test (test/block-roundtrip.test.ts) and
 * the publication browser fixture (apps/web/e2e-fixtures/publication.tsx ?blocks).
 */
export interface ParityBlock {
  /** Checklist row the block belongs to. */
  row: string;
  name: string;
  html: string;
  stored: string[];
  markdown: RegExp[];
  html_export: RegExp[];
  selector: string;
  text?: string;
  /**
   * Pipelines this block does NOT survive today (seen failing 2026-10-03) — each is a build gap
   * recorded in docs/roadmap/workspace-experience/PARITY-GAPS.md §a.1. The value says what is lost.
   * The tests assert every block WITHOUT an entry, and carry the listed ones as todo / fixme.
   */
  gaps?: { markdown?: string; html_export?: string; published?: string };
}

const IMG = "/api/attachments/a_rtimage0000000000000000";
const FILE = "/api/attachments/a_rtfile00000000000000000";

export const PARITY_BLOCKS: ParityBlock[] = [
  { row: "NP-ED-08", name: "heading 1", html: "<h1>RT heading one</h1>", stored: ["<h1>RT heading one</h1>"], markdown: [/^# RT heading one$/m], html_export: [/<h1[^>]*>RT heading one<\/h1>/], selector: "h1", text: "RT heading one" },
  { row: "NP-ED-08", name: "heading 2", html: "<h2>RT heading two</h2>", stored: ["<h2>RT heading two</h2>"], markdown: [/^## RT heading two$/m], html_export: [/<h2[^>]*>RT heading two<\/h2>/], selector: "h2", text: "RT heading two" },
  { row: "NP-ED-08", name: "heading 3", html: "<h3>RT heading three</h3>", stored: ["<h3>RT heading three</h3>"], markdown: [/^### RT heading three$/m], html_export: [/<h3[^>]*>RT heading three<\/h3>/], selector: "h3", text: "RT heading three" },
  {
    row: "NP-ED-08", name: "paragraph with inline marks",
    html: "<p>RT paragraph with <strong>RT bold</strong>, <em>RT italic</em>, <u>RT underline</u>, <s>RT strike</s> and <code>RT inline code</code>.</p>",
    stored: ["<strong>RT bold</strong>", "<em>RT italic</em>", "<u>RT underline</u>", "<s>RT strike</s>", "<code>RT inline code</code>"],
    markdown: [/\*\*RT bold\*\*/, /[*_]RT italic[*_]/, /RT underline/, /RT strike/, /`RT inline code`/],
    html_export: [/<strong>RT bold<\/strong>/, /<em>RT italic<\/em>/, /<u>RT underline<\/u>/, /<s>RT strike<\/s>/, /<code>RT inline code<\/code>/],
    selector: "p strong", text: "RT bold",
  },
  {
    row: "NP-ED-08", name: "toggle heading",
    html: '<details data-heading-level="2" data-type="toggle"><summary>RT toggle heading</summary><p>RT toggle heading body</p></details>',
    stored: ['data-heading-level="2"', "<summary>RT toggle heading</summary>", "<p>RT toggle heading body</p>"],
    markdown: [/RT toggle heading/, /RT toggle heading body/],
    html_export: [/<summary[^>]*>RT toggle heading<\/summary>/, /RT toggle heading body/],
    selector: "details summary", text: "RT toggle heading",
  },
  {
    row: "NP-ED-08", name: "bulleted list with a nested child",
    html: "<ul><li><p>RT bullet one</p><ul><li><p>RT nested bullet</p></li></ul></li><li><p>RT bullet two</p></li></ul>",
    stored: ["<li><p>RT bullet one</p><ul><li><p>RT nested bullet</p></li></ul></li>", "<li><p>RT bullet two</p></li>"],
    markdown: [/^[-*+]\s+RT bullet one$/m, /^\s{2,}[-*+]\s+RT nested bullet$/m, /^[-*+]\s+RT bullet two$/m],
    html_export: [/<ul[^>]*>\s*<li[^>]*>\s*<p[^>]*>RT bullet one<\/p>\s*<ul[^>]*>\s*<li[^>]*>\s*<p[^>]*>RT nested bullet/],
    selector: "ul li ul li", text: "RT nested bullet",
  },
  {
    row: "NP-ED-08", name: "numbered list",
    html: "<ol><li><p>RT number one</p></li><li><p>RT number two</p></li></ol>",
    stored: ["<ol><li><p>RT number one</p></li><li><p>RT number two</p></li></ol>"],
    markdown: [/^1\.\s+RT number one$/m, /^2\.\s+RT number two$/m],
    html_export: [/<ol[^>]*>\s*<li[^>]*>\s*<p[^>]*>RT number one<\/p>\s*<\/li>\s*<li[^>]*>\s*<p[^>]*>RT number two/],
    selector: "ol li:nth-child(2)", text: "RT number two",
  },
  {
    row: "NP-ED-08", name: "to-do list (checked and open)",
    html: '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>RT done task</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>RT open task</p></div></li></ul>',
    stored: ['data-type="taskList"', 'data-checked="true"', "RT done task", 'data-checked="false"', "RT open task"],
    markdown: [/\[x\]\s+RT done task/i, /\[ \]\s+RT open task/],
    html_export: [/RT done task/, /RT open task/],
    selector: 'li[data-checked="true"]', text: "RT done task",
    gaps: { markdown: "the items are exported as plain bullets: the checked / open state is lost" },
  },
  {
    row: "NP-ED-08", name: "toggle list",
    html: '<details data-type="toggle"><summary>RT toggle</summary><p>RT toggle body</p></details>',
    stored: ['<details data-type="toggle"><summary>RT toggle</summary><p>RT toggle body</p></details>'],
    markdown: [/RT toggle$/m, /RT toggle body/],
    html_export: [/<details[^>]*>\s*<summary[^>]*>RT toggle<\/summary>/, /RT toggle body/],
    selector: 'details[data-type="toggle"]:not([data-heading-level]) summary', text: "RT toggle",
  },
  { row: "NP-ED-08", name: "quote", html: "<blockquote><p>RT quote</p></blockquote>", stored: ["<blockquote><p>RT quote</p></blockquote>"], markdown: [/^>\s+RT quote$/m], html_export: [/<blockquote[^>]*>\s*<p[^>]*>RT quote/], selector: "blockquote", text: "RT quote" },
  { row: "NP-ED-08", name: "divider", html: "<hr>", stored: ["<hr>"], markdown: [/^(\* \* \*|---|\*\*\*|___)$/m], html_export: [/<hr\s*\/?>/], selector: "hr" },
  {
    row: "NP-ED-08", name: "callout",
    html: '<div data-emoji="💡" data-type="callout"><p>RT callout</p></div>',
    stored: ['data-type="callout"', 'data-emoji="💡"', "<p>RT callout</p>"],
    markdown: [/RT callout/],
    html_export: [/RT callout/],
    selector: 'div[data-type="callout"]', text: "RT callout",
  },
  {
    row: "NP-ED-09", name: "columns",
    html: '<div data-type="columns" data-count="2"><div data-col-width="1.5" style="flex-grow: 1.5;" data-type="column"><p>RT left column</p></div><div data-type="column"><p>RT right column</p></div></div>',
    stored: ['data-type="columns"', 'data-count="2"', 'data-col-width="1.5"', "<p>RT left column</p>", "<p>RT right column</p>"],
    markdown: [/RT left column/, /RT right column/],
    html_export: [/RT left column/, /RT right column/],
    selector: 'div[data-type="columns"] div[data-type="column"]:nth-child(2)', text: "RT right column",
  },
  {
    row: "NP-ED-10", name: "table (header row, coloured cell)",
    html: '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>RT head A</p></th><th colspan="1" rowspan="1"><p>RT head B</p></th></tr><tr><td colspan="1" rowspan="1" data-cell-color="blue"><p>RT cell A</p></td><td colspan="1" rowspan="1"><p>RT cell B</p></td></tr></tbody></table>',
    stored: ["<table", "RT head A", "RT head B", 'data-cell-color="blue"', "RT cell A", "RT cell B"],
    markdown: [/\|\s*RT head A\s*\|\s*RT head B\s*\|/, /\|\s*RT cell A\s*\|\s*RT cell B\s*\|/],
    html_export: [/<table[\s\S]*<th[^>]*>[\s\S]*RT head A[\s\S]*<td[^>]*>[\s\S]*RT cell A[\s\S]*<\/table>/],
    selector: "table td", text: "RT cell A",
    gaps: { markdown: "the table is flattened: every cell becomes its own paragraph (the words survive, the rows and columns do not)" },
  },
  {
    row: "NP-ED-11", name: "code block with a language",
    html: '<pre><code class="language-ts">const rt = "code";</code></pre>',
    stored: ['<pre><code class="language-ts">const rt = "code";</code></pre>'],
    markdown: [/^```ts$/m, /^const rt = "code";$/m],
    html_export: [/<pre[^>]*>\s*<code[^>]*>const rt = (&quot;|")code(&quot;|");<\/code>/],
    selector: "pre code", text: 'const rt = "code";',
  },
  {
    row: "NP-ED-12", name: "image (aligned, captioned)",
    html: `<img src="${IMG}" alt="RT image" data-align="center" data-caption="RT caption">`,
    stored: [`src="${IMG}"`, 'alt="RT image"', 'data-align="center"', 'data-caption="RT caption"'],
    markdown: [/RT image/, /a_rtimage0000000000000000/],
    html_export: [/<img[^>]*alt="RT image"/, /a_rtimage0000000000000000/],
    selector: 'img[alt="RT image"]',
    gaps: { markdown: "the caption (and the alignment) is dropped: Markdown keeps only the image and its alt text" },
  },
  {
    row: "NP-ED-13", name: "file block",
    html: `<div data-src="${FILE}" data-name="rt-notes.txt" data-size="12" data-mime="text/plain" data-kind="file" data-type="attachment"><a href="${FILE}" rel="noopener noreferrer">rt-notes.txt</a></div>`,
    stored: ['data-type="attachment"', 'data-kind="file"', `data-src="${FILE}"`, 'data-name="rt-notes.txt"'],
    markdown: [/rt-notes\.txt/, /a_rtfile00000000000000000/],
    html_export: [/rt-notes\.txt/, /a_rtfile00000000000000000/],
    selector: 'a[href*="a_rtfile00000000000000000"]', text: "rt-notes.txt",
  },
  {
    row: "NP-ED-14", name: "bookmark card",
    html: '<div data-url="https://example.test/rt-bookmark" data-title="RT bookmark" data-description="RT bookmark description" data-site="example.test" data-type="bookmark"><a href="https://example.test/rt-bookmark" rel="noopener noreferrer">RT bookmark</a></div>',
    stored: ['data-type="bookmark"', 'data-url="https://example.test/rt-bookmark"', 'data-title="RT bookmark"', 'data-description="RT bookmark description"'],
    markdown: [/RT bookmark/, /https:\/\/example\.test\/rt-bookmark/],
    html_export: [/<a[^>]*href="https:\/\/example\.test\/rt-bookmark"[^>]*>RT bookmark<\/a>/],
    selector: 'a[href="https://example.test/rt-bookmark"]', text: "RT bookmark",
    gaps: { markdown: "the card becomes a plain link: its description (and site, image) is dropped" },
  },
  {
    row: "NP-ED-15", name: "embed",
    html: '<div data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" data-type="embed"><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" rel="noopener noreferrer">https://www.youtube.com/watch?v=dQw4w9WgXcQ</a></div>',
    stored: ['data-type="embed"', 'data-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'],
    markdown: [/https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/],
    html_export: [/href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/],
    selector: 'a[href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]',
  },
  {
    row: "NP-ED-16", name: "block colour, text colour and highlight",
    html: '<p data-block-color="blue_background">RT blue block</p><p><span data-text-color="red">RT red text</span> and <mark data-color="var(--prism-color-yellow-bg)" style="background-color: var(--prism-color-yellow-bg); color: inherit;">RT highlight</mark></p>',
    stored: ['<p data-block-color="blue_background">RT blue block</p>', '<span data-text-color="red">RT red text</span>', "RT highlight</mark>"],
    markdown: [/RT blue block/, /RT red text/, /RT highlight/],
    html_export: [/RT blue block/, /RT red text/, /RT highlight/],
    selector: 'p[data-block-color="blue_background"]', text: "RT blue block",
  },
  {
    row: "NP-ED-18", name: "link",
    html: '<p>See <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.test/rt-link">RT link</a>.</p>',
    stored: ['href="https://example.test/rt-link"', ">RT link</a>"],
    markdown: [/\[RT link\]\(https:\/\/example\.test\/rt-link\)/],
    html_export: [/<a[^>]*href="https:\/\/example\.test\/rt-link"[^>]*>RT link<\/a>/],
    selector: 'a[href="https://example.test/rt-link"]', text: "RT link",
  },
  {
    row: "NP-ED-19", name: "table of contents",
    html: '<div data-type="toc"></div>',
    stored: ['<div data-type="toc"></div>'],
    // The block lists the page's headings; an export has no live view, so the headings themselves are the content.
    markdown: [/^## RT heading two$/m],
    html_export: [/<h2[^>]*>RT heading two<\/h2>/],
    selector: 'div[data-type="toc"]',
    gaps: { published: "the block is an empty element on a published page: no list of headings is drawn in its place (the reader has the site's own outline)" },
  },
];

/** The whole page: every block, in order. */
export const PARITY_PAGE_HTML = PARITY_BLOCKS.map((b) => b.html).join("");

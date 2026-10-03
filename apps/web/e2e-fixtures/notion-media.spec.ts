import { test, expect, type Page } from "@playwright/test";

/** Wave 2B media: files/PDF/audio/video (ED-13), pasted URLs (ED-14), embeds (ED-15). */
const SHOTS = process.env.PRISM_EDITOR_SHOTS;
const html = (page: Page) => page.evaluate(() => (document.querySelector(".tiptap") as any).editor.getHTML() as string);
const enc = encodeURIComponent;

test.beforeEach(async ({ page }) => {
  // The server's attachment + media-proxy routes, served from fixture files.
  await page.route("**/api/attachments/*", (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop()!;
    const file = id === "a_pdf" ? "brief.pdf" : id === "a_wav" ? "tone.wav" : id === "a_webm" ? "clip.webm" : id.startsWith("a_img") ? "cover.png" : null;
    return file ? r.fulfill({ path: `e2e-fixtures/media/${file}` }) : r.fulfill({ status: 200, contentType: "application/octet-stream", body: "PK data" });
  });
  await page.route("**/api/media/proxy?*", (r) => r.fulfill({ path: "e2e-fixtures/media/cover.png" }));
  // Never reach the internet from a fixture: embed frames get an empty page.
  await page.route(/^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com|www\.loom\.com|www\.figma\.com|docs\.google\.com|open\.spotify\.com|codepen\.io|platform\.twitter\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>embed</title>" }));
});

async function caretAfter(page: Page, text: string) {
  await page.getByText(text, { exact: true }).click();
  await page.keyboard.press("End");
}

/** Paste files (bytes generated in-page) onto the editor. */
async function pasteFiles(page: Page, files: Array<{ name: string; type: string; bytes: string }>) {
  await page.evaluate(async (files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.bytes], f.name, { type: f.type }));
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, files);
}

async function pasteText(page: Page, text: string) {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.querySelector(".tiptap")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test("file, pdf, audio, video blocks", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-media.html");
  await caretAfter(page, "Alpha paragraph about the river.");
  await pasteFiles(page, [
    { name: "brief.pdf", type: "application/pdf", bytes: "%PDF-1.4" },
    { name: "tone.wav", type: "audio/wav", bytes: "RIFF....WAVE" },
    { name: "clip.webm", type: "video/webm", bytes: "\u001aEß£" },
    { name: "dataset.zip", type: "application/zip", bytes: "PK\u0003\u0004 data" },
  ]);
  await expect(page.locator(".prism-attachment")).toHaveCount(4);
  const uploads = await page.evaluate(() => (window as any).prismMediaUploads);
  expect(uploads.map((u: any) => [u.name, u.kind])).toEqual([["brief.pdf", "file"], ["tone.wav", "file"], ["clip.webm", "file"], ["dataset.zip", "file"]]);
  // PDF previews inline (same-origin frame).
  const pdf = page.locator('.prism-attachment[data-kind="pdf"]');
  await expect(pdf.locator("iframe")).toHaveAttribute("src", "/api/attachments/a_pdf");
  await expect(pdf).toContainText("brief.pdf");
  await expect(pdf).toContainText("PDF");
  // Audio and video players.
  await expect(page.locator('.prism-attachment[data-kind="audio"] audio[controls]')).toHaveAttribute("src", "/api/attachments/a_wav");
  await expect(page.locator('.prism-attachment[data-kind="video"] video[controls]')).toHaveAttribute("src", "/api/attachments/a_webm");
  // A generic file shows its name and size and downloads.
  const file = page.locator('.prism-attachment[data-kind="file"]');
  await expect(file).toContainText("dataset.zip");
  await expect(file).toContainText(/\d+ B/);
  const download = page.waitForEvent("download");
  await file.getByRole("button", { name: "Download dataset.zip" }).click();
  expect((await download).suggestedFilename()).toBe("dataset.zip");
  // Stored HTML is plain and readable without Prism.
  const stored = await html(page);
  expect(stored).toContain('data-type="attachment"');
  expect(stored).toContain('data-kind="pdf"');
  expect(stored).toMatch(/<a href="\/api\/attachments\/a_pdf"[^>]*>brief\.pdf<\/a>/);
  // SVG / HTML files are refused before upload.
  await pasteFiles(page, [{ name: "logo.svg", type: "image/svg+xml", bytes: "<svg/>" }]);
  await expect(page.getByRole("alert").first()).toBeVisible();
  // The slash menu offers the file blocks.
  await caretAfter(page, "Closing heron note.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/pdf");
  await expect(page.getByRole("option", { name: /^PDF/ })).toBeVisible();
  await page.keyboard.press("Escape");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/media-blocks.png`, fullPage: true });
  // Survives a reload of the stored HTML (round-trip).
  await page.goto(`/e2e-fixtures/notion-media.html?content=${enc(stored)}`);
  await expect(page.locator(".prism-attachment")).toHaveCount(4);
  expect(await html(page)).toBe(stored);
});

test("pasted URL offers bookmark card", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-media.html?content=" + enc("<p>Start</p><p></p><p>End</p>"));
  await page.locator(".tiptap p").nth(1).click();
  await pasteText(page, "https://atlas.example.org/rivers");
  const menu = page.getByRole("listbox", { name: "Paste as" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveText([/Mention/, /URL/, /Bookmark/]); // not embeddable → no Embed
  // The URL is already a link (nothing is lost if the menu is ignored).
  expect(await html(page)).toContain('<a target="_blank" rel="noopener noreferrer nofollow" href="https://atlas.example.org/rivers">');
  await menu.getByRole("option", { name: /Bookmark/ }).click();
  const card = page.locator(".prism-bookmark-block");
  await expect(card.locator(".prism-bookmark-title")).toHaveText("Watershed atlas");
  await expect(card).toContainText("Maps and field notes for the Front Range watersheds.");
  await expect(card.locator(".prism-bookmark-favicon")).toBeVisible();
  await expect(card.locator(".prism-bookmark-image img")).toBeVisible();
  const stored = await html(page);
  expect(stored).toContain('data-type="bookmark"');
  expect(stored).toContain('data-title="Watershed atlas"');
  expect(stored).not.toContain('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://atlas.example.org/rivers">'); // the bare link became the card
  expect(await page.evaluate(() => (window as any).prismMediaUnfurls)).toEqual(["https://atlas.example.org/rivers"]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bookmark-card.png` });
  // Esc keeps the plain link.
  await caretAfter(page, "End");
  await page.keyboard.press("Enter");
  await pasteText(page, "https://atlas.example.org/lakes");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await html(page)).toContain('href="https://atlas.example.org/lakes">https://atlas.example.org/lakes</a>');
  // Mention: the link text becomes the page title.
  await page.keyboard.press("Enter");
  await pasteText(page, "https://atlas.example.org/peaks");
  await menu.getByRole("option", { name: /Mention/ }).click();
  await expect.poll(() => html(page)).toContain('href="https://atlas.example.org/peaks">Watershed atlas</a>');
});

test("allowlisted embeds render; others fall back", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-media.html?content=" + enc("<p>Start</p><p></p>"));
  await page.locator(".tiptap p").nth(1).click();
  await pasteText(page, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s");
  const menu = page.getByRole("listbox", { name: "Paste as" });
  await menu.getByRole("option", { name: /Embed YouTube/ }).click();
  const embed = page.locator('.prism-embed[data-provider="youtube"]');
  const frame = embed.locator("iframe");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=65");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation");
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  // Stored: only the pasted URL, never an iframe or its src.
  const stored = await html(page);
  expect(stored).toMatch(/<div (?=[^>]*data-type="embed")(?=[^>]*data-url="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=1m5s")[^>]*>/);
  expect(stored).not.toContain("<iframe");
  // Resize handle → stored height (keyboard here; pointer drag uses the same commit path).
  const grip = embed.getByRole("separator", { name: "Resize embed" });
  const before = (await embed.locator(".prism-embed-frame").boundingBox())!.height;
  await grip.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => html(page)).toMatch(/data-height="\d+"/);
  expect(Number((await html(page)).match(/data-height="(\d+)"/)![1])).toBe(Math.round(before + 40));
  await expect.poll(async () => Math.round((await embed.locator(".prism-embed-frame").boundingBox())!.height)).toBe(Math.round(before + 40));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/embed-youtube.png` });

  // Every provider on the list maps to its player; unknown hosts fall back to a card.
  const cases = [
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
    ["https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184", "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184"],
    ["https://www.figma.com/design/AbCdEf123456/Atlas", "https://www.figma.com/embed?embed_host=prism&url="],
    ["https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit", "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/preview"],
    ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"],
    ["https://x.com/prism/status/1234567890123", "https://platform.twitter.com/embed/Tweet.html?id=1234567890123"],
  ];
  const content = cases.map(([u]) => `<div data-type="embed" data-url="${u}"></div>`).join("") + '<div data-type="embed" data-url="https://unknown.example.com/watch/1"></div><div data-type="embed" data-url="javascript:alert(1)"></div>';
  await page.goto("/e2e-fixtures/notion-media.html?content=" + enc(content));
  const frames = page.locator(".prism-embed iframe");
  await expect(frames).toHaveCount(cases.length);
  for (const [i, [, src]] of cases.entries()) expect(await frames.nth(i).getAttribute("src")).toContain(src);
  // Unsupported host → a bookmark card, never a blank frame.
  const fallback = page.locator(".prism-embed[data-fallback]");
  await expect(fallback).toHaveCount(1);
  await expect(fallback).toContainText("https://unknown.example.com/watch/1");
  await expect(fallback).toContainText("can't be embedded");
  // A javascript: URL is not an embed at all (and never a frame).
  expect(await html(page)).not.toContain("javascript:");
});

test("H1: a 'pdf'/'video' block never frames or plays a URL that is not our own attachment", async ({ page, context }) => {
  await context.route("https://evil.example/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>elsewhere</title>" }));
  const hostile = [
    '<div data-type="attachment" data-kind="pdf" data-src="https://evil.example/phish.html" data-name="invoice.pdf"><a href="https://evil.example/phish.html">invoice.pdf</a></div>',
    '<div data-type="attachment" data-kind="video" data-src="https://evil.example/x.mp4" data-name="clip.mp4"><a href="https://evil.example/x.mp4">clip.mp4</a></div>',
    '<div data-type="attachment" data-kind="pdf" data-src="/auth/logout" data-name="same-origin.pdf"><a href="/auth/logout">same-origin.pdf</a></div>',
    '<div data-type="attachment" data-kind="pdf" data-src="/api/attachments/a_pdf" data-name="real.pdf"><a href="/api/attachments/a_pdf">real.pdf</a></div>',
  ].join("");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/e2e-fixtures/notion-media.html?content=" + enc(hostile));
  // Only the real attachment is framed.
  await expect(page.locator(".prism-attachment iframe")).toHaveCount(1);
  await expect(page.locator(".prism-attachment iframe")).toHaveAttribute("src", "/api/attachments/a_pdf");
  await expect(page.locator(".prism-attachment video, .prism-attachment audio")).toHaveCount(0);
  // The https ones stay plain cards; the same-origin path is not a block at all (its link text survives).
  await expect(page.locator(".prism-attachment")).toHaveCount(3);
  await expect(page.locator(".tiptap")).toContainText("same-origin.pdf");
  expect(requests.filter((u) => new URL(u).hostname === "evil.example" || new URL(u).pathname === "/auth/logout")).toEqual([]);
  // "Download" on an https card opens a new tab; it is never fetched with our credentials.
  const popup = page.waitForEvent("popup");
  await page.locator(".prism-attachment").first().getByRole("button", { name: /Download invoice.pdf/ }).click();
  const opened = await popup;
  await opened.waitForLoadState();
  expect(opened.url()).toBe("https://evil.example/phish.html");
  expect(requests.filter((u) => new URL(u).hostname === "evil.example").length).toBe(0); // only the popup (a separate page) goes there
});

test("H2: relative and odd-scheme images are kept in the document", async ({ page }) => {
  const content = '<p>a</p><img src="images/diagram.png" alt="rel"><img src="//cdn.example.org/x.png" alt="pr"><img src="cid:part1@example.org" alt="cid"><p>b</p>';
  await page.route("**/cdn.example.org/**", (r) => r.abort());
  await page.goto("/e2e-fixtures/notion-media.html?content=" + enc(content));
  await expect(page.locator("figure.prism-image")).toHaveCount(3);
  await page.getByText("b", { exact: true }).click();
  await page.keyboard.type(" edited");
  const stored = await html(page);
  for (const src of ["images/diagram.png", "//cdn.example.org/x.png", "cid:part1@example.org"]) expect(stored).toContain(`src="${src}"`);
});

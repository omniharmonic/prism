import { test, expect, type Page } from "@playwright/test";
import { chromiumOnly } from "./browser-compat";

/**
 * Slice J · NP-CO-12 "A Suggesting mode marks inserts and deletes with attribution": every way of
 * taking text out while Suggesting leaves it in the document as a tracked deletion — typing,
 * pasting, composing (IME), Enter, cut and a drop over a selection, also across blocks.
 * Fixture: parity4-suggest.html (the live editor on a local Y.Doc + a collaborator's editor).
 *
 * Every read of the document (`html`, `count`, `chips`) is the COLLABORATOR's copy — the second
 * editor, fed only by the shared Y.Doc — and after every test (and before every Accept / Reject
 * all) the author's document must equal it, marks included: what only the author's session
 * holds does not count.
 */
/** The IME tests run on Chromium only (a named skip elsewhere): WebKit has no way to drive a composition. */
const IME_BY_CDP = "the composition is synthesised with CDP Input.imeSetComposition";
const fx = <T>(page: Page, fn: string, ...args: unknown[]) => page.evaluate(([name, rest]) => (window as any).suggestFixture[name as string](...(rest as unknown[])), [fn, args]) as Promise<T>;
const struck = (page: Page, text?: string) => page.locator('.ProseMirror [data-suggestion="delete"]', text ? { hasText: text } : undefined);
const added = (page: Page, text?: string) => page.locator('.ProseMirror [data-suggestion="insert"]', text ? { hasText: text } : undefined);
const paragraphs = (page: Page) => page.locator(".ProseMirror").first().locator("p");

async function open(page: Page, suggesting = true) {
  await page.goto("/e2e-fixtures/parity4-suggest.html");
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("The rollout plan is ready for review.");
  if (suggesting) {
    await page.getByRole("button", { name: "Editing", exact: true }).click();
    await expect(page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
  }
  await editor.click();
  return editor;
}
/** The collaborator sees exactly what the author sees (text, nodes and marks). */
const same = (page: Page) => expect.poll(() => page.evaluate(() => (window as any).suggestFixture?.diverged?.() ?? "")).toBe("");
const rejectAll = async (page: Page) => { await same(page); await page.getByRole("button", { name: "Reject all suggestions" }).click(); await same(page); };
const acceptAll = async (page: Page) => { await same(page); await page.getByRole("button", { name: "Accept all suggestions" }).click(); await same(page); };
test.afterEach(async ({ page }) => { await same(page); });

test("typing over a selection keeps the replaced text as a tracked deletion — one Yjs update, one undo step", async ({ page }) => {
  await open(page);
  await fx(page, "select", "rollout");
  const before = await fx<number>(page, "updates");
  await page.keyboard.type("l");
  expect(await fx<number>(page, "updates")).toBe(before + 1); // the removal and its record are one change
  await page.keyboard.type("aunch");
  await expect(added(page, "launch")).toBeVisible();
  await expect(struck(page, "rollout")).toBeVisible();
  for (const who of await page.locator(".ProseMirror [data-suggestion]").evaluateAll((els) => els.map((el) => el.getAttribute("data-user")))) expect(who).toBe("You");
  // The caret stayed behind the new word.
  await page.keyboard.type("!");
  await expect(added(page, "launch!")).toBeVisible();
  // One undo takes the whole replacement back: the original sentence, nothing pending.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
});

test("rejecting brings the replaced words back; accepting removes them", async ({ page }) => {
  await open(page);
  await fx(page, "select", "rollout");
  await page.keyboard.type("launch");
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
  await fx(page, "select", "ready");
  await page.keyboard.type("set");
  await acceptAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is set for review.");
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
});

test("pasting over a selection keeps the replaced text", async ({ page }) => {
  await open(page);
  await fx(page, "select", "rollout");
  await fx(page, "paste", "migration");
  await expect(added(page, "migration")).toBeVisible();
  await expect(struck(page, "rollout")).toBeVisible();
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
});

test("Enter over a selection keeps the selected text, struck, and still starts the new paragraph", async ({ page }) => {
  await open(page);
  await fx(page, "select", " is ready");
  await page.keyboard.press("Enter");
  await expect(struck(page, "is ready")).toBeVisible();
  await expect(paragraphs(page).nth(0)).toHaveText("The rollout plan is ready");
  await expect(paragraphs(page).nth(1)).toHaveText(" for review.");
  await page.keyboard.type("Now");
  await expect(paragraphs(page).nth(1)).toHaveText("Now for review.");
});

test("cut keeps the text as a tracked deletion", async ({ page }) => {
  await open(page);
  await fx(page, "select", "rollout ");
  await page.keyboard.press("ControlOrMeta+x");
  await expect(struck(page, "rollout")).toBeVisible();
  await expect(added(page)).toHaveCount(0);
  // The caret sits before the struck text (where Backspace leaves it): typing goes in front.
  await page.keyboard.type("new ");
  await expect(paragraphs(page).first()).toHaveText("The new rollout plan is ready for review.");
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
});

test("a drop that moves a selection strikes it where it was and marks it where it lands", async ({ page }) => {
  await open(page);
  await fx(page, "select", "rollout ");
  await fx(page, "dropSelectionAfter", "ready ");
  await expect(struck(page, "rollout")).toBeVisible();
  await expect(added(page, "rollout")).toBeVisible();
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
});

test("typing over a selection that spans two paragraphs keeps both paragraphs and strikes both halves", async ({ page }) => {
  await open(page);
  await fx(page, "keepBlock", "closing", 3);
  const blocks = await fx<number>(page, "blocks");
  await fx(page, "selectAcross", "ready for review.", "Second paragraph");
  await page.keyboard.type("X");
  await expect(struck(page, "ready for review.")).toBeVisible();
  await expect(struck(page, "Second paragraph")).toBeVisible();
  await expect(added(page, "X")).toBeVisible();
  expect(await fx<number>(page, "blocks")).toBe(blocks);
  // A block the change never touched is the same Yjs element (nothing was rebuilt around it).
  expect(await fx<boolean>(page, "sameBlock", "closing", 3)).toBe(true);
  await rejectAll(page);
  await expect(paragraphs(page).nth(0)).toHaveText("The rollout plan is ready for review.");
  await expect(paragraphs(page).nth(1)).toHaveText("Second paragraph stays here.");
});

test("the person's own pending insertion simply disappears when typed over", async ({ page }) => {
  await open(page);
  await fx(page, "caretAfter", "plan");
  await page.keyboard.type(" draft");
  await expect(added(page, "draft")).toBeVisible();
  await fx(page, "select", "draft");
  await page.keyboard.type("v2");
  await expect(added(page, "v2")).toBeVisible();
  await expect(struck(page)).toHaveCount(0);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan v2 is ready for review.");
});

test("a block that cannot be marked (a divider) is put back, with a notice; the text around it is struck", async ({ page }) => {
  const editor = await open(page);
  await expect(editor.locator("hr")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Z");
  await expect(editor.locator("hr")).toHaveCount(1);
  await expect(struck(page, "Closing line.")).toBeVisible();
  await expect(struck(page, "The rollout plan is ready for review.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "can’t be removed while suggesting" })).toBeVisible();
  await rejectAll(page);
  await expect(paragraphs(page).nth(0)).toHaveText("The rollout plan is ready for review.");
  await expect(editor).not.toContainText("Z");
});

test("composing (IME) over a selection keeps the replaced text, and the composition is not interrupted", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await open(page);
  await fx(page, "select", "rollout");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ｋ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  // Still ONE composition: the half-typed character was replaced, not committed beside the next one.
  await expect(paragraphs(page).first()).toHaveText("The か plan is ready for review.");
  await cdp.send("Input.insertText", { text: "火" });
  // The composition is over: the replaced word is back, struck, before the new character.
  await expect(struck(page, "rollout")).toBeVisible();
  await expect(added(page, "火")).toBeVisible();
  await expect(paragraphs(page).first()).toHaveText("The rollout火 plan is ready for review.");
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.");
});

test("not suggesting: typing over a selection is a plain edit; a collaborator's removal is never re-marked", async ({ page }) => {
  await open(page, false);
  await fx(page, "select", "rollout");
  await page.keyboard.type("launch");
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
  await expect(paragraphs(page).first()).toHaveText("The launch plan is ready for review.");
  // Now suggesting: what arrives from someone else is theirs, not a suggestion of ours.
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await fx(page, "peerDelete", "Second ");
  await expect(paragraphs(page).nth(1)).toHaveText("paragraph stays here.");
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
});

// ── NP-CO-12 / NP-AI-02: "a stale suggestion shows Needs refresh" ───────────
const identified = (kind: "insert" | "delete", text: string) => `<span data-suggestion="${kind}" data-suggestion-id="s-1" data-actor-id="h_agent" data-user="Olive Owner (agent)" data-color="#64748b">${text}</span>`;
const agentPage = `<p>We ship ${identified("delete", "next month")}${identified("insert", "on Friday morning")}.</p><p>Second paragraph.</p>`;

test("Needs refresh: a suggestion a collaborator edits while it is being reviewed cannot be accepted unread", async ({ page }) => {
  await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(agentPage)}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("on Friday morning");
  const review = page.locator("details.prism-suggestion-review");
  await review.locator("summary").click();
  await expect(review.locator(".prism-review-after")).toContainText("on Friday morning");
  await expect(review.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await expect(review.getByText("Needs refresh")).toHaveCount(0);
  // Someone else edits a part of the page the change does not touch: nothing is stale.
  await fx(page, "peerTypeAfter", "Second paragraph", " grows");
  await expect(editor).toContainText("Second paragraph grows.");
  await expect(review.getByText("Needs refresh")).toHaveCount(0);
  // The reviewer's own edit inside the suggestion is theirs: not stale either.
  await fx(page, "typeAfter", "Friday", " early");
  await expect(review.locator(".prism-review-after")).toContainText("on Friday early morning");
  await expect(review.getByText("Needs refresh")).toHaveCount(0);
  // A collaborator rewrites the suggested words: the change on screen is not what was read.
  await fx(page, "peerTypeAfter", "early", " sunny");
  await expect(review.getByText("Needs refresh")).toBeVisible();
  await expect(review.getByRole("status")).toContainText("edited after you opened it");
  await expect(review.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
  // The inline bubble's Accept is withheld too: nothing is applied, and it says why.
  await fx(page, "caretAfter", "Friday");
  await page.locator(".cd-bubble").getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status").filter({ hasText: "edited after you opened it — Refresh" })).toBeVisible();
  await expect(added(page, "on Friday early sunny morning")).toBeVisible();
  await expect(struck(page, "next month")).toBeVisible();
  // Refresh: the current words are on screen, and can be accepted.
  await review.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(review.getByText("Needs refresh")).toHaveCount(0);
  await expect(review.locator(".prism-review-after")).toContainText("on Friday early sunny morning");
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(paragraphs(page).first()).toHaveText("We ship on Friday early sunny morning.");
});

// ── review round: what is NOT a removal, and what cannot be tracked ─────────
const chip = '<span data-type="mention" data-kind="date" data-date="2026-10-01" data-mention-uid="chip-1">@x</span>';
const leafPage = `<p>Due ${chip} for the team.</p><img src="/e2e-fixtures/fixture-image.svg" alt="chart"><p>Second paragraph stays here.</p><p>Closing line.</p>`;
const openWith = async (page: Page, html: string) => {
  await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(html)}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("Closing line.");
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
  await editor.click();
  return editor;
};
const refusedNotice = (page: Page) => page.getByRole("status").filter({ hasText: "can’t be removed while suggesting" });

test("B1: pasting one image over another while Suggesting keeps the first (with a notice) — never an unmarked swap", async ({ page }) => {
  await openWith(page, leafPage);
  await fx(page, "pasteNodeOver", "image", { src: "/e2e-fixtures/fixture-image.svg?other", alt: "other" });
  // The image that was there is still there; the pasted one is beside it.
  expect(await fx<number>(page, "count", "image")).toBe(2);
  expect(await fx<string>(page, "html")).toContain('alt="chart"');
  await expect(refusedNotice(page)).toBeVisible();
});

test("B1: pasting one chip over another while Suggesting keeps the first (with a notice) — for every collaborator", async ({ page }) => {
  await openWith(page, leafPage);
  await fx(page, "pasteNodeOver", "mention", { kind: "date", date: "2027-01-01", uid: "chip-2" });
  // Marks do not travel on chips, so nothing pretends to be "struck": both chips are simply there.
  await same(page);
  expect(await fx<Array<{ uid: string; date: string; marks: string[] }>>(page, "chips")).toEqual([{ uid: "chip-1", date: "2026-10-01", marks: [] }, { uid: "chip-2", date: "2027-01-01", marks: [] }]);
  await expect(refusedNotice(page)).toBeVisible();
});

test("B1: \"Remind me\" still leaves ONE chip; a date chip cannot be changed while Suggesting", async ({ page }) => {
  const editor = await openWith(page, leafPage);
  await fx(page, "remind", "chip-1");
  expect(await fx<number>(page, "count", "mention")).toBe(1);
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
  // The date popover is read-only, and says why.
  await editor.locator("[data-date-chip]").click();
  const popover = page.getByRole("dialog", { name: "Edit date" });
  await expect(popover).toBeVisible();
  await expect(popover.locator('input[type="date"]')).toHaveCount(0);
  await expect(popover.locator("[data-date-readonly]")).toContainText("can’t be changed while suggesting");
  await page.keyboard.press("Escape");
  // Back in Editing it can be changed.
  await page.getByRole("button", { name: "Suggesting", exact: true }).click();
  await editor.locator("[data-date-chip]").click();
  await expect(page.getByRole("dialog", { name: "Edit date" }).locator('input[type="date"]')).toHaveCount(1);
});

test("S4: text dragged with a chip inside — the chip stays where it was; Reject all restores the original exactly", async ({ page }) => {
  await openWith(page, leafPage);
  await fx(page, "selectAcross", "Due ", " for");
  await fx(page, "dropSelectionAfter", "Closing");
  await same(page);
  // One chip, for everyone, still in the first paragraph; the text around it is struck there and inserted at the drop.
  expect(await fx<Array<{ uid: string; date: string; marks: string[] }>>(page, "chips")).toEqual([{ uid: "chip-1", date: "2026-10-01", marks: [] }]);
  await expect(paragraphs(page).first().locator('[data-type="mention"]')).toHaveCount(1);
  await expect(paragraphs(page).last().locator('[data-type="mention"]')).toHaveCount(0);
  await expect(struck(page, "Due")).toBeVisible();
  await expect(added(page, "Due")).toBeVisible();
  await expect(refusedNotice(page)).toBeVisible();
  await rejectAll(page);
  expect(await fx<Array<{ uid: string; date: string; marks: string[] }>>(page, "chips")).toEqual([{ uid: "chip-1", date: "2026-10-01", marks: [] }]);
  await expect(paragraphs(page).first()).toContainText("for the team.");
  await expect(paragraphs(page).last()).toHaveText("Closing line.");
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
});

test("S4: text dragged with a chip inside — Accept all moves the text and leaves the one chip where it was", async ({ page }) => {
  await openWith(page, leafPage);
  await fx(page, "selectAcross", "Due ", " for");
  await fx(page, "dropSelectionAfter", "Closing");
  await acceptAll(page);
  expect(await fx<number>(page, "count", "mention")).toBe(1);
  await expect(paragraphs(page).first().locator('[data-type="mention"]')).toHaveCount(1);
  await expect(paragraphs(page).last().locator('[data-type="mention"]')).toHaveCount(0);
  await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
});

test("a chip or a line break put in while Suggesting carries no mark only its author would see; Backspace on a chip is refused", async ({ page }) => {
  await openWith(page, "<p>First line here.</p><p>Closing line.</p>");
  await fx(page, "caretAfter", "First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("new");
  await same(page);
  await expect(added(page, "new")).toBeVisible();
  // Backspace over a selection that holds a chip changes nothing, and says why.
  await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(leafPage)}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("Closing line.");
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await editor.click();
  await fx(page, "selectAcross", "Due ", " for");
  await page.keyboard.press("Backspace");
  await expect(refusedNotice(page)).toBeVisible();
  await expect(struck(page)).toHaveCount(0);
  expect(await fx<number>(page, "count", "mention")).toBe(1);
});

test("Backspace over ordinary text mixed with inline code strikes the text and removes the code, with the notice", async ({ page }) => {
  await openWith(page, "<p>Run <code>npm install</code> now.</p><p>Closing line.</p>");
  await fx(page, "selectAcross", "Run ", " now");
  await page.keyboard.press("Backspace");
  await same(page);
  await expect(page.getByRole("status").filter({ hasText: "inside code aren’t tracked" })).toBeVisible();
  await expect(struck(page, "Run")).toBeVisible();
  await expect(paragraphs(page).first()).not.toContainText("npm install");
  await rejectAll(page);
  await expect(paragraphs(page).first()).toHaveText("Run  now.");
});

test("J-2: an image block dragged elsewhere moves — one image, no notice", async ({ page }) => {
  await openWith(page, leafPage);
  await fx(page, "dragNodeAfter", "image", "Second paragraph");
  expect(await fx<number>(page, "count", "image")).toBe(1);
  const order = await page.locator(".ProseMirror").first().evaluate((el) => [...el.children].map((c) => (c.querySelector("img") || c.tagName === "IMG" ? "img" : "p")));
  expect(order.indexOf("img")).toBeGreaterThan(1);
  await expect(refusedNotice(page)).toHaveCount(0);
});

test("J-3: text held during a composition goes back in place after a collaborator's edit earlier in the page", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await open(page);
  const blocks = await fx<number>(page, "blocks");
  await fx(page, "select", "paragraph"); // in the SECOND block
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  // Mid-composition, someone else types in the block before it (every later position shifts).
  await fx(page, "peerTypeAfter", "The rollout", " and migration");
  // Still composing, still held: nothing was put beside the composing text.
  await expect(struck(page)).toHaveCount(0);
  await expect(paragraphs(page).nth(1)).toHaveText("Second か stays here.");
  await cdp.send("Input.insertText", { text: "火" });
  // The composition is over: the replaced word is back in ITS sentence — not at the top of the page.
  await expect(struck(page, "paragraph")).toBeVisible();
  expect(await fx<number>(page, "blocks")).toBe(blocks);
  await expect(paragraphs(page).nth(1)).toHaveText("Second paragraph火 stays here.");
  await expect(paragraphs(page).first()).toHaveText("The rollout and migration plan is ready for review.");
});

test("S1: held text survives a blur mid-composition, returns when the composition ends, and is flushed to the shared document on unmount", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await open(page);
  await fx(page, "select", "rollout");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await expect(struck(page)).toHaveCount(0);
  // Focus is reported lost mid-composition (an IME window): nothing is put beside the composing text.
  await page.evaluate(() => document.querySelector(".ProseMirror")!.dispatchEvent(new FocusEvent("blur")));
  await page.waitForTimeout(300);
  await expect(struck(page)).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "火" });
  await expect(struck(page, "rollout")).toBeVisible();
  await same(page);
  // Not composing: a blur with something held puts it back at once. Then the editor goes away mid-composition.
  await fx(page, "select", "Second");
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  expect(await fx<string>(page, "ydoc")).not.toContain("Second");
  await fx(page, "unmount");
  await expect.poll(() => fx<string>(page, "ydoc")).toMatch(/<deletion[^>]*>Second<\/deletion>/);
  expect(await fx<string>(page, "html")).toContain("Second"); // the collaborator has it, struck
});

test("S3: a to-do's checkbox cannot be clicked while Suggesting (it would be an untracked change)", async ({ page }) => {
  const editor = await openWith(page, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Ship it</p></div></li></ul><p>Closing line.</p>');
  const box = editor.locator('ul[data-type="taskList"] li input[type="checkbox"]');
  await box.click();
  await expect(box).not.toBeChecked();
  expect(await fx<string>(page, "html")).toContain('data-checked="false"');
  await expect(page.getByRole("status").filter({ hasText: "Checking a to-do isn’t tracked" })).toBeVisible();
  // In Editing it checks.
  await page.getByRole("button", { name: "Suggesting", exact: true }).click();
  await box.click();
  await expect(box).toBeChecked();
  expect(await fx<string>(page, "html")).toContain('data-checked="true"');
});

test("J-4: inside code a replacement is applied directly, with a notice — never old and new text side by side", async ({ page }) => {
  await openWith(page, "<p>Run <code>npm install</code> now.</p><pre><code>const a = 1;</code></pre><p>Closing line.</p>");
  await fx(page, "select", "install");
  await page.keyboard.type("ci");
  await expect(paragraphs(page).first()).toHaveText("Run npm ci now.");
  await expect(page.getByRole("status").filter({ hasText: "inside code aren’t tracked" })).toBeVisible();
  // Backspace inside code deletes (it used to move the caret and delete nothing).
  await fx(page, "caretAfter", "npm ci");
  await page.keyboard.press("Backspace");
  await expect(paragraphs(page).first()).toHaveText("Run npm c now.");
  await fx(page, "select", "1;");
  await page.keyboard.type("2;");
  await expect(page.locator(".ProseMirror pre").first()).toHaveText("const a = 2;");
  await expect(struck(page)).toHaveCount(0);
});

test("J-6: a long composition is never interrupted by the put-back", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await open(page);
  await fx(page, "select", "rollout");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ｋ", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(1500); // the person takes their time choosing
  await expect(struck(page)).toHaveCount(0); // still composing: nothing was redrawn around the text
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await expect(paragraphs(page).first()).toHaveText("The か plan is ready for review.");
  await cdp.send("Input.insertText", { text: "火" });
  await expect(struck(page, "rollout")).toBeVisible();
  await expect(paragraphs(page).first()).toHaveText("The rollout火 plan is ready for review.");
});

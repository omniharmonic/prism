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
const openWith = async (page: Page, html: string, marker = "Closing line.") => {
  await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(html)}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText(marker);
  await page.getByRole("button", { name: "Editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Suggesting", exact: true })).toBeVisible();
  await editor.click();
  return editor;
};
const refusedNotice = (page: Page) => page.getByRole("status").filter({ hasText: "can’t be removed while suggesting" });

test("B1: pasting one image over another while Suggesting changes nothing (with a notice) — never an unmarked swap, never an untracked second image", async ({ page }) => {
  await openWith(page, leafPage);
  const before = await fx<string>(page, "html");
  await fx(page, "pasteNodeOver", "image", { src: "/e2e-fixtures/fixture-image.svg?other", alt: "other" });
  // The image that was there is still there, and no other came in: an image has no tracked form.
  await expect(page.getByRole("status").filter({ hasText: "can’t be added while suggesting" })).toBeVisible();
  await same(page);
  expect(await fx<number>(page, "count", "image")).toBe(1);
  expect(await fx<string>(page, "html")).toBe(before);
});

type Chip = { uid: string; suggestion: string | null };
test("B1: pasting one chip over another while Suggesting is a tracked replacement — Reject all keeps the first, Accept all the second", async ({ page }) => {
  for (const review of [rejectAll, acceptAll]) {
    await openWith(page, leafPage);
    await fx(page, "pasteNodeOver", "mention", { kind: "date", date: "2027-01-01", uid: "chip-2" });
    await same(page);
    // For every collaborator: the old chip is a suggested removal, the new one a suggested insertion.
    expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "chip-1", suggestion: "delete" }, { uid: "chip-2", suggestion: "insert" }]);
    await expect(refusedNotice(page)).toHaveCount(0);
    await review(page);
    expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: review === rejectAll ? "chip-1" : "chip-2", suggestion: null }]);
  }
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

test("S4: text dragged with a chip inside is a tracked move, chip included — Reject all restores the original exactly, Accept all moves it", async ({ page }) => {
  for (const review of [rejectAll, acceptAll]) {
    await openWith(page, leafPage);
    const before = await fx<string>(page, "html");
    await fx(page, "selectAcross", "Due ", " for");
    await fx(page, "dropSelectionAfter", "Closing");
    await same(page);
    // The chip where it was is a suggested removal, its copy at the drop a suggested insertion — like the words around it.
    expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "chip-1", suggestion: "delete" }, { uid: "chip-1", suggestion: "insert" }]);
    await expect(struck(page, "Due")).toBeVisible();
    await expect(added(page, "Due")).toBeVisible();
    await expect(refusedNotice(page)).toHaveCount(0);
    await review(page);
    expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "chip-1", suggestion: null }]);
    await expect(paragraphs(page).first().locator('[data-type="mention"]')).toHaveCount(review === rejectAll ? 1 : 0);
    await expect(paragraphs(page).last().locator('[data-type="mention"]')).toHaveCount(review === rejectAll ? 0 : 1);
    if (review === rejectAll) expect(await fx<string>(page, "html")).toBe(before);
    await expect(page.locator(".ProseMirror [data-suggestion]")).toHaveCount(0);
  }
});

// Every inline atom of the schema has a tracked form while Suggesting — none is put in or taken
// out as a plain edit. The list is read from the schema: a new inline node type fails here until
// it is covered (editor/suggestionNodes `SUGGESTION_INLINE_ATOMS`).
const CHIPS: Array<{ name: string; attrs: Record<string, unknown> }> = [
  { name: "person mention", attrs: { kind: "person", id: "people/ada", label: "Ada", uid: "new-chip" } },
  { name: "page mention", attrs: { kind: "page", id: "notes/plan", label: "Plan", uid: "new-chip" } },
  { name: "date chip", attrs: { kind: "date", date: "2027-03-04", uid: "new-chip" } },
];
test("the schema's inline atoms are exactly the ones Suggesting tracks: a line break and a chip", async ({ page }) => {
  await open(page);
  expect(await fx<string[]>(page, "inlineAtoms")).toEqual(["hardBreak", "mention"]);
});
for (const chipKind of CHIPS) {
  test(`a ${chipKind.name} put in while Suggesting is a suggestion: Reject all removes it, Accept all keeps it; the author's Backspace takes their own out`, async ({ page }) => {
    await open(page);
    const before = await html(page);
    for (const review of [rejectAll, acceptAll]) {
      await fx(page, "caretAfter", "The rollout plan");
      await fx(page, "insertChip", chipKind.attrs);
      await same(page);
      expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "new-chip", suggestion: "insert" }]);
      expect(await html(page)).toContain('data-suggestion-node="insert" data-suggestion-by="You"');
      await expect(page.locator(".ProseMirror .prism-suggested-chip-insert")).toHaveCount(1);
      await review(page);
      if (review === rejectAll) expect(await html(page)).toBe(before);
    }
    expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "new-chip", suggestion: null }]);
    // Removing a chip that is there: a suggested removal (Reject keeps it, Accept removes it) — never refused, never a plain removal.
    const withChip = await html(page);
    for (const review of [rejectAll, acceptAll]) {
      await fx(page, "caretAfter", "The rollout plan");
      await page.keyboard.press("Delete");
      await same(page);
      expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "new-chip", suggestion: "delete" }]);
      await expect(refusedNotice(page)).toHaveCount(0);
      await review(page);
      if (review === rejectAll) expect(await html(page)).toBe(withChip);
    }
    expect(await html(page)).toBe(before);
    // Their own pending chip: Backspace right after putting it in is no suggestion at all.
    await fx(page, "caretAfter", "The rollout plan");
    await fx(page, "insertChip", chipKind.attrs);
    await page.keyboard.press("Backspace");
    await same(page);
    expect(await html(page)).toBe(before);
  });
}

test("Backspace over a selection that holds a chip strikes the words and suggests the chip's removal; a line break put in is a suggestion", async ({ page }) => {
  await openWith(page, leafPage);
  const before = await fx<string>(page, "html");
  await fx(page, "selectAcross", "Due ", " for");
  await page.keyboard.press("Backspace");
  await same(page);
  expect(await fx<Chip[]>(page, "chips")).toEqual([{ uid: "chip-1", suggestion: "delete" }]);
  await expect(struck(page, "Due")).toBeVisible();
  await expect(refusedNotice(page)).toHaveCount(0);
  await rejectAll(page);
  expect(await fx<string>(page, "html")).toBe(before);
  await fx(page, "caretAfter", "Closing");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("new");
  await same(page);
  await expect(added(page, "new")).toBeVisible();
  await rejectAll(page);
  expect(await fx<string>(page, "html")).toBe(before);
});

// ── Code: inline code and code blocks carry the suggestion marks like any text ───────────────
// (They used to exclude every mark, so a change inside code was applied directly, with a notice.)
const CODE_PAGE = "<p>Run <code>npm install</code> now.</p><pre><code>const a = 1;</code></pre><p>Closing line.</p>";
const codeNotice = (page: Page) => page.getByRole("status").filter({ hasText: /inside code|can’t carry a suggestion/ });
/** The same steps made by a plain (Editing) author: the page Accept all must give. */
const plainResult = async (page: Page, content: string, steps: (page: Page) => Promise<void>) => {
  await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(content)}`);
  await expect(page.locator(".ProseMirror").first()).toContainText("Closing line.");
  await page.locator(".ProseMirror").first().click();
  await steps(page);
  await same(page);
  return html(page);
};
const CODE_EDITS: Array<{ name: string; struck: string; added: string | null; steps: (page: Page) => Promise<void> }> = [
  { name: "inline code — typed over", struck: "install", added: "ci", steps: async (page) => { await fx(page, "select", "install"); await page.keyboard.type("ci"); } },
  { name: "inline code — pasted over", struck: "install", added: "ci", steps: async (page) => { await fx(page, "select", "install"); await fx(page, "paste", "ci"); } },
  { name: "inline code — Backspace", struck: "l", added: null, steps: async (page) => { await fx(page, "caretAfter", "npm install"); await page.keyboard.press("Backspace"); } },
  { name: "inline code — cut", struck: "npm ", added: null, steps: async (page) => { await fx(page, "select", "npm "); await page.keyboard.press("ControlOrMeta+x"); } },
  { name: "inline code mixed with ordinary text — Backspace", struck: "Run npm install now", added: null, steps: async (page) => { await fx(page, "selectAcross", "Run ", " now"); await page.keyboard.press("Backspace"); } },
  { name: "code block — typed over", struck: "1;", added: "2;", steps: async (page) => { await fx(page, "select", "1;"); await page.keyboard.type("2;"); } },
  { name: "code block — pasted over", struck: "const", added: "let", steps: async (page) => { await fx(page, "select", "const"); await fx(page, "paste", "let"); } },
  { name: "code block — Delete", struck: "c", added: null, steps: async (page) => { await fx(page, "caretBefore", "const"); await page.keyboard.press("Delete"); } },
  { name: "code block — typed at the caret", struck: "", added: " // note", steps: async (page) => { await fx(page, "caretAfter", "= 1;"); await page.keyboard.type(" // note"); } },
  { name: "code block — a new line (Enter)", struck: "", added: "b();", steps: async (page) => { await fx(page, "caretAfter", "= 1;"); await page.keyboard.press("Enter"); await page.keyboard.type("b();"); } },
];
for (const edit of CODE_EDITS) {
  test(`code — ${edit.name}: tracked like any text (no "applied directly"); Accept all gives the plain edit's page, Reject all the original`, async ({ page }) => {
    const plain = await plainResult(page, CODE_PAGE, edit.steps);
    for (const review of [rejectAll, acceptAll]) {
      await openWith(page, CODE_PAGE);
      const before = await html(page);
      await edit.steps(page);
      await same(page);
      // Every removed character is still there, struck, for every collaborator; what was typed is marked inserted.
      expect((await fx<string>(page, "struckText")).split("|").join("")).toBe(edit.struck);
      if (edit.added) await expect(added(page, edit.added.trim())).toBeVisible();
      await expect(codeNotice(page)).toHaveCount(0);
      expect(await fx<string>(page, "text")).toContain("npm install"); // nothing left the page
      await review(page);
      expect(await html(page)).toBe(review === rejectAll ? before : plain);
    }
  });
}

// A page whose stored body is MARKDOWN with a fenced block opens as exactly this HTML (the server's
// Markdown seed — apps/server/test/suggestions-markdown.test.ts follows the same page through
// store → load and back to Markdown): the fence keeps its language through suggest, accept and reject.
const FENCED_PAGE = '<p>Run <code>npm install</code> first.</p><pre><code class="language-js">const a = 1;\nnext();\n</code></pre><p>Closing line.</p>';
test("a fenced block of a Markdown page: an insertion and a deletion inside it are suggestions; Accept all gives the plain edit's page, Reject all the original — the fence and its language stay", async ({ page }) => {
  const steps = async (p: Page) => {
    await fx(p, "select", "1;");
    await p.keyboard.type("2;");
    await fx(p, "caretAfter", "next();");
    await p.keyboard.type(" // done");
    await fx(p, "select", "const ");
    await p.keyboard.press("Backspace");
  };
  const plain = await plainResult(page, FENCED_PAGE, steps);
  expect(plain).toContain('<pre><code class="language-js">a = 2;\nnext(); // done\n</code></pre>');
  for (const review of [rejectAll, acceptAll]) {
    await openWith(page, FENCED_PAGE);
    const before = await html(page);
    await steps(page);
    await same(page);
    expect((await fx<string>(page, "struckText")).split("|").join("")).toBe("const 1;");
    await expect(added(page, "2;")).toBeVisible();
    await expect(added(page, "// done")).toBeVisible();
    expect(await html(page)).toContain('<pre><code class="language-js">'); // for every collaborator, still the fence
    expect(await fx<number>(page, "count", "codeBlock")).toBe(1);
    await review(page);
    expect(await html(page)).toBe(review === rejectAll ? before : plain);
  }
});

test("code: an existing paragraph cannot be turned into a code block while Suggesting (refused); on a new line the code block and its text are a suggestion", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await caretBefore(page, "Second");
  await page.keyboard.type("``` ");
  await expect(structureNotice(page)).toBeVisible();
  await same(page);
  expect(await fx<number>(page, "count", "codeBlock")).toBe(0);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  // A split paragraph turned into code: the text that was there goes back into its paragraph on Reject.
  await fx(page, "caretAfter", "The rollout plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/code");
  await expect(page.getByRole("option", { name: "Code" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => fx<number>(page, "count", "codeBlock")).toBe(1);
  await page.keyboard.type("x = 1");
  await same(page);
  await expect(added(page, "x = 1")).toBeVisible();
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("J-2: an image block cannot be dragged elsewhere while Suggesting — a move has no tracked form: nothing changes, with the notice", async ({ page }) => {
  await openWith(page, leafPage);
  const before = await fx<string>(page, "html");
  await fx(page, "dragNodeAfter", "image", "Second paragraph");
  await expect(page.getByRole("status").filter({ hasText: "can’t be added while suggesting" })).toBeVisible();
  await same(page);
  expect(await fx<string>(page, "html")).toBe(before);
});

test("formatting text that was already there is refused while Suggesting (bold, inline code by shortcut); the author's own suggested text may be formatted", async ({ page }) => {
  await open(page);
  const before = await html(page);
  for (const key of ["ControlOrMeta+b", "ControlOrMeta+i", "ControlOrMeta+e"]) {
    await fx(page, "select", "rollout");
    await page.keyboard.press(key);
    await expect(page.getByRole("status").filter({ hasText: "Formatting text that was already there" })).toBeVisible();
    await same(page);
    expect(await html(page)).toBe(before);
  }
  // Their own pending words: formatting them is part of the suggestion — Reject all takes it all out.
  await fx(page, "caretAfter", "rollout");
  await page.keyboard.type(" brand");
  await fx(page, "select", "brand");
  await page.keyboard.press("ControlOrMeta+b");
  await same(page);
  expect(await html(page)).toContain("<strong>brand</strong>");
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("Tab in the last cell of a table adds a row as a suggestion: Reject all takes the row out again, Accept all keeps it", async ({ page }) => {
  const table = "<table><tbody><tr><th><p>head one</p></th><th><p>head two</p></th></tr><tr><td><p>cell one</p></td><td><p>cell two</p></td></tr></tbody></table><p>Closing line.</p>";
  for (const review of [rejectAll, acceptAll]) {
    await openWith(page, table);
    const before = await html(page);
    await fx(page, "caretAfter", "cell two");
    await page.keyboard.press("Tab");
    await expect.poll(() => fx<number>(page, "count", "tableRow")).toBe(3);
    await page.keyboard.type("new cell");
    await same(page);
    expect(await html(page)).toContain('data-suggestion-node="insert"');
    await review(page);
    expect(await fx<number>(page, "count", "tableRow")).toBe(review === rejectAll ? 2 : 3);
    if (review === rejectAll) expect(await html(page)).toBe(before);
    else expect(await html(page)).not.toContain("data-suggestion");
  }
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

// ── Review of PR #42, finding 1: a removal that crosses NESTING DEPTH ──────────────────────────
// From the middle of a paragraph into the first item of the list below (or out of a list, into a
// quote, into a table cell): ProseMirror writes that replacement as a ReplaceAroundStep (the rest
// of the last block is carried into the first). It is a removal like any other: the text taken out
// stays, struck, for every collaborator — and Reject all gives the page back.
const TABLE = "<table><tbody><tr><th><p>charlie delta</p></th><th><p>head two</p></th></tr><tr><td><p>cell one</p></td><td><p>cell two</p></td></tr></tbody></table>";
// `struck: null` = REFUSED: across the boundary of a table cell no put-back is faithful (the edit
// empties a cell and the removed part would come back as a table of its own), so nothing changes
// and the person is told. These selections are real: the tables plugin only normalises a text
// selection that ends at the very START of a cell's block (or is a NodeSelection of a cell / row);
// one that ends in the middle of a cell's text — a drag from the paragraph above, a phone's
// selection handles, Shift+click from outside the table — stays as it is.
const DEPTH_SHAPES: Array<{ name: string; html: string; from: string; to: string; struck: string | null; selected?: string }> = [
  { name: "paragraph → list item", html: "<p>alpha bravo</p><ul><li><p>charlie delta</p></li><li><p>echo</p></li></ul><p>End.</p>", from: "bravo", to: "charlie ", struck: "bravo|charlie " },
  { name: "list item → paragraph", html: "<ul><li><p>zulu</p></li><li><p>alpha bravo</p></li></ul><p>charlie delta</p><p>End.</p>", from: "bravo", to: "charlie ", struck: "bravo|charlie " },
  { name: "paragraph → quote", html: "<p>alpha bravo</p><blockquote><p>charlie delta</p></blockquote><p>End.</p>", from: "bravo", to: "charlie ", struck: "bravo|charlie " },
  { name: "paragraph → nested list item", html: "<p>alpha bravo</p><ul><li><p>one</p><ul><li><p>charlie delta</p></li><li><p>foxtrot</p></li></ul></li><li><p>golf</p></li></ul><p>End.</p>", from: "bravo", to: "charlie ", struck: "bravo|one|charlie ", selected: "bravo|one|charlie " },
  { name: "quote → paragraph", html: "<blockquote><p>alpha bravo</p></blockquote><p>charlie delta</p><p>End.</p>", from: "bravo", to: "charlie ", struck: "bravo|charlie " },
  { name: "table cell → paragraph after the table", html: `<p>Start.</p>${TABLE.replace("charlie delta", "head one").replace("cell two", "alpha bravo")}<p>charlie delta</p><p>End.</p>`, from: "bravo", to: "charlie ", struck: null },
  { name: "table cell → table cell", html: `<p>Start.</p>${TABLE.replace("cell one", "alpha bravo").replace("cell two", "charlie delta").replace("charlie delta", "head one")}<p>End.</p>`, from: "bravo", to: "charlie ", struck: null },
  { name: "paragraph → table cell", html: `<p>alpha bravo</p>${TABLE}<p>End.</p>`, from: "bravo", to: "charlie ", struck: null },
];
const DEPTH_ACTIONS: Array<{ name: string; keepsShape: boolean; run: (page: Page) => Promise<void> }> = [
  { name: "typed over", keepsShape: true, run: async (page) => { await page.keyboard.type("X"); } },
  { name: "pasted over", keepsShape: true, run: async (page) => { await fx(page, "paste", "X"); } },
  { name: "cut", keepsShape: true, run: async (page) => { await page.keyboard.press("ControlOrMeta+x"); } },
  // The blocks are separate already: Enter strikes the selection and moves on to what follows it.
  { name: "Enter", keepsShape: true, run: async (page) => { await page.keyboard.press("Enter"); } },
];
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
for (const shape of DEPTH_SHAPES) {
  for (const action of DEPTH_ACTIONS) {
    test(`across depth — ${shape.name}, ${action.name}: the removed text is kept struck where it stands (across a table cell: refused, with a notice); Reject all gives the page back`, async ({ page }) => {
      await openWith(page, shape.html, "End.");
      const before = { html: await fx<string>(page, "html"), text: await fx<string>(page, "text") };
      await fx(page, "selectAcross", shape.from, shape.to);
      // The selection really does cross the blocks (nothing normalised it away).
      expect(await fx<string>(page, "selectedText")).toBe(shape.selected ?? "bravo|charlie ");
      await action.run(page);
      await same(page);
      if (shape.struck === null) {
        // Refused: nothing changed at all — and the person is told why.
        expect(await fx<string>(page, "html")).toBe(before.html);
        await expect(page.getByRole("status").filter({ hasText: "can’t be tracked while suggesting" })).toBeVisible();
      } else {
        // Every removed character is still there, struck, where a collaborator reads it.
        expect(await fx<string>(page, "struckText")).toBe(shape.struck);
      }
      await rejectAll(page);
      expect(words(await fx<string>(page, "text"))).toBe(words(before.text));
      if (action.keepsShape) expect(await fx<string>(page, "html")).toBe(before.html);
      await expect(page.locator(".ProseMirror").first().locator('[data-suggestion]')).toHaveCount(0);
    });
  }
}

// ── Suggested STRUCTURE: paragraph breaks, slash-menu blocks, line breaks ────────────────────
// A mark cannot say "this paragraph break is new" (marks travel on text only), so a break carries
// two attributes on the node (`data-suggestion-node` / `data-suggestion-by`), which every
// collaborator and the stored page hold. Accept all / Reject all must both give the right page;
// structure with no tracked form is refused, with a notice — never applied as a plain edit.
const structureNotice = (page: Page) => page.getByRole("status").filter({ hasText: "can’t be added while suggesting" });
const html = (page: Page) => fx<string>(page, "html");
/** The caret at the very start of the block that holds `text`. */
const caretBefore = (page: Page, text: string) => fx(page, "caretBefore", text);
const slash = async (page: Page, query: string, name: string | RegExp) => {
  await page.keyboard.type(`/${query}`);
  await expect(page.getByRole("option", { name }).first()).toBeVisible();
  await page.keyboard.press("Enter");
};

test("Enter splits a paragraph as a suggested break (one Yjs update): Reject all joins it again, Accept all keeps it", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await fx(page, "caretAfter", "The rollout plan");
  const updates = await fx<number>(page, "updates");
  await page.keyboard.press("Enter");
  await same(page);
  expect(await fx<number>(page, "updates")).toBe(updates + 1); // the split and its record are one change
  // What a collaborator holds: the new block's start is the author's suggestion.
  expect(await html(page)).toContain('<p data-suggestion-node="insert" data-suggestion-by="You"> is ready for review.</p>');
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  // Again — typed into, then accepted: two plain paragraphs, nothing pending.
  await fx(page, "caretAfter", "The rollout plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Now");
  await acceptAll(page);
  expect(await html(page)).toContain("<p>The rollout plan</p><p>Now is ready for review.</p>");
  expect(await html(page)).not.toContain("data-suggestion");
});

test("new paragraphs typed after Enter are removed whole by Reject all — no empty line is left behind", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await fx(page, "caretAfter", "ready for review.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("A new line.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("And another.");
  await same(page);
  expect(await fx<number>(page, "count", "paragraph")).toBe(5);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("Enter in a list makes a suggested item: Reject all removes it, Accept all keeps it; Enter at the start of a heading keeps the heading", async ({ page }) => {
  const list = "<ul><li><p>alpha</p></li><li><p>bravo</p></li></ul><h2>Title here</h2><p>End.</p>";
  await openWith(page, list, "End.");
  const before = await html(page);
  await fx(page, "caretAfter", "alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("new item");
  await same(page);
  expect(await fx<number>(page, "count", "listItem")).toBe(3);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  // Enter at the START of the heading: Reject gives the heading back as a heading.
  await caretBefore(page, "Title");
  await page.keyboard.press("Enter");
  await same(page);
  expect(await fx<number>(page, "count", "heading")).toBe(1);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  await fx(page, "caretAfter", "al");
  await page.keyboard.press("Enter");
  await acceptAll(page);
  expect(await html(page)).toContain("<ul><li><p>al</p></li><li><p>pha</p></li><li><p>bravo</p></li></ul>");
  expect(await html(page)).not.toContain("data-suggestion");
});

test("slash menu on a new line: the heading is the author's own suggested block — Reject all removes it, Accept all keeps it", async ({ page }) => {
  await open(page);
  const before = await html(page);
  for (const review of [rejectAll, acceptAll]) {
    await fx(page, "caretAfter", "Closing line.");
    await page.keyboard.press("Enter");
    await slash(page, "h2", "Heading 2");
    await page.keyboard.type("Next steps");
    await same(page);
    // For every collaborator: a heading whose start AND whose words are the author's suggestion.
    expect(await html(page)).toContain('<h2 data-suggestion-node="insert" data-suggestion-by="You">');
    await expect(added(page, "Next steps")).toBeVisible();
    await review(page);
    if (review === rejectAll) expect(await html(page)).toBe(before);
  }
  // (The empty paragraph the editor keeps after a last block that is not a paragraph came with the heading.)
  expect(await html(page)).toBe(`${before}<h2>Next steps</h2><p></p>`);
});

test("slash menu on a new line: a table is a suggested block too — Reject all takes the whole table out, Accept all keeps it", async ({ page }) => {
  await open(page);
  const before = await html(page);
  for (const review of [rejectAll, acceptAll]) {
    await fx(page, "caretAfter", "Second paragraph stays here.");
    await page.keyboard.press("Enter");
    await slash(page, "table", "Table");
    await expect.poll(() => fx<number>(page, "count", "table")).toBe(1);
    await page.keyboard.type("cell words");
    await same(page);
    expect(await html(page)).toContain('data-suggestion-node="insert"');
    await review(page);
    if (review === rejectAll) expect(await html(page)).toBe(before);
  }
  expect(await fx<number>(page, "count", "table")).toBe(1);
  expect(await html(page)).toContain("cell words");
  expect(await html(page)).not.toContain("data-suggestion");
});

test("slash menu on a block that was already there: turning it into a heading is refused, with a notice — nothing changes", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await fx(page, "caretAfter", "Second paragraph stays here.");
  await page.keyboard.type(" "); // the menu opens after a space (or on an empty line)
  await slash(page, "h1", "Heading 1");
  await expect(structureNotice(page)).toBeVisible();
  await same(page);
  expect(await fx<number>(page, "count", "heading")).toBe(0);
  await expect(paragraphs(page).nth(1)).toHaveText("Second paragraph stays here. ");
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("slash menu: a divider has no tracked form — refused with a notice even on a new line; Reject all gives the page back", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await fx(page, "caretAfter", "Second paragraph stays here.");
  await page.keyboard.press("Enter");
  await slash(page, "divider", "Divider");
  await expect(structureNotice(page)).toBeVisible();
  await same(page);
  expect(await fx<number>(page, "count", "horizontalRule")).toBe(1); // the one the page already had
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("a Markdown shortcut on a block that was already there is refused — the typed characters stay as suggested text", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await caretBefore(page, "Second");
  await page.keyboard.type("# ");
  await expect(structureNotice(page)).toBeVisible();
  await same(page);
  expect(await fx<number>(page, "count", "heading")).toBe(0);
  await expect(paragraphs(page).nth(1)).toHaveText("# Second paragraph stays here.");
  await expect(added(page, "#")).toBeVisible();
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("Backspace at the start of a paragraph is a suggested join: Accept all joins, Reject all keeps both; the author's own break is simply taken out", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await caretBefore(page, "Second");
  await page.keyboard.press("Backspace");
  await same(page);
  expect(await html(page)).toContain('<p data-suggestion-node="delete" data-suggestion-by="You">Second paragraph stays here.</p>');
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  await caretBefore(page, "Second");
  await page.keyboard.press("Backspace");
  await acceptAll(page);
  await expect(paragraphs(page).first()).toHaveText("The rollout plan is ready for review.Second paragraph stays here.");
  expect(await html(page)).not.toContain("data-suggestion");
  // Their own pending break: Backspace right after Enter is no suggestion at all.
  await page.goto("/e2e-fixtures/parity4-suggest.html");
  await open(page);
  await fx(page, "caretAfter", "The rollout plan");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await same(page);
  expect(await html(page)).toBe(before);
});

const BREAK_PAGE = "<p>Line one<br>Line two</p><p>End.</p>";
test("a line break can be removed while Suggesting — as a suggested removal: Accept all removes it, Reject all keeps it", async ({ page }) => {
  await openWith(page, BREAK_PAGE, "End.");
  const before = await html(page);
  // Delete in front of it, Backspace behind it: the same record, for every collaborator.
  for (const press of [async () => { await fx(page, "caretAfter", "Line one"); await page.keyboard.press("Delete"); }, async () => { await caretBefore(page, "Line two"); await page.keyboard.press("Backspace"); }]) {
    await press();
    await same(page);
    expect(await html(page)).toContain('<br data-suggestion-node="delete" data-suggestion-by="You">');
    await expect(page.locator('.ProseMirror .prism-suggested-break[data-kind="delete"]')).toHaveCount(1);
    await expect(refusedNotice(page)).toHaveCount(0);
    await rejectAll(page);
    expect(await html(page)).toBe(before);
  }
  await fx(page, "caretAfter", "Line one");
  await page.keyboard.press("Delete");
  await acceptAll(page);
  expect(await html(page)).toBe("<p>Line oneLine two</p><p>End.</p>");
});

test("typing over a selection that holds a line break strikes the text and suggests the break's removal; a break put in is the author's suggestion", async ({ page }) => {
  await openWith(page, BREAK_PAGE, "End.");
  const before = await html(page);
  for (const review of [rejectAll, acceptAll]) {
    await fx(page, "selectAcross", "one", "Line t");
    await page.keyboard.type("X");
    await same(page);
    expect(await fx<string>(page, "struckText")).toBe("oneLine t");
    expect(await html(page)).toContain('<br data-suggestion-node="delete" data-suggestion-by="You">');
    await review(page);
    if (review === rejectAll) expect(await html(page)).toBe(before);
  }
  expect(await html(page)).toBe("<p>Line Xwo</p><p>End.</p>");
  // Shift+Enter: the new break is a suggestion — Reject all removes it; the author's Backspace takes their own out.
  const now = await html(page);
  await fx(page, "caretAfter", "Line X");
  await page.keyboard.press("Shift+Enter");
  await same(page);
  expect(await html(page)).toContain('<br data-suggestion-node="insert" data-suggestion-by="You">');
  await page.keyboard.press("Backspace");
  await same(page);
  expect(await html(page)).toBe(now);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("more");
  await rejectAll(page);
  expect(await html(page)).toBe(now);
});

test("the review queue lists a suggested paragraph break and resolves it on its own", async ({ page }) => {
  await open(page);
  const before = await html(page);
  await fx(page, "caretAfter", "The rollout plan");
  await page.keyboard.press("Enter");
  await same(page);
  const review = page.locator(".prism-suggestion-review");
  await review.locator("summary").click();
  await expect(review.locator("summary")).toHaveText("1 suggested change");
  await expect(review.locator(".prism-review-after")).toContainText("Paragraph break");
  await review.getByRole("button", { name: "Reject", exact: true }).click();
  await same(page);
  expect(await html(page)).toBe(before);
});

test("composing (IME) over a selection that crosses nesting depth: the composition is not interrupted, and the result is tracked", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await openWith(page, "<p>alpha bravo</p><ul><li><p>charlie delta</p></li><li><p>echo</p></li></ul><p>End.</p>", "End.");
  const before = await html(page);
  await fx(page, "selectAcross", "bravo", "charlie ");
  expect(await fx<string>(page, "selectedText")).toBe("bravo|charlie ");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ｋ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  // Still ONE composition: the half-typed character was replaced, not committed beside the next one.
  await expect(page.locator(".ProseMirror").first()).not.toContainText("ｋ");
  await expect(page.locator(".ProseMirror").first()).toContainText("か");
  await cdp.send("Input.insertText", { text: "火" });
  await expect(added(page, "火")).toBeVisible();
  await expect(page.locator(".ProseMirror").first()).not.toContainText("か");
  await same(page);
  // Every removed character is still there, struck, where a collaborator reads it — no block was touched.
  expect(await fx<string>(page, "struckText")).toBe("bravo|charlie ");
  expect(await fx<number>(page, "count", "listItem")).toBe(2);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("composing (IME) over a selection that crosses a table-cell boundary: the composition completes and its text is tracked — nothing is removed, with the notice", async ({ page, browserName }) => {
  chromiumOnly(browserName, IME_BY_CDP);
  await openWith(page, `<p>alpha bravo</p>${TABLE}<p>End.</p>`, "End.");
  const before = await html(page);
  await fx(page, "selectAcross", "bravo", "charlie ");
  const starts = await page.evaluateHandle(() => { const log: string[] = []; document.querySelector(".ProseMirror")!.addEventListener("compositionstart", () => log.push("start"), true); return log; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "ｋ", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "火" });
  // The character the person composed is in the page, as their suggestion (it used to be lost).
  await expect(added(page, "火")).toBeVisible();
  expect(await starts.jsonValue()).toEqual(["start"]); // ONE composition, never restarted
  await expect(page.getByRole("status").filter({ hasText: "can’t be tracked while suggesting" })).toBeVisible();
  await same(page);
  expect(await fx<string>(page, "struckText")).toBe(""); // across a cell boundary nothing is removed
  expect(await fx<string>(page, "text")).toContain("alpha 火bravo");
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

// Every text-bearing block of the slash menu, made on the author's own new line: the whole block
// is a suggestion (its text blocks carry the record), so Reject all gives the page back exactly.
const OWN_BLOCKS: Array<{ query: string; name: string | RegExp; type: string }> = [
  { query: "bulleted", name: "Bulleted list", type: "bulletList" },
  { query: "numbered", name: "Numbered list", type: "orderedList" },
  { query: "to-do", name: "To-do list", type: "taskList" },
  { query: "quote", name: "Quote", type: "blockquote" },
  { query: "callout", name: "Callout", type: "callout" },
  { query: "toggle", name: "Toggle", type: "toggle" },
  { query: "code", name: "Code", type: "codeBlock" },
  { query: "2 columns", name: "2 columns", type: "columns" },
];
for (const block of OWN_BLOCKS) {
  test(`slash menu on a new line — ${block.type}: made as a suggestion; Reject all removes it, Accept all leaves nothing pending`, async ({ page }) => {
    await open(page);
    const before = await html(page);
    for (const review of [rejectAll, acceptAll]) {
      await fx(page, "caretAfter", "The rollout plan is ready for review.");
      await page.keyboard.press("Enter");
      await slash(page, block.query, block.name);
      await expect.poll(() => fx<number>(page, "count", block.type)).toBe(1);
      await page.keyboard.type("words");
      await same(page);
      expect(await html(page)).toContain('data-suggestion-node="insert"');
      await review(page);
      if (review === rejectAll) expect(await html(page)).toBe(before);
    }
    expect(await fx<number>(page, "count", block.type)).toBe(1);
    expect(await html(page)).toContain("words");
    expect(await html(page)).not.toContain("data-suggestion");
  });
}

test("pasted paragraphs and a list left by pressing Enter twice are suggestions: Reject all gives the page back", async ({ page }) => {
  const list = "<ul><li><p>alpha</p></li><li><p>bravo</p></li></ul><p>End.</p>";
  await openWith(page, list, "End.");
  const before = await html(page);
  await fx(page, "caretAfter", "bravo");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // the empty item is the author's own: it may leave the list
  await page.keyboard.type("after the list");
  await same(page);
  expect(await fx<number>(page, "count", "listItem")).toBe(2);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
  await fx(page, "caretAfter", "alpha");
  await fx(page, "paste", "one\ntwo\nthree");
  await same(page);
  await expect(added(page, "three")).toBeVisible();
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

test("Tab on a list item that was already there is refused (it would be an untracked re-shape); on the author's own new item it works", async ({ page }) => {
  const list = "<ul><li><p>alpha</p></li><li><p>bravo</p></li></ul><p>End.</p>";
  await openWith(page, list, "End.");
  const before = await html(page);
  await fx(page, "caretAfter", "bravo");
  await page.keyboard.press("Tab");
  await expect(structureNotice(page)).toBeVisible();
  await same(page);
  expect(await html(page)).toBe(before);
  await page.keyboard.press("Enter");
  await page.keyboard.type("nested");
  await page.keyboard.press("Tab");
  await same(page);
  expect(await fx<number>(page, "count", "bulletList")).toBe(2);
  await rejectAll(page);
  expect(await html(page)).toBe(before);
});

// ── Accept of a selection typed over ACROSS blocks gives the page the plain edit would have ──
// The blocks are kept apart while the suggestion is pending (each half struck where it stands);
// the block start inside the selection is a suggested join, so Accept all joins them — exactly
// what typing over that selection does in Editing — and Reject all gives both blocks back.
const ACROSS: Array<{ name: string; html: string; from: string; to: string }> = [
  { name: "a pair of paragraphs", html: "<p>alpha bravo</p><p>charlie delta</p><p>End.</p>", from: "bravo", to: "charlie " },
  { name: "a pair of list items", html: "<ul><li><p>alpha bravo</p></li><li><p>charlie delta</p></li><li><p>echo</p></li></ul><p>End.</p>", from: "bravo", to: "charlie " },
  { name: "a paragraph and the list item below", html: "<p>alpha bravo</p><ul><li><p>charlie delta</p></li><li><p>echo</p></li></ul><p>End.</p>", from: "bravo", to: "charlie " },
  { name: "three paragraphs", html: "<p>alpha bravo</p><p>middle</p><p>charlie delta</p><p>End.</p>", from: "bravo", to: "charlie " },
];
const ACROSS_ACTIONS: Array<{ name: string; run: (page: Page) => Promise<void> }> = [
  { name: "typed over", run: async (page) => { await page.keyboard.type("X"); } },
  { name: "Backspace", run: async (page) => { await page.keyboard.press("Backspace"); } },
];
for (const shape of ACROSS) {
  for (const action of ACROSS_ACTIONS) {
    test(`across blocks — ${shape.name}, ${action.name}: Accept all gives exactly the plain edit's page; Reject all gives both blocks back`, async ({ page }) => {
      // What a plain (Editing) author gets.
      await page.goto(`/e2e-fixtures/parity4-suggest.html?content=${encodeURIComponent(shape.html)}`);
      await expect(page.locator(".ProseMirror").first()).toContainText("End.");
      await page.locator(".ProseMirror").first().click();
      await fx(page, "selectAcross", shape.from, shape.to);
      await action.run(page);
      await same(page);
      const plain = await html(page);
      expect(plain).not.toContain("bravo");
      for (const review of [rejectAll, acceptAll]) {
        await openWith(page, shape.html, "End.");
        const before = await html(page);
        await fx(page, "selectAcross", shape.from, shape.to);
        await action.run(page);
        await same(page);
        expect(await html(page)).toContain('data-suggestion-node="delete"'); // the join is a suggestion, for every collaborator
        await review(page);
        expect(await html(page)).toBe(review === rejectAll ? before : plain);
      }
    });
  }
}

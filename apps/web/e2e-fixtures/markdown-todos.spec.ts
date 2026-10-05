/**
 * A Markdown note's task items (`- [x]` / `- [ ]`) open as a to-do list (PARITY-GAPS §a.1, slice N)
 * — in the plain editor (the shell's Markdown path) and in the live editor (the REAL server seeds
 * the document from the stored Markdown: real-server.ts). They used to open as plain bullets with
 * the checked state gone, and a live document then stored them that way.
 */
import { test, expect, type Page } from "@playwright/test";
import { connect, startRealServer, type RealServer } from "./real-server";

const MD = [
  "# Launch checklist",
  "",
  "- [x] Book the venue",
  "- [ ] Send invitations",
  "  - [x] Draft the text",
  "  - [ ] Collect addresses",
  "- [X] Print **badges**",
  "",
  "Notes:",
  "",
  "- [x] already agreed",
  "- a plain remark",
  "",
].join("\n");

/** A to-do item as the editor draws it (the node view's `<li data-checked>` inside the to-do list). */
const ITEM = 'ul[data-type="taskList"] > li';
/** What a reader sees: every to-do in document order with its state, and the bullets of plain lists. */
const read = (page: Page, scope: string) =>
  page.locator(scope).first().evaluate((root, item) => ({
    todos: Array.from(root.querySelectorAll(item)).map((li) => {
      const own = li.querySelector(":scope > div > p")?.textContent ?? "";
      const box = li.querySelector<HTMLInputElement>(":scope > label > input[type=checkbox]");
      return `${box?.checked ? "x" : " "}|${li.getAttribute("data-checked")}|${own}|depth ${(function depth(el: Element | null, n = 0): number { const up = el?.parentElement?.closest(item) ?? null; return up ? depth(up, n + 1) : n; })(li)}`;
    }),
    bullets: Array.from(root.querySelectorAll("ul:not([data-type]) > li")).map((li) => li.textContent ?? ""),
  }), ITEM);

const EXPECTED = {
  todos: ["x|true|Book the venue|depth 0", " |false|Send invitations|depth 0", "x|true|Draft the text|depth 1", " |false|Collect addresses|depth 1", "x|true|Print badges|depth 0"],
  // A mixed list stays a bulleted list and keeps its marker as text.
  bullets: ["[x] already agreed", "a plain remark"],
};

test("plain editor: a Markdown note's task items open as a to-do list with their checked state", async ({ page }) => {
  await page.goto("/e2e-fixtures/notion-shell.html");
  await expect(page.locator(".tiptap[contenteditable=true]")).toBeVisible();
  await page.evaluate((md) => (window as any).prismShell.serverCreate("Library/Launch checklist", md), MD);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("Launch checklist");
  await page.getByRole("group", { name: "Notes" }).getByRole("option", { name: /Launch checklist/ }).click();
  const editor = "#workspace-document .tiptap";
  await expect(page.locator(editor).getByRole("heading", { name: "Launch checklist" })).toBeVisible();
  await expect.poll(() => read(page, editor)).toEqual(EXPECTED);
  // They are real to-dos: the box toggles.
  const second = page.locator(editor).first().getByRole("checkbox", { name: "Task item checkbox for Collect addresses" });
  await second.check();
  await expect.poll(async () => (await read(page, editor)).todos[3]).toBe("x|true|Collect addresses|depth 1");
});

test.describe("live editor (real server)", () => {
  let server: RealServer;
  test.beforeAll(async ({}, info) => {
    server = await startRealServer(String(info.project.use.baseURL ?? "http://127.0.0.1:5188"));
  });
  test.afterAll(async () => server?.stop());

  test("a Markdown note's task items open as a to-do list, and the document stores them as to-dos", async ({ page }) => {
    test.setTimeout(90_000);
    expect(await server.add({ id: "todos-md", path: "Notes/Launch checklist", content: MD, tags: ["note"], metadata: { type: "document" } })).toBe(true);
    await connect(page, page.context(), server, "owner");
    await page.goto("/e2e-fixtures/collab-route.html?target=todos-md");
    const editor = ".tiptap";
    await expect(page.locator(editor).first()).toBeVisible();
    await expect.poll(() => read(page, editor), { timeout: 20_000 }).toEqual(EXPECTED);
    // Check one more: the live document saves the list as a to-do list with every state — not as bullets.
    await page.locator(editor).first().getByRole("checkbox", { name: "Task item checkbox for Collect addresses" }).check();
    await expect.poll(async () => {
      const stored = (await server.note("todos-md"))?.content ?? "";
      return [(stored.match(/data-type="taskItem"/g) ?? []).length, (stored.match(/data-checked="true"/g) ?? []).length, (stored.match(/data-checked="false"/g) ?? []).length];
    }, { timeout: 45_000 }).toEqual([5, 4, 1]);
    expect((await server.note("todos-md"))!.content).toContain("[x] already agreed");
  });
});

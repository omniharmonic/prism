import { test, expect, type Page } from "@playwright/test";

/**
 * Parity pass 3 (slice G): clauses the shell fixture can host and no spec asserted.
 * Fixture flags used here: `?agent[=running]` (an AgentClient over one seeded session),
 * `?dbrows` (the tracker is a configured database over two task pages), `?events`.
 */
const shell = (query = "") => `/e2e-fixtures/notion-shell.html${query}`;
const ready = (page: Page) => expect(page.locator(".tiptap[contenteditable=true]").first()).toBeVisible();

/** NP-PG-02 · "Add a cover from … link": a VALID https link becomes the cover. */
test("NP-PG-02: a cover from a valid https link", async ({ page }) => {
  const link = "https://images.example.test/covers/harbour.png";
  await page.route(link, (r) => r.fulfill({ path: "e2e-fixtures/media/cover.png" }));
  await page.goto("/e2e-fixtures/notion-media.html");
  await page.locator(".document-page-header").hover();
  await page.getByRole("button", { name: "Add cover" }).click();
  const cover = page.locator(".document-cover");
  await expect(cover).toBeVisible();
  await cover.hover();
  await page.getByRole("button", { name: "Change cover" }).click();
  const picker = page.getByRole("dialog", { name: "Page cover" });
  await picker.getByRole("tab", { name: "Link" }).click();
  await picker.getByRole("textbox", { name: "Image link" }).fill(link);
  await picker.getByRole("button", { name: "Use link" }).click();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  // The link itself is what is stored on the page, and what the cover shows.
  await expect.poll(async () => (await page.evaluate(() => (window as any).prismMediaMeta as Array<Record<string, unknown>>)).at(-1)?.cover).toBe(link);
  await expect(cover.locator("img")).toHaveAttribute("src", link);
  await expect.poll(() => cover.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(cover.locator("img")).toHaveCSS("object-fit", "cover");
});

/** NP-PG-06 · "labelled Agent with an activity dot". */
test("NP-PG-06: the Agent button shows an activity dot while a turn runs, and drops it when the turn ends", async ({ page }) => {
  await page.goto(shell("?agent=running"));
  await ready(page);
  const agent = page.getByRole("button", { name: /^AI Agent/ });
  // Nothing is known about sessions yet: the header never asks by itself.
  await expect(agent).toHaveAccessibleName("AI Agent");
  await expect(agent.locator(".tabbar-activity-dot")).toHaveCount(0);
  const listsBefore = await page.evaluate(() => (window as any).prismShellAgent.lists as number);
  // The agent chat loads the session list; its latest turn is running.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("agent chat");
  await page.getByRole("group", { name: "Commands" }).getByRole("option", { name: "Agent Chat", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).prismShellAgent.lists as number)).toBeGreaterThan(listsBefore);
  await expect(agent).toHaveAccessibleName("AI Agent (working)");
  const dot = agent.locator(".tabbar-activity-dot");
  await expect(dot).toBeVisible();
  const box = (await dot.boundingBox())!;
  expect(box.width).toBeGreaterThan(3);
  await expect(agent).toHaveText("Agent");
  // Back on the page the dot is still there (it reads the cached list).
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("workspace", "A living workspace", "document"));
  await ready(page);
  await expect(page.getByRole("button", { name: "AI Agent (working)", exact: true })).toBeVisible();
  // The turn ends: the next list answer removes the dot.
  await page.evaluate(() => { (window as any).prismShellAgent.status = "done"; });
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("agent-chat", "Agent chat", "agent-chat"));
  await expect(page.getByRole("button", { name: "AI Agent", exact: true })).toBeVisible({ timeout: 12_000 });
  await expect(page.locator(".tabbar-activity-dot")).toHaveCount(0);
});

/** NP-PG-14 · "An empty page offers Empty, Template, Import and Ask agent. They disappear as soon as the user types." */
test("NP-PG-14: the Ask agent starter opens the agent on this page and vanishes on typing", async ({ page }) => {
  await page.goto(shell("?agent"));
  await ready(page);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("blank", "Untitled", "document"));
  const starters = page.getByRole("group", { name: "Start this page" });
  await expect(starters).toBeVisible();
  for (const name of ["Empty page", "Template", "Import", "Ask agent"]) await expect(starters.getByRole("button", { name, exact: true })).toBeVisible();
  await starters.getByRole("button", { name: "Ask agent", exact: true }).click();
  // The agent opens about THIS page; nothing was sent or created yet.
  await expect.poll(() => page.evaluate(() => (window as any).prismShellUI.getState().activeTabId)).toBe("tab-agent-chat");
  const subject = await page.evaluate(() => { const s = (window as any).prismShellAgentStore.getState(); return s.pendingAsk?.noteId ?? s.draft?.noteId; });
  expect(subject).toBe("blank");
  expect(await page.evaluate(() => (window as any).prismShellAgent.turns.length)).toBe(0);
  // Back on the still-empty page the starters are all there again.
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("blank", "Untitled", "document"));
  await expect(starters.getByRole("button", { name: "Ask agent", exact: true })).toBeVisible();
  // Typing in the page removes every starter, Ask agent included.
  const editor = page.locator("#workspace-document .tiptap[contenteditable=true]");
  await editor.click();
  await page.keyboard.type("Hello");
  await expect(starters).toHaveCount(0);
  await expect(page.locator("#workspace-document").getByRole("button", { name: "Ask agent", exact: true })).toHaveCount(0);
});

/** NP-PG-14: without an agent client the starter is not offered (members, share links, legacy desktop). */
test("NP-PG-14: no Ask agent starter where the shell has no agent", async ({ page }) => {
  await page.goto(shell());
  await ready(page);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("blank", "Untitled", "document"));
  const starters = page.getByRole("group", { name: "Start this page" });
  await expect(starters.getByRole("button", { name: "Import", exact: true })).toBeVisible();
  await expect(starters.getByRole("button", { name: "Ask agent", exact: true })).toHaveCount(0);
});

/** NP-SR-06 · Commands: "… Ask agent. Each has an icon and its shortcut hint." */
test("NP-SR-06: the palette's Ask agent command rows carry an icon and open the agent", async ({ page }) => {
  await page.goto(shell("?agent"));
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Search notes and commands" });
  await input.fill("ask");
  const commands = page.getByRole("group", { name: "Commands" });
  const ask = commands.getByRole("option", { name: "Ask About This Note", exact: true });
  await expect(ask).toBeVisible();
  await expect(ask.locator("svg").first()).toBeVisible();
  // Anything typed can be handed to the agent as a question: its own row, with an icon.
  const free = page.getByRole("option", { name: 'Ask your agent: "ask"', exact: true });
  await expect(free).toBeVisible();
  await expect(free.locator("svg").first()).toBeVisible();
  await ask.click();
  // The agent chat opens with this page as its subject.
  await expect.poll(() => page.evaluate(() => (window as any).prismShellUI.getState().activeTabId)).toBe("tab-agent-chat");
  const subject = await page.evaluate(() => { const s = (window as any).prismShellAgentStore.getState(); return s.pendingAsk?.noteId ?? s.draft?.noteId; });
  expect(subject).toBe("workspace");
  // The other agent commands are there too, each with an icon.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("agent");
  for (const name of ["Agent Chat", "Open Agent Panel"]) {
    const option = page.getByRole("group", { name: "Commands" }).getByRole("option", { name, exact: true });
    await expect(option).toBeVisible();
    await expect(option.locator("svg").first()).toBeVisible();
  }
});

/** NP-SR-06: the Ask rows exist only where the agent does. */
test("NP-SR-06: no Ask agent command without an agent client", async ({ page }) => {
  await page.goto(shell());
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Search notes and commands" }).fill("ask");
  await expect(page.getByRole("option", { name: "Ask About This Note", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /^Ask your agent/ })).toHaveCount(0);
});

/** NP-OF-05 · "The tree and databases update too" (within 2 s, no reload). */
test("NP-OF-05: an open database view follows a remote change within 2 s", async ({ page }) => {
  await page.goto(shell("?events&dbrows"));
  await ready(page);
  await page.evaluate(() => (window as any).prismShellUI.getState().openTab("tracker", "Workshop tracker", "database"));
  const view = page.locator("#workspace-document");
  const row = (title: string) => view.getByRole("row").filter({ hasText: title });
  await expect(row("Book the venue")).toBeVisible();
  await expect(row("Send invitations")).toBeVisible();
  await expect(row("Order the catering")).toHaveCount(0);
  const loaded = await page.evaluate(() => performance.timeOrigin);
  // Another device: one row's status changes, one row is renamed, a new row is created.
  const started = Date.now();
  await page.evaluate(() => {
    const shell = (window as any).prismShell;
    const stamp = (n: number) => `2026-10-02T09:00:0${n}.000Z`;
    const venue = shell.note("task-venue");
    venue.metadata = { ...venue.metadata, status: "done" };
    venue.updatedAt = stamp(1);
    const invites = shell.note("task-invites");
    invites.path = "Projects/Prism/Tasks/Send the invitations today";
    invites.updatedAt = stamp(2);
    shell.all().push({ id: "task-catering", path: "Projects/Prism/Tasks/Order the catering", content: "", tags: ["task"], metadata: { status: "todo" }, createdAt: stamp(3), updatedAt: stamp(3) });
    shell.event("task-venue");
    shell.event("task-invites", true);
    shell.event("task-catering", true);
  });
  await expect(row("Order the catering")).toBeVisible({ timeout: 2000 });
  await expect(row("Send the invitations today")).toBeVisible({ timeout: 2000 });
  await expect(row("Book the venue")).toContainText(/done/i, { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(2000);
  // No reload happened.
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(loaded);
});

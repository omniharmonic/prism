import { test, expect } from "@playwright/test";

test("custom and unset statuses remain explicit; menu movement guards the revision and preserves other metadata", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  const ungrouped = page.getByRole("region", {
    name: "Ungrouped",
    exact: true,
  });
  await expect(ungrouped.getByRole("article")).toHaveCount(2);
  await expect(page.getByLabel("Move Review with collaborators")).toHaveValue(
    "",
  );
  await page
    .getByLabel("Move Review with collaborators")
    .selectOption("in-progress");
  await expect(
    page
      .getByRole("region", { name: "In progress", exact: true })
      .getByRole("article"),
  ).toHaveCount(1);
  const writes = await page.evaluate(
    () => (window as any).prismBoardFixture.writes,
  );
  expect(writes).toEqual([
    {
      id: "custom",
      metadata: { status: "in-progress" },
      ifUpdatedAt: "2026-10-01T12:00:00Z",
    },
  ]);
  expect(
    await page.evaluate(
      () =>
        (window as any).prismBoardFixture
          .notes()
          .find((n: any) => n.id === "custom").metadata.other,
    ),
  ).toBe("preserve");
  await page.reload();
  await expect(page.getByLabel("Move Review with collaborators")).toHaveValue(
    "in-progress",
  );
  await page
    .getByRole("button", { name: "Polish the editor", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      (window as any).prismBoardFixture
        .open()
        .some((t: any) => t.noteId === "design"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).prismBoardFixture.taskIsDocument),
  ).toBe(true);
});

test("failed and conflicting moves stay in place and require deliberate recovery", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  const move = page.getByLabel("Move Polish the editor");
  await expect(move).toHaveValue("todo");
  await page.evaluate(() => {
    (window as any).prismBoardFixture.failNext = true;
  });
  await move.selectOption("done");
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  await expect(move).toHaveValue("todo");
  await page.evaluate(() => (window as any).prismBoardFixture.conflict());
  await move.selectOption("done");
  await expect(page.getByRole("alert")).toContainText(
    "changed in another window",
  );
  await expect(move).toHaveValue("todo");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(move).toBeVisible();
  await move.selectOption("done");
  await expect(move).toHaveValue("done");
  expect(
    await page.evaluate(
      () =>
        (window as any).prismBoardFixture
          .notes()
          .find((n: any) => n.id === "design").metadata.other,
    ),
  ).toBe("concurrent-change");
});

test("view settings persist custom columns, source and list preference without rewriting tasks", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  await page
    .getByRole("button", { name: "View settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "View settings" });
  await dialog
    .getByLabel("Columns (value: label, one per line)")
    .fill("todo: Planned\nreview: In review\ndone: Shipped");
  await dialog.getByLabel("Default view").selectOption("list");
  await dialog.getByRole("button", { name: "Save view" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "In review", exact: true })
      .getByRole("article"),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      (window as any).prismBoardFixture.writes.map((w: any) => w.id),
    ),
  ).toEqual(["board"]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "List", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Planned", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter tasks").fill("Review");
  await expect(page.getByRole("article")).toHaveCount(1);
});

test("read-only and future boards never expose mutation controls", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html?readonly");
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Drag / })).toHaveCount(0);
  await page.goto("/e2e-fixtures/boards.html?future");
  await expect(page.getByRole("alert")).toContainText(
    "unsupported configuration",
  );
  await expect(
    page.getByRole("button", { name: "View settings", exact: true }),
  ).toHaveCount(0);
});

test("phone controls fit and failed quick-add retains its private draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/boards.html");
  await expect(page.getByRole("article")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Task title").fill("Private launch checklist");
  await page.evaluate(() => {
    (window as any).prismBoardFixture.failNext = true;
  });
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByRole("alert")).toContainText("draft is still here");
  await expect(dialog.getByLabel("Task title")).toHaveValue(
    "Private launch checklist",
  );
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).prismBoardFixture.creates.at(-1).metadata
          .prism_visibility,
    ),
  ).toBe("private");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("boards-mobile.png") });
});

test("late board reads cannot populate another audience", async ({ page }) => {
  await page.goto("/e2e-fixtures/boards.html");
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.evaluate(() => {
    const c = (window as any).prismBoardFixture;
    c.hold = true;
    void c.refresh();
  });
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as any).prismBoardFixture;
    const release = c.readRelease;
    c.hold = false;
    c.switchScope();
    release?.();
  });
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByText("Polish the editor", { exact: true }),
  ).toHaveCount(0);
});

test("each task respects its capabilities and separate views group the same notes independently", async ({
  page,
  context,
}) => {
  await page.goto("/e2e-fixtures/boards.html?caps");
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "View settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(1);
  await expect(page.getByLabel("Move Review with collaborators")).toBeVisible();
  const second = await context.newPage();
  await second.goto("/e2e-fixtures/boards.html?alternate");
  await expect(
    second
      .getByRole("region", { name: "High priority", exact: true })
      .getByRole("article"),
  ).toHaveCount(3);
  await expect(
    page
      .getByRole("region", { name: "Ungrouped", exact: true })
      .getByRole("article"),
  ).toHaveCount(2);
});

test("the actual workspace opens a task in its live document adapter", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html?workspace");
  await page
    .getByRole("button", { name: "Polish the editor", exact: true })
    .click();
  await expect(page.getByTestId("live-task")).toHaveText(
    "Live task document: design",
  );
  await expect(
    page.getByRole("region", { name: "Task board", exact: true }),
  ).toHaveCount(0);
});

test("keyboard settings restore focus and a real drag confirms a move", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  const settings = page.getByRole("button", {
    name: "View settings",
    exact: true,
  });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  const handle = page.getByRole("button", {
    name: "Drag Polish the editor",
    exact: true,
  });
  const target = page.getByRole("region", { name: "In progress", exact: true });
  const start = await handle.boundingBox(),
    end = await target.boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    start!.x + start!.width / 2 + 12,
    start!.y + start!.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(end!.x + end!.width / 2, end!.y + 80, { steps: 10 });
  await page.mouse.up();
  await expect(target.getByRole("article")).toHaveCount(1);
});

test("queued changes are not called confirmed and cannot be duplicated", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.evaluate(() => {
    (window as any).prismBoardFixture.queueNext = true;
  });
  await page.getByLabel("Move Polish the editor").selectOption("done");
  await expect(page.getByRole("status").first()).toContainText(
    "waiting for sync",
  );
  await page.getByLabel("Move Polish the editor").selectOption("done");
  await expect(page.getByRole("alert")).toContainText(
    "earlier change is waiting",
  );
  expect(
    await page.evaluate(() => (window as any).prismBoardFixture.writes.length),
  ).toBe(1);
});

test("folder sources match a prefix without sending it as the vault's exact path filter", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/boards.html");
  await page
    .getByRole("button", { name: "View settings", exact: true })
    .click();
  await page.getByLabel("Source folder").fill("Projects/Prism/");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(3);
  await page
    .getByRole("button", { name: "View settings", exact: true })
    .click();
  await page.getByLabel("Source folder").fill("Projects/Other/");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
});

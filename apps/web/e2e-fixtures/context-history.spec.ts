import { test, expect } from "@playwright/test";

const rows = ".prism-context-history button.prism-context-history-row";
async function openFirst(page: import("@playwright/test").Page) {
  await page.locator(rows).first().click();
  await expect(page.getByRole("dialog", { name: "Version history" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full text", exact: true })).toBeVisible();
}

test("history keeps real attribution, paginates and traps/returns dialog focus", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html?paged");
  await expect(page.locator(rows)).toHaveCount(50);
  await expect(page.locator(rows).first()).toContainText("Alex Chen · via Prism");
  await page.getByRole("button", { name: "Load older versions (2 more)" }).click();
  await expect(page.locator(rows)).toHaveCount(52);
  expect(await page.evaluate(() => (window as any).contextHistory.offsets)).toEqual([0, 50]);
  await openFirst(page);
  await page.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Earlier research brief 1.");
  await page.getByRole("button", { name: "Older version" }).click();
  await expect(page.getByRole("dialog")).toContainText("Earlier research brief 2.");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(rows).first()).toBeFocused();
  expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
});

for (const mode of ["readonly", "propose"])
  test(`${mode} can compare and read, but cannot restore`, async ({ page }) => {
    await page.goto("/e2e-fixtures/context-history.html?" + mode);
    await openFirst(page);
    await expect(page.getByRole("button", { name: "Restore this version" })).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toContainText("Alex Chen");
    await page.getByRole("button", { name: "Full text", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Earlier research brief");
    expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
  });

test("restore flushes unsaved work and checks the fresh updatedAt before replacing it", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html?edit");
  await openFirst(page);
  await expect(page.getByRole("button", { name: "Restore this version" })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).contextHistory.schedule();
  });
  await page.getByRole("button", { name: "Restore this version" }).click();
  expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).contextHistory.writes)).toEqual([
    { kind: "flush", content: "Unsent fictional draft" },
    { kind: "restore", timestamp: "2026-10-02T11:00:00Z" },
  ]);
  expect(
    await page.evaluate(() => (window as any).contextHistory.ui.getState().noteRevisions["fictional-page"]),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as any).contextHistory.reads.filter((r: any) => r.fresh).length),
  ).toBeGreaterThan(2);
});

test("fresh permission revocation and conflicts prevent silent overwrite and preserve recovery", async ({
  page,
}) => {
  await page.goto("/e2e-fixtures/context-history.html");
  await openFirst(page);
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page.evaluate(() => {
    (window as any).contextHistory.denyEdit = true;
  });
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("dialog")).toContainText("could not be restored");
  await expect(page.getByRole("button", { name: "Confirm restore" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
  await page.goto("/e2e-fixtures/context-history.html");
  await openFirst(page);
  await page.evaluate(() => {
    (window as any).contextHistory.conflict = true;
  });
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("dialog")).toContainText("This note changed since you opened it");
  expect(
    await page.evaluate(
      () => (window as any).contextHistory.ui.getState().noteRevisions["fictional-page"] ?? 0,
    ),
  ).toBe(0);
});

test("failed list and version are explicit and retry; raw diagnostics are not exposed", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html");
  await expect(page.locator(rows)).toHaveCount(3);
  await page.evaluate(() => {
    const c = (window as any).contextHistory;
    c.failList = true;
    void c.query.invalidateQueries({ queryKey: ["vault", "notes", "fictional-page", "versions"] });
  });
  await expect(page.getByRole("alert")).toContainText("History could not be loaded");
  await expect(page.locator(rows)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("private diagnostics");
  await page.evaluate(() => {
    (window as any).contextHistory.failList = false;
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(rows)).toHaveCount(3);
  await page.evaluate(() => {
    (window as any).contextHistory.failVersion = true;
  });
  await openFirst(page);
  await expect(page.getByRole("alert")).toContainText("version could not be loaded");
  await page.evaluate(() => {
    (window as any).contextHistory.failVersion = false;
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Earlier research brief 1.");
});

test("audience change discards delayed restore result and old viewer state", async ({ page }) => {
  await page.goto("/e2e-fixtures/context-history.html");
  await openFirst(page);
  await page.evaluate(() => {
    (window as any).contextHistory.holdRestore = true;
  });
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).contextHistory.pending.length)).toBe(1);
  await page.getByRole("button", { name: "Switch workspace" }).dispatchEvent("click");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as any).contextHistory;
    c.holdRestore = false;
    c.pending.splice(0).forEach((r: () => void) => r());
  });
  await openFirst(page);
  await page.getByRole("button", { name: "Full text", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("New audience version body");
  await expect(page.getByRole("dialog")).not.toContainText("Earlier research brief");
  expect(
    await page.evaluate(
      () => (window as any).contextHistory.ui.getState().noteRevisions["fictional-page"] ?? 0,
    ),
  ).toBe(0);
});

for (const mode of ["empty", "unsupported"])
  test(`${mode} history remains truthful`, async ({ page }) => {
    await page.goto("/e2e-fixtures/context-history.html?" + mode);
    await expect(page.locator("main")).toContainText(
      mode === "empty" ? "No earlier versions yet." : "Full version history",
    );
    await expect(page.locator(rows)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).contextHistory.writes.length)).toBe(0);
  });

for (const appearance of ["desktop", "phone", "dark"])
  test(`history visual ${appearance}`, async ({ page }, info) => {
    await page.setViewportSize(
      appearance === "phone" ? { width: 390, height: 844 } : { width: 1200, height: 900 },
    );
    await page.goto("/e2e-fixtures/context-history.html?" + appearance);
    await expect(page.locator(rows)).toHaveCount(3);
    await page.locator("main").screenshot({ path: info.outputPath(`history-${appearance}.png`) });
    await openFirst(page);
    await page.getByRole("button", { name: "Full text", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Earlier research brief 1.");
    expect(await page.getByRole("dialog").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("dialog").screenshot({ path: info.outputPath(`version-${appearance}.png`) });
  });

test('audience change while the restore source is loading prevents the write', async ({page}) => {
 await page.goto('/e2e-fixtures/context-history.html'); await openFirst(page);
 await page.evaluate(()=>{(window as any).contextHistory.hold=true;});
 await page.getByRole('button',{name:'Restore this version'}).click(); await page.getByRole('button',{name:'Confirm restore'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).contextHistory.pending.length)).toBe(1);
 await page.getByRole('button',{name:'Switch workspace'}).dispatchEvent('click');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.evaluate(()=>{const c=(window as any).contextHistory;c.hold=false;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.locator(rows)).toHaveCount(3);
 expect(await page.evaluate(()=>(window as any).contextHistory.writes.length)).toBe(0);
});

test('version revalidation hides the cached body before a denied source response', async ({page}) => {
 await page.goto('/e2e-fixtures/context-history.html'); await openFirst(page);
 await page.getByRole('button',{name:'Full text',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('Earlier research brief 1.');
 await page.evaluate(()=>{const c=(window as any).contextHistory;c.hold=true;void c.query.invalidateQueries({queryKey:['vault','notes','fictional-page','versions']});});
 await expect(page.getByRole('dialog')).not.toContainText('Earlier research brief');
 await page.evaluate(()=>{const c=(window as any).contextHistory;c.deny=true;c.hold=false;c.pending.splice(0).forEach((r:()=>void)=>r());});
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('alert')).toContainText('History could not be loaded');
 await expect(page.locator('body')).not.toContainText('Earlier research brief');
 expect(await page.evaluate(()=>(window as any).contextHistory.writes.length)).toBe(0);
});

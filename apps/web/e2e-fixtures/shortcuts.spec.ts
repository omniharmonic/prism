import { test, expect, type Page } from "@playwright/test";
const prefix = "prism:note-shortcuts:v1:";
const path = "/e2e-fixtures/workspace.html?session";
async function open(page: Page, id: string) { await page.evaluate(id => (window as any).prismFixtureUI.getState().openTab(id, id, "document"), id); }
async function seed(page: Page, favorites = ["field-notes"], recents: string[] = []) {
  await page.addInitScript(({ prefix, favorites, recents }) => {
    const scope = JSON.stringify([location.origin + "/api", "default", "primary", "owner@example.test"]);
    localStorage.setItem(prefix + encodeURIComponent(scope), JSON.stringify({ version: 1, favorites, recents, legacyHandled: true }));
  }, { prefix, favorites, recents });
}
async function stored(page: Page) { return page.evaluate(prefix => Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ scope: JSON.parse(decodeURIComponent(key.slice(prefix.length))), ...JSON.parse(value) })), prefix); }

test("favorites and mobile recents persist only IDs and reopen with current authorized titles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await open(page, "field-notes");
  await expect.poll(async () => (await stored(page))[0]?.recents).toEqual(["field-notes"]);
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove from Favorites", exact: true })).toBeVisible();
  expect(await stored(page)).toEqual([{ scope: ["http://127.0.0.1:5188/api", "default", "primary", "owner@example.test"], version: 1, favorites: ["field-notes"], recents: ["field-notes"], legacyHandled: false }]);
  await page.reload();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await expect(page.getByRole("region", { name: "Recent", exact: true })).toContainText("Field notes");
});

test("each vault keeps its own favorites and recent history", async ({ page }) => {
  await page.goto(path);
  await open(page, "field-notes");
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent", exact: true })).toHaveCount(0);
  await open(page, "weekly-review");
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Weekly review");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("primary"));
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).not.toContainText("Weekly review");
  expect((await stored(page)).sort((a, b) => a.scope[2].localeCompare(b.scope[2])).map(record => record.favorites)).toEqual([["field-notes"], ["weekly-review"]]);
});

test("denied saved shortcuts stay hidden and their IDs remain available for retry", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&deny=field-notes");
  await expect(page.getByRole("button", { name: "Retry shortcuts" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
  expect((await stored(page))[0].favorites).toEqual(["field-notes"]);
  await page.getByRole("button", { name: "Retry shortcuts" }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
});

test("older global titles never appear or migrate without recovery, which rechecks access", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("prism-settings", JSON.stringify({ state: { favorites: [{ id: "field-notes", title: "OLD_PRIVATE_TITLE", type: "document" }, { id: "weekly-review", title: "DENIED_OLD_TITLE", type: "document" }], recents: [] }, version: 0 })));
  await page.goto(path + "&deny=weekly-review");
  await expect(page.getByRole("button", { name: "Recover older shortcuts" })).toBeVisible();
  await expect(page.getByText("OLD_PRIVATE_TITLE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("DENIED_OLD_TITLE", { exact: true })).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  await page.getByRole("button", { name: "Recover older shortcuts" }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  expect((await stored(page))[0].favorites).toEqual(["field-notes"]);
  await expect(page.getByText("OLD_PRIVATE_TITLE", { exact: true })).toHaveCount(0);
});

test("late shortcut access reads cannot populate a different vault", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&hold=field-notes");
  await page.evaluate(() => (window as any).prismFixtureSwitchVault("secondary"));
  await page.evaluate(() => (window as any).prismFixtureReleaseRead("field-notes"));
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
  await open(page, "weekly-review");
  await expect(page.getByRole("region", { name: "Recent", exact: true })).toContainText("Weekly review");
  await expect(page.getByRole("region", { name: "Recent", exact: true })).not.toContainText("Field notes");
});

test("a shortcut-storage failure preserves usable navigation and reports that preferences were not saved", async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("prism:note-shortcuts:")) throw new DOMException("Fixture quota", "QuotaExceededError"); return set.call(this, key, value); };
  });
  await page.goto(path);
  await open(page, "field-notes");
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(page.getByText("Shortcuts work here, but couldn’t be saved on this device.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  expect(await stored(page)).toEqual([]);
});


test("targeted access invalidation hides an existing title and retry restores it only after access returns", async ({ page }) => {
  await seed(page);
  await page.goto(path + "&events");
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await page.evaluate(() => {
    (window as any).prismFixtureControls.peopleDenyOpen = true;
    (window as any).prismFixtureInvalidate("field-notes");
  });
  await expect(page.getByRole("button", { name: "Retry shortcuts" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).prismFixtureControls.peopleDenyOpen = false);
  await page.getByRole("button", { name: "Retry shortcuts" }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
});


test("switching accounts on the same vault cannot inherit saved favorites", async ({ page }) => {
  await seed(page);
  await page.goto(path);
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await page.evaluate(() => (window as any).prismFixtureSwitchActor("second@example.test"));
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent", exact: true })).toHaveCount(0);
  await open(page, "weekly-review");
  await page.getByRole("button", { name: "Add to Favorites", exact: true }).click();
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Weekly review");
  await page.evaluate(() => (window as any).prismFixtureSwitchActor("owner@example.test"));
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).toContainText("Field notes");
  await expect(page.getByRole("region", { name: "Favorites", exact: true })).not.toContainText("Weekly review");
  const second = (await stored(page)).find(record => record.scope[3] === "second@example.test");
  expect(second.favorites).toEqual(["weekly-review"]);
});


test("account switching discards cached note bodies as well as shortcut labels", async ({ page }) => {
  await page.goto(path + "&account-isolation");
  await open(page, "field-notes");
  await expect(page.getByText("Useful observations from our last conversation.")).toBeVisible();
  await page.evaluate(() => (window as any).prismFixtureSwitchActor("second@example.test"));
  await expect(page.getByText("Useful observations from our last conversation.")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).prismLeakedBody = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes("Useful observations from our last conversation.")) (window as any).prismLeakedBody = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await open(page, "field-notes");
  await expect(page.getByRole("heading", { name: "Document unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Useful observations from our last conversation.")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismLeakedBody)).toBe(false);
});

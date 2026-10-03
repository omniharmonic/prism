import { test, expect } from "@playwright/test";

test("search shows ranked passages and openly labels keyword fallback without rendering source HTML", async ({ page }, testInfo) => {
  const external: string[] = [];
  await page.route("https://untrusted.example.test/**", route => { external.push(route.request().url()); return route.abort(); });
  await page.goto("/e2e-fixtures/search.html");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Ranked search");
  await expect(results).toContainText("A matching passage about connected ideas.");
  await page.evaluate(() => { (window as any).prismSearchFixture.semantic = "fail"; });
  await page.getByRole("textbox", { name: "Query", exact: true }).fill("context");
  await expect(results).toContainText("Keyword search · Ranked search is unavailable");
  await expect(results).toContainText("Shared context Documents & conversations.");
  await expect(results).not.toContainText("<h2>");
  await expect(results).not.toContainText("window.prismInjected");
  expect(external).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("search-results-mobile.png") });
});

// NP-SR-05
test("ranked and keyword results are blended: title matches first, ranked next, other keyword hits last", async ({ page }) => {
  await page.goto("/e2e-fixtures/search.html");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Ranked search");
  await page.evaluate(() => { (window as any).prismSearchFixture.keyword = "extra"; });
  await page.getByRole("textbox", { name: "Query", exact: true }).fill("idea");
  await expect(results).toContainText("Ranked search · with keyword matches");
  const text = await results.innerText();
  const at = (s: string) => text.indexOf(s);
  // Both title matches lead (keyword order), the body-only keyword hit follows; nothing appears twice.
  expect(at("Ideas ledger")).toBeGreaterThan(-1);
  expect(at("Ideas ledger")).toBeLessThan(at("Minutes"));
  expect(at("Connected ideas")).toBeLessThan(at("Minutes"));
  expect(text.split("Connected ideas").length - 1).toBeLessThanOrEqual(2); // title + breadcrumb of ONE row
  // Both searches ran for the query.
  const requests = await page.evaluate(() => (window as any).prismSearchFixture.requests as string[]);
  expect(requests).toContain("ranked:idea");
  expect(requests).toContain("keyword:idea");
  // The page both searches found keeps its ranked passage.
  await expect(results).toContainText("A matching passage about connected ideas.");
  // Keyword down: ranked alone, no error.
  await page.evaluate(() => { (window as any).prismSearchFixture.keyword = "fail"; });
  await page.getByRole("textbox", { name: "Query", exact: true }).fill("connected");
  await expect(results).toContainText("Connected ideas");
  await expect(results.getByRole("alert")).toHaveCount(0);
});

test("failed revalidation and audience changes never expose cached search results", async ({ page }) => {
  await page.goto("/e2e-fixtures/search.html");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Connected ideas");
  await page.evaluate(() => { const w = window as any; w.prismSearchFixture.semantic = "fail"; w.prismSearchFixture.keyword = "fail"; void w.prismSearchClient.invalidateQueries({ queryKey: ["vault", "search"] }); });
  await expect(results.getByRole("alert")).toBeVisible();
  await expect(results).not.toContainText("Connected ideas");
  await page.evaluate(() => { const w = window as any; w.prismSearchFixture.semantic = "wait"; w.prismSearchFixture.keyword = "ok"; });
  await results.getByRole("button", { name: "Try again" }).click();
  await expect(results).toContainText("Searching…");
  await page.evaluate(() => { const w = window as any; const release = w.prismSearchFixture.release; w.prismSearchFixture.semantic = "ok"; w.prismSearchStore.setState({ scope: "search-b" }); release(); });
  await expect(results).toContainText("No matching notes");
  await expect(results).not.toContainText("Connected ideas");
});

test("phone search contains focus, announces keyboard selection, opens the result and restores the trigger", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e-fixtures/search.html");
  const trigger = page.getByRole("button", { name: "Open search", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const input = dialog.getByRole("combobox", { name: "Search notes and commands" });
  await expect(input).toBeFocused();
  await input.fill("ideas");
  await expect(dialog.getByRole("option", { name: /Connected ideas/ })).toBeVisible();
  await expect(input).toHaveAttribute("aria-activedescendant", "prism-command-0");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close search" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("search-command-mobile.png") });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).prismSearchUI.getState().activeTabId)).toBe("tab-source-a");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});


test("Enter during loading or empty results cannot accidentally start an agent turn", async ({ page }) => {
  await page.goto("/e2e-fixtures/search.html");
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const input = dialog.getByRole("combobox");
  await page.evaluate(() => { (window as any).prismSearchFixture.semantic = "wait"; });
  await input.fill("missing test document");
  await expect(dialog.getByRole("option", { name: 'Ask your agent: "missing test document"' })).toBeVisible();
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismSearchStore.getState().pendingAsk)).toBeNull();
  await expect.poll(() => page.evaluate(() => !!(window as any).prismSearchFixture.release)).toBe(true);
  await page.evaluate(() => { (window as any).prismSearchFixture.release(); });
  await expect(dialog.getByRole("option", { name: /Connected ideas/ })).toBeVisible();
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismSearchUI.getState().activeTabId)).toBe("tab-source-a");
  await page.evaluate(() => { (window as any).prismSearchFixture.semantic = "ok"; });
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  await input.fill("nothing");
  await expect(dialog.getByText("No matching notes.", { exact: false })).toBeVisible();
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).prismSearchStore.getState().pendingAsk)).toBeNull();
  await input.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: 'Ask your agent: "nothing"' })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).prismSearchStore.getState().pendingAsk)).toEqual({ prompt: "nothing" });
});

test("an explicitly selected agent action stays selected as search results arrive", async ({ page }) => {
  await page.goto("/e2e-fixtures/search.html");
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  await page.evaluate(() => { (window as any).prismSearchFixture.semantic = "wait"; });
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  const input = dialog.getByRole("combobox");
  await input.fill("question");
  const ask = dialog.getByRole("option", { name: 'Ask your agent: "question"' });
  await expect(ask).toBeVisible();
  await input.press("ArrowDown");
  await expect(ask).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => !!(window as any).prismSearchFixture.release)).toBe(true);
  await page.evaluate(() => { (window as any).prismSearchFixture.release(); });
  await expect(dialog.getByRole("option", { name: /Connected ideas/ })).toBeVisible();
  await expect(ask).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  expect(await page.evaluate(() => (window as any).prismSearchStore.getState().pendingAsk)).toEqual({ prompt: "question" });
});


test("palette prioritizes readable notes, filters returned messages and keeps every result accessible", async ({ page }, testInfo) => {
  await page.goto("/e2e-fixtures/search.html?many");
  await page.getByRole("button", {name:"Open search",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Search workspace"});
  const input=dialog.getByRole("combobox");
  await input.fill("Prism");
  await expect(dialog).toContainText("11 results shown");
  await expect(dialog.getByRole("option").first()).toContainText("Connected ideas");
  await expect(dialog.getByRole("option",{name:/Prism discussion 10/})).toHaveCount(1);
  await dialog.getByRole("button",{name:"Messages",exact:true}).click();
  await expect(dialog).toContainText("10 results shown");
  await expect(dialog.getByRole("option",{name:/Connected ideas/})).toHaveCount(0);
  await expect(input).toBeFocused();
  await dialog.getByRole("button",{name:"Notes",exact:true}).click();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("button",{name:"All",exact:true}).click();
  await page.screenshot({path:testInfo.outputPath("search-command-desktop.png")});
  await dialog.getByRole("button",{name:"Messages",exact:true}).click();
  await input.press("Enter");
  expect(await page.evaluate(()=>(window as any).prismSearchUI.getState().activeTabId)).toBe("tab-message-0");
});

test("Open Agent Panel remains open when it was already visible", async ({page})=>{
  await page.goto("/e2e-fixtures/search.html");
  await page.evaluate(()=>(window as any).prismSearchUI.setState({contextPanelOpen:true}));
  await page.getByRole("button",{name:"Open search",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Search workspace"});
  await dialog.getByRole("button",{name:"Commands",exact:true}).click();
  await dialog.getByRole("combobox").fill("Open Agent Panel");
  await dialog.getByRole("option",{name:"Open Agent Panel",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).prismSearchUI.getState().contextPanelOpen)).toBe(true);
});

test("dark phone search filters fit and remain at least44px touch targets",async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/e2e-fixtures/search.html?many&dark");
  await page.getByRole("button",{name:"Open search",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Search workspace"});
  await dialog.getByRole("combobox").fill("Prism");
  await expect(dialog).toContainText("11 results shown");
  for(const name of ["All","Notes","Messages","Commands","Close search"]){const rect=await dialog.getByRole("button",{name,exact:true}).boundingBox();expect(rect!.height).toBeGreaterThanOrEqual(44);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:testInfo.outputPath("search-command-phone-dark.png")});
});

test("Escape from filter controls closes only the nested command dialog",async({page})=>{
 await page.goto("/e2e-fixtures/search.html?nested");
 await page.getByRole("button",{name:"Open search",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Search workspace",exact:true});
 await dialog.getByRole("button",{name:"Notes",exact:true}).focus();
 await page.keyboard.press("Escape");
 await expect(dialog).toHaveCount(0);
 await expect(page.getByRole("dialog",{name:"Parent navigation",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Open search",exact:true})).toBeFocused();
});

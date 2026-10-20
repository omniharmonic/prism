import { test, expect, type Page } from "@playwright/test";

// `?basemap=blank` (the e2e stacks' `/bioregion?basemap=blank`) starts every map of the page load
// on the network-free style: nothing may leave for tiles.openfreemap.org — or any host that is
// not this one — while the map renders or falls back. Without the parameter the default basemap
// is unchanged (OpenFreeMap). Every outside request is recorded AND aborted, so no test talks to
// the internet. Where the runner has no WebGL2 the map never asks for anything: the fallback.

/** Record (and abort) every request that leaves for a host other than the fixture server. */
function recordOutside(page: Page): string[] {
  const outside: string[] = [];
  void page.context().route(/.*/, (route) => {
    const url = route.request().url();
    let local = false;
    try {
      const u = new URL(url);
      local = u.protocol === "data:" || u.protocol === "blob:" || u.hostname === "127.0.0.1" || u.hostname === "localhost";
    } catch { /* unparseable: outside */ }
    if (local) return route.continue();
    outside.push(url);
    return route.abort();
  });
  return outside;
}

/** Ready (style loaded, nothing left to fetch) or fell back. */
async function settled(page: Page, testId: string): Promise<"ready" | "fallback"> {
  const map = page.getByTestId(testId);
  await expect.poll(async () => (await map.getAttribute("data-map-ready")) ?? (await map.getAttribute("data-map-fallback")), { timeout: 20_000 }).toBeTruthy();
  if ((await map.getAttribute("data-map-fallback")) === "true") return "fallback";
  await expect.poll(() => map.evaluate((el) => {
    const m = (el as HTMLElement & { __map?: { loaded(): boolean; areTilesLoaded(): boolean; isStyleLoaded(): boolean } }).__map;
    return !!m && m.isStyleLoaded() && m.areTilesLoaded() && m.loaded();
  }), { timeout: 20_000 }).toBe(true);
  return "ready";
}

test("?basemap=blank: the vault map loads no remote resource and shows the network-free style", async ({ page }) => {
  const outside = recordOutside(page);
  await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map&basemap=blank");
  const state = await settled(page, "vault-map");
  if (state === "ready") {
    await expect(page.getByTestId("basemap-switcher")).toHaveValue("blank");
    expect(await page.getByTestId("vault-map").getAttribute("data-feature-count")).not.toBe("0");
  }
  await expect(page.getByTestId("map-list").getByRole("button", { name: "Fictional Creek" })).toBeVisible();
  expect(outside).toEqual([]);
});

test("?basemap=blank: a note's own map (the bioregion entity page) loads no remote resource either", async ({ page }) => {
  const outside = recordOutside(page);
  await page.goto("/e2e-fixtures/renderer-preservation.html?kind=bioregion-entity&basemap=blank");
  await settled(page, "entity-map");
  expect(outside).toEqual([]);
});

test("without the parameter the default basemap is still OpenFreeMap", async ({ page }) => {
  const outside = recordOutside(page);
  await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map");
  const hasWebGL2 = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!hasWebGL2, "no WebGL2: the map never asks for a style here");
  // The style request is made (and aborted → the map falls back to blank, as in production offline).
  await expect.poll(() => outside.some((u) => new URL(u).hostname === "tiles.openfreemap.org"), { timeout: 20_000 }).toBe(true);
  expect(outside.every((u) => new URL(u).hostname === "tiles.openfreemap.org")).toBe(true);
});

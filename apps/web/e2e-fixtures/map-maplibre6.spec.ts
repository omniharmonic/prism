import { test, expect } from "@playwright/test";

// MapLibre 6 (ESM-only, WebGL2 only, worker loaded from a URL we hand it with
// setWorkerUrl). Where the runner has WebGL2 the real map must come up — its
// worker started from a same-origin URL, no error on the page — and where it has
// none the list fallback must show. The basemap host is blocked so the map falls
// back to the network-free blank style either way (no test talks to the internet).
test("the map mounts with MapLibre 6 (or falls back without WebGL2)", async ({ page }) => {
  const errors: string[] = [];
  const workers: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /worker|maplibre|webgl/i.test(m.text())) errors.push(m.text()); });
  page.on("worker", (w) => workers.push(w.url()));
  await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
  await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map");
  const hasWebGL2 = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  const map = page.getByTestId("vault-map");
  if (!hasWebGL2) {
    await expect(map).toHaveAttribute("data-map-fallback", "true");
    return;
  }
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 20_000 });
  await expect(map).not.toHaveAttribute("data-map-fallback", "true");
  await expect(map.locator("canvas.maplibregl-canvas")).toHaveCount(1);
  const origin = new URL(page.url()).origin;
  // Playwright delivers the `worker` event asynchronously: the map can report ready before the
  // test process has heard about its worker, so wait for the event instead of reading it once.
  const mapWorkerUrls = () => workers.filter((u) => /maplibre-gl-worker/.test(u));
  await expect.poll(() => mapWorkerUrls().length, { message: `workers: ${workers.join(", ")}` }).toBeGreaterThan(0);
  const mapWorkers = mapWorkerUrls();
  for (const u of mapWorkers) expect(new URL(u).origin, "the map worker is same-origin (worker-src 'self')").toBe(origin);
  expect(errors).toEqual([]);
});

// The WebGL2 probe: a runner with WebGL1 only (MapLibre 6 dropped it) gets the
// list fallback, never a broken canvas.
test("a WebGL1-only browser gets the fallback, not a broken map", async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: any, ...args: any[]) {
      if (String(type) === "webgl2") return null;
      return (get as any).call(this, type, ...args);
    } as any;
  });
  await page.goto("/e2e-fixtures/renderer-preservation.html?kind=map");
  await expect(page.getByTestId("vault-map")).toHaveAttribute("data-map-fallback", "true");
  await expect(page.getByTestId("map-list").getByRole("button", { name: "Fictional Creek" })).toBeVisible();
});

/**
 * Geospatial commons — full e2e through the real browser (@live).
 *
 * The geospatial UX is integrated INTO Prism, not a standalone panel: the Map is
 * a top-level surface (virtual tab) that shows every located note in the vault,
 * and clicking one opens it as an ordinary note tab where its per-note renderer
 * (with draw tools) takes over. This spec seeds a few bioregional notes with
 * GeoJSON geometry over the owner API, boots the app straight into the Map tab
 * (/bioregion is a deep-link alias for /map), and walks that integrated flow:
 * the MapLibre surface loads the features, the linked list indexes them, the kind
 * legend filters them, and opening a note reveals its cybernetic links.
 *
 * Map-click UX under test (WebGL runners only): a click SELECTS the smallest
 * feature under the cursor (nested polygons — a small watershed inside a big
 * one — resolve to the small one) and shows a popup; the note opens ONLY via
 * the popup's explicit "Open →" button or a list row — never as a side effect
 * of clicking the map.
 *
 * Shares the governance spec's magic-link login (server-log link). Run via
 * scripts/e2e-governance.sh (which also serves this spec's stack).
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE_URL, OWNER_TOKEN, OWNER_EMAIL } from "./helpers";

const SERVER_LOG = process.env.E2E_SERVER_LOG ?? "";
const E2E_TAG = "_e2e_bio";

async function ownerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json", ...(init?.headers as Record<string, string>) },
  });
}

async function seedNote(body: { content: string; tags: string[]; metadata: Record<string, unknown> }): Promise<void> {
  const r = await ownerFetch(`/api/notes`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`seed → ${r.status} ${await r.text()}`);
}

async function cleanup(): Promise<void> {
  const r = await ownerFetch(`/api/notes?tag=${E2E_TAG}`);
  if (!r.ok) return;
  const notes = (await r.json()) as Array<{ id: string }>;
  for (const n of notes) await ownerFetch(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
}

async function loginAsOwner(page: Page): Promise<void> {
  if (!SERVER_LOG) throw new Error("E2E_SERVER_LOG not set — run via scripts/e2e-governance.sh");
  const before = readFileSync(SERVER_LOG, "utf8").length;
  const res = await page.request.post(`${BASE_URL}/auth/request`, { data: { email: OWNER_EMAIL } });
  expect(res.ok()).toBeTruthy();
  let link = "";
  await expect
    .poll(() => {
      const fresh = readFileSync(SERVER_LOG, "utf8").slice(before);
      const m = fresh.match(/http[^\s"]*auth\/callback\?token=[^\s"]*/g);
      link = m?.[m.length - 1] ?? "";
      return link;
    }, { timeout: 10_000 })
    .not.toBe("");
  const url = new URL(link);
  await page.goto(`${BASE_URL}${url.pathname}${url.search}`);
}

test.describe("geospatial commons @live", () => {
  test.beforeAll(async () => {
    await cleanup();
    // A river (LineString, respond), a watershed (Polygon, sense), a species
    // (range MultiPolygon, sense), a policy threat (point, sense).
    await seedNote({
      content: "# Boulder Creek (e2e)",
      tags: [E2E_TAG, "ecological-entity"],
      metadata: { name: "Boulder Creek (e2e)", ecological_kind: "creek", sensing_or_responding: "respond", status: "threatened", geometry: { type: "LineString", coordinates: [[-105.3, 40.0], [-105.2, 40.05], [-105.1, 40.02]] } },
    });
    await seedNote({
      content: "# St. Vrain Watershed (e2e)",
      tags: [E2E_TAG, "watershed"],
      metadata: { name: "St. Vrain (e2e)", hucName: "St. Vrain (e2e)", huc12: "101900050101", sensing_or_responding: "sense", boundaryGeometry: { type: "Polygon", coordinates: [[[-105.5, 39.9], [-105.0, 39.9], [-105.0, 40.3], [-105.5, 40.3], [-105.5, 39.9]]] } },
    });
    await seedNote({
      content: "# Yarrow (e2e)",
      tags: [E2E_TAG, "species"],
      metadata: { name: "Achillea millefolium (e2e)", scientificName: "Achillea millefolium (e2e)", sensing_or_responding: "sense", rangeGeometry: { type: "MultiPolygon", coordinates: [[[[-106, 39], [-105, 39], [-105, 40], [-106, 39]]]] } },
    });
    // A small watershed NESTED inside St. Vrain — exercises smallest-wins click
    // resolution (the container polygon must not swallow the click).
    await seedNote({
      content: "# Left Hand Creek (e2e)",
      tags: [E2E_TAG, "watershed"],
      metadata: { name: "Left Hand (e2e)", hucName: "Left Hand (e2e)", huc12: "101900050102", sensing_or_responding: "sense", boundaryGeometry: { type: "Polygon", coordinates: [[[-105.35, 40.05], [-105.28, 40.05], [-105.28, 40.15], [-105.35, 40.15], [-105.35, 40.05]]] } },
    });
    await seedNote({
      content: "# Proposed rezoning threat (e2e)",
      tags: [E2E_TAG, "signal"],
      metadata: { name: "Rezoning threat (e2e)", title: "Rezoning threat (e2e)", signal_kind: "policy", severity: "high", sensing_or_responding: "sense", geo: { lat: 40.1, lon: -105.25 }, affects: ["[[Boulder Creek (e2e)]]"] },
    });
  });

  test.afterAll(async () => {
    await cleanup();
  });

  test("map surface indexes located notes, filters by kind, opens a note", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsOwner(page);
    // /bioregion is the deep-link alias that boots the app into the Map tab.
    // blank basemap → MapLibre initializes with no network (deterministic).
    await page.goto("/bioregion?basemap=blank");

    // The integrated Map surface, opened as a tab inside the real app.
    await expect(page.getByRole("heading", { name: "Map" })).toBeVisible({ timeout: 30_000 });

    // The linked list indexes all four located notes.
    const list = page.getByTestId("map-list");
    for (const name of ["Boulder Creek (e2e)", "St. Vrain (e2e)", "Left Hand (e2e)", "Achillea millefolium (e2e)", "Rezoning threat (e2e)"]) {
      await expect(list.getByText(name)).toBeVisible();
    }

    // The MapLibre map mounts and loads the four features (or degrades to a
    // graceful fallback if the headless runner has no WebGL — both are valid).
    const map = page.getByTestId("vault-map");
    await expect(map).toBeVisible();
    await expect
      .poll(async () => (await map.getAttribute("data-map-ready")) ?? (await map.getAttribute("data-map-fallback")), { timeout: 15_000 })
      .toBeTruthy();
    const mapReady = (await map.getAttribute("data-map-ready")) === "true";
    if (mapReady) {
      expect(Number(await map.getAttribute("data-feature-count"))).toBeGreaterThanOrEqual(5);
    }

    // Kind legend: toggling 'ecological-entity' off hides the creek from the list.
    await page.getByRole("button", { name: "ecological-entity" }).click();
    await expect(list.getByText("Boulder Creek (e2e)")).toHaveCount(0);
    await expect(list.getByText("St. Vrain (e2e)")).toBeVisible();
    // toggle it back on
    await page.getByRole("button", { name: "ecological-entity" }).click();
    await expect(list.getByText("Boulder Creek (e2e)")).toBeVisible();

    // Click a list row → the note opens as a tab in the per-note bioregion
    // renderer, where its cybernetic links close the sense→respond loop.
    await list.getByText("Rezoning threat (e2e)").click();
    const entity = page.getByTestId("bioregion-entity");
    await expect(entity).toBeVisible();
    await expect(entity.getByTestId("cybernetic-links")).toContainText("Affects");
    await expect(entity.getByTestId("cybernetic-links")).toContainText("Boulder Creek (e2e)");

    // ---- Map-click UX: click = select + popup, smallest feature wins; the
    // note opens ONLY via the popup's explicit "Open →". Needs a real WebGL
    // map — skipped when the runner degraded to the fallback panel.
    if (mapReady) {
      // Back to the Map tab (sidebar item and tab both answer to "Map"; matched
      // by text, since no element named exactly "Map" has role=button any more).
      await page.locator("[role=tab], button").filter({ hasText: /^\s*Map\s*$/ }).first().click();
      await expect(map).toBeVisible();
      await expect
        .poll(async () => map.getAttribute("data-map-ready"), { timeout: 15_000 })
        .toBe("true");
      await page.waitForTimeout(1200); // the one-time autoFit settles

      // The map fits its bounds with a 400 ms animation whenever the visible set
      // changes (the kind filter above): a point projected mid-animation lands
      // somewhere else by the time the click arrives. Wait for it to settle.
      const settled = () =>
        expect
          .poll(() => page.evaluate(() => {
            const el = document.querySelector('[data-testid="vault-map"]') as HTMLElement & { __map?: { isMoving(): boolean } };
            return !!el.__map && !el.__map.isMoving();
          }))
          .toBe(true);
      const clickLngLat = async (lon: number, lat: number) => {
        await settled();
        const pt = await page.evaluate(([lng, la]) => {
          const el = document.querySelector('[data-testid="vault-map"]') as HTMLElement & { __map?: { project(c: [number, number]): { x: number; y: number } } };
          const p = el.__map!.project([lng, la]);
          return { x: p.x, y: p.y };
        }, [lon, lat] as [number, number]);
        const bb = (await map.boundingBox())!;
        await page.mouse.click(bb.x + pt.x, bb.y + pt.y);
      };

      // This point is inside BOTH the nested Left Hand square and its container
      // St. Vrain: the SMALLEST polygon must win the click.
      await clickLngLat(-105.33, 40.09);
      const popup = page.getByTestId("map-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("Left Hand (e2e)");
      await expect(page.getByTestId("bioregion-entity")).toHaveCount(0); // select ≠ navigate

      // Clicking elsewhere re-selects and moves the popup — nothing to close
      // first. The click must hit the map, not the popup's own floating DOM —
      // and where the popup floats depends on its anchor (above or below the
      // first point, by how close it sits to the map's edge), so pick a St. Vrain
      // point (outside the nested square) that nothing covers right now.
      // MapLibre places the popup on its next render frame, so it can still move
      // after it is visible (it used to land on the chosen point AFTER the
      // check below): wait until its box is the same twice, then keep clear of it.
      await settled();
      const popupBox = async () => JSON.stringify(await page.locator(".maplibregl-popup").boundingBox());
      let lastBox = "";
      await expect.poll(async () => { const b = await popupBox(); const same = b === lastBox; lastBox = b; return same; }).toBe(true);
      const candidates: Array<[number, number]> = [[-105.1, 39.95], [-105.05, 40.25], [-105.45, 39.95], [-105.45, 40.25], [-105.2, 40.25], [-105.2, 39.93]];
      const free = await page.evaluate((pts) => {
        const el = document.querySelector('[data-testid="vault-map"]') as HTMLElement & { __map?: { project(c: [number, number]): { x: number; y: number } } };
        const r = el.getBoundingClientRect();
        const pop = document.querySelector(".maplibregl-popup")?.getBoundingClientRect();
        const margin = 16;
        return pts.find(([lng, la]) => {
          const p = el.__map!.project([lng, la]);
          const x = r.x + p.x, y = r.y + p.y;
          if (pop && x > pop.left - margin && x < pop.right + margin && y > pop.top - margin && y < pop.bottom + margin) return false;
          return !!document.elementFromPoint(x, y)?.classList.contains("maplibregl-canvas");
        }) ?? null;
      }, candidates);
      expect(free, "a St. Vrain point not covered by the popup").not.toBeNull();
      await clickLngLat(free![0], free![1]); // St. Vrain, outside the nested square
      await expect(popup).toContainText("St. Vrain (e2e)");

      // The explicit affordance is what opens the note.
      await page.getByTestId("map-popup-open").click();
      await expect(page.getByTestId("bioregion-entity")).toBeVisible();
    }
  });

  test("a stranger cannot reach the app", async ({ page }) => {
    await page.goto("/bioregion");
    await expect(page.getByRole("heading", { name: "Sign in to Prism" })).toBeVisible();
  });
});

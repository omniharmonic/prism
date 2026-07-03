/**
 * Bioregional commons browse + map — full e2e through the real browser (@live).
 *
 * Seeds a handful of bioregional notes with GeoJSON geometry over the owner API
 * (a river LineString, a watershed Polygon, a species with a range, a policy
 * threat point), signs in, and walks the /bioregion surface: the SVG map draws
 * the geometry, the entity list shows them, and the type + sensing/responding
 * lenses filter the set.
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

test.describe("bioregional commons @live", () => {
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
      metadata: { hucName: "St. Vrain (e2e)", huc12: "101900050101", sensing_or_responding: "sense", boundaryGeometry: { type: "Polygon", coordinates: [[[-105.5, 39.9], [-105.0, 39.9], [-105.0, 40.3], [-105.5, 40.3], [-105.5, 39.9]]] } },
    });
    await seedNote({
      content: "# Yarrow (e2e)",
      tags: [E2E_TAG, "species"],
      metadata: { scientificName: "Achillea millefolium (e2e)", sensing_or_responding: "sense", rangeGeometry: { type: "MultiPolygon", coordinates: [[[[-106, 39], [-105, 39], [-105, 40], [-106, 39]]]] } },
    });
    await seedNote({
      content: "# Proposed rezoning threat (e2e)",
      tags: [E2E_TAG, "signal"],
      metadata: { title: "Rezoning threat (e2e)", signal_kind: "policy", severity: "high", sensing_or_responding: "sense", geo: { lat: 40.1, lon: -105.25 } },
    });
  });

  test.afterAll(async () => {
    await cleanup();
  });

  test("browse + map + cleavage filters", async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsOwner(page);
    await page.goto("/bioregion");

    await expect(page.getByRole("heading", { name: "Bioregional Commons" })).toBeVisible();

    // All four seeded entities show in the list.
    const list = page.getByTestId("entity-list");
    for (const name of ["Boulder Creek (e2e)", "St. Vrain (e2e)", "Achillea millefolium (e2e)", "Rezoning threat (e2e)"]) {
      await expect(list.getByText(name)).toBeVisible();
    }

    // The map drew geometry for the four (line + polygon + range + point).
    const map = page.getByTestId("bioregion-map");
    await expect(map).toBeVisible();
    expect(await map.locator("[data-entity]").count()).toBeGreaterThanOrEqual(4);

    // Type lens: only ecological-entity → just the creek.
    await page.getByTestId("type-filters").getByRole("button", { name: "ecological-entity" }).click();
    await expect(list.getByText("Boulder Creek (e2e)")).toBeVisible();
    await expect(list.getByText("St. Vrain (e2e)")).toHaveCount(0);
    // clear it
    await page.getByTestId("type-filters").getByRole("button", { name: "ecological-entity" }).click();

    // Sensing lens: 'respond' → the creek is in, the sense-only watershed is out.
    await page.getByTestId("sensing-filters").getByRole("button", { name: "respond" }).click();
    await expect(list.getByText("Boulder Creek (e2e)")).toBeVisible();
    await expect(list.getByText("St. Vrain (e2e)")).toHaveCount(0);

    // Cross-surface nav: the Commons header moves between the two doors. These
    // are full-page navigations, so wait for the URL before asserting the panel.
    await page.getByTestId("commons-nav").getByRole("link", { name: "Governance" }).click();
    await page.waitForURL(/\/governance$/);
    await expect(page.getByRole("heading", { name: "Commons Governance" })).toBeVisible();
    await page.getByTestId("commons-nav").getByRole("link", { name: "Bioregion" }).click();
    await page.waitForURL(/\/bioregion$/);
    await expect(page.getByRole("heading", { name: "Bioregional Commons" })).toBeVisible();
  });

  test("a stranger cannot reach the bioregion surface", async ({ page }) => {
    await page.goto("/bioregion");
    await expect(page.getByText("Sign in to explore the bioregional commons.")).toBeVisible();
  });
});

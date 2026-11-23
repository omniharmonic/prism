/**
 * Importers → surface (@live). Runs the real import CLI to pull a GeoJSON
 * FeatureCollection into the vault as ecological-entity notes, then confirms
 * they show up on the vault's integrated Map surface (list + MapLibre). This
 * proves the plan's data path end to end: authoritative open data → typed commons
 * notes → the geospatial view inside Prism.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, OWNER_TOKEN, OWNER_EMAIL } from "./helpers";

const SERVER_LOG = process.env.E2E_SERVER_LOG ?? "";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const E2E_TAG = "_e2e_import";

async function ownerFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json", ...(init?.headers as Record<string, string>) },
  });
}

async function cleanup(): Promise<void> {
  const r = await ownerFetch(`/api/notes?tag=${E2E_TAG}`);
  if (!r.ok) return;
  for (const n of (await r.json()) as Array<{ id: string }>) {
    await ownerFetch(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
  }
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

test.describe("data importers @live", () => {
  test.beforeAll(async () => {
    await cleanup();
    // Run the real CLI against this stack's vault (env carries the coordinates).
    const out = execFileSync(
      "node",
      [
        resolve(ROOT, "scripts/import-bioregion.mjs"),
        "--source", "geojson-entities",
        "--file", resolve(ROOT, "apps/server/test/fixtures/creeks.geojson"),
        "--kind", "creek",
        "--sensing", "respond",
        "--extra-tag", E2E_TAG,
      ],
      {
        env: {
          ...process.env,
          PARACHUTE_URL: process.env.PARACHUTE_URL ?? "",
          PARACHUTE_VAULT: process.env.PARACHUTE_VAULT ?? "default",
          PARACHUTE_TOKEN: process.env.PARACHUTE_TOKEN ?? "",
        },
      },
    ).toString();
    expect(out).toMatch(/created 2\/2/);
  });

  test.afterAll(async () => {
    await cleanup();
  });

  test("imported GeoJSON entities appear on the map surface", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsOwner(page);
    await page.goto("/bioregion?basemap=blank");

    const list = page.getByTestId("map-list");
    await expect(list.getByText("Boulder Creek", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByText("Dry Creek", { exact: true })).toBeVisible();

    // the MapLibre map mounts and loads the imported features (or degrades to a
    // graceful WebGL fallback — both valid in a headless runner)
    const map = page.getByTestId("vault-map");
    await expect(map).toBeVisible();
    await expect
      .poll(async () => (await map.getAttribute("data-map-ready")) ?? (await map.getAttribute("data-map-fallback")), { timeout: 15_000 })
      .toBeTruthy();
  });
});

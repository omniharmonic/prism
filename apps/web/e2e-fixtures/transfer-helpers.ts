import { readFile } from "node:fs/promises";
import { expect, type Download, type Page } from "@playwright/test";
import { readZipDirectory, readZipEntry } from "../../../packages/core/src/lib/import-export/zip";

/** The files of a downloaded ZIP as text (name → content) plus raw sizes. */
export async function unzip(download: Download): Promise<{ files: Map<string, string>; sizes: Map<string, number> }> {
  const buf = new Uint8Array(await readFile((await download.path())!));
  const entries = readZipDirectory(buf, { maxEntries: 5000, maxEntryBytes: 50_000_000, maxTotalBytes: 200_000_000 });
  const files = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const e of entries) {
    const bytes = readZipEntry(buf, e);
    files.set(e.name, Buffer.from(bytes).toString("utf8"));
    sizes.set(e.name, bytes.length);
  }
  return { files, sizes };
}

export const transferUrl = (q = "") => `/e2e-fixtures/notion-transfer.html${q}`;
export const transferRequests = (page: Page) => page.evaluate(() => (window as any).prismTransfer.requests as Array<Record<string, any>>);
export const fixtureNotes = (page: Page) => page.evaluate(() => (window as any).prismFixtureNotes as Array<{ id: string; path: string; content: string; tags: string[]; metadata: Record<string, any> }>);
export const SHOTS = process.env.TRANSFER_SHOTS;
export const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

/** Open the command palette (once the shell is mounted) and run a command by name. */
export async function runCommand(page: Page, name: string) {
  await page.locator(".workspace-navigation").first().getByRole("region", { name: "Pages", exact: true }).waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByRole("combobox").fill(name);
  // The row can move while page results are still arriving; a press that straddles that move
  // (WebKit's down→up takes ~10 ms) produces no click. Press again until the command has run.
  await expect(async () => {
    if (await search.count()) await search.getByRole("option", { name }).first().click({ timeout: 2000 });
    await expect(search).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

/** The fixture's attachment bytes for <img> elements (which do not go through window.fetch). */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export async function serveAttachments(page: Page) {
  await page.route("**/api/attachments/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
}

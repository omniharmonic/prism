/**
 * Export archives in the Prism Client (docs/client-app.md "Saving an export archive").
 *
 * The webview of the native shell cancels `<a download>` (it has no download handler, on
 * purpose), so a finished export is saved by the SHELL: the dialog hands the job id and a
 * suggested name to `__PRISM_SHELL__.saveExport` → the `save_export` IPC command, which
 * downloads from the configured server and writes where the native save panel says.
 *
 * Here the shell's REAL host hook (apps/client/src-tauri/src/host.js) runs in the page over
 * a scripted IPC, so what is checked is the dialog ⇄ bridge contract: what crosses the
 * bridge (an id and a name — no URL, no path, no bytes), that the page itself downloads
 * nothing, and what the person is told when they save, cancel, stop or it fails.
 * The download, the panel and the file are Rust's (cargo test, export_archive.rs).
 * The web path (a browser download) is unchanged: notion-export.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { runCommand, serveAttachments, transferRequests, transferUrl } from "./transfer-helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = fs.readFileSync(path.resolve(here, "../../client/src-tauri/src/host.js"), "utf8");

type Call = { cmd: string; args: Record<string, unknown> };

/** The host hook over a scripted IPC: `window.ipcCalls` records every call; `window.ipcSave` decides what save_export answers. */
async function installShell(page: Page) {
  await page.addInitScript((source) => {
    if (window.top !== window) return;
    const w = window as any;
    w.ipcCalls = [];
    w.ipcSave = () => Promise.resolve("Chosen name.zip");
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        w.ipcCalls.push({ cmd, args });
        if (cmd === "save_export") return args.cancel ? Promise.resolve(null) : w.ipcSave(args);
        return Promise.resolve(null);
      },
    };
    // host.rs replaces both placeholders with JSON string literals, once each.
    new Function(source.replace("__PRISM_ORIGIN__", JSON.stringify(location.origin)).replace("__PRISM_PLATFORM__", JSON.stringify("macos")))();
  }, HOST_JS);
}
const saves = (page: Page) => page.evaluate(() => ((window as any).ipcCalls as Call[]).filter((c) => c.cmd === "save_export"));

async function startExport(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installShell(page);
  await serveAttachments(page);
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.goto(transferUrl());
  await runCommand(page, "Export workspace…");
  const dialog = page.getByRole("dialog", { name: "Export workspace" });
  await expect(dialog).toBeVisible();
  return { dialog, downloads };
}

test("native export: the shell saves the archive — the page passes a job id and a name, and downloads nothing", async ({ page }) => {
  const { dialog, downloads } = await startExport(page);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Export saved" })).toBeVisible();
  // The name shown is the one the person chose in the save panel.
  await expect(dialog).toContainText("12 pages and 1 file in Chosen name.zip");

  const calls = await saves(page);
  expect(calls).toHaveLength(1);
  // Exactly an id, a suggested name and the cancel flag: no URL, no path, no token, no bytes.
  expect(Object.keys(calls[0]!.args).sort()).toEqual(["cancel", "jobId", "suggestedName"]);
  expect(calls[0]!.args.suggestedName).toBe("Personal vault-export-2026-10-01.zip");
  expect(calls[0]!.args.cancel).toBe(false);
  const jobId = String(calls[0]!.args.jobId);
  expect(jobId.length).toBeGreaterThan(0);
  expect(JSON.stringify(calls[0]!.args)).not.toMatch(/https?:|\/api\/|blob:|Bearer|pd_/);

  // The page never fetched the archive and never started a browser download.
  const requests = await transferRequests(page);
  expect(requests.filter((r) => "download" in r)).toEqual([]);
  expect(downloads).toEqual([]);

  // Another copy = the same job through the same bridge.
  await dialog.getByRole("button", { name: "Save another copy…" }).click();
  await expect.poll(async () => (await saves(page)).length).toBe(2);
  expect((await saves(page))[1]!.args.jobId).toBe(jobId);
  await expect(dialog.getByRole("button", { name: "Download again" })).toHaveCount(0);
});

test("native export: progress while the shell saves; Stop cancels that job's save", async ({ page }) => {
  const { dialog } = await startExport(page);
  // The save stays open until the test settles it (the panel is up, then the stream runs).
  await page.evaluate(() => {
    const w = window as any;
    w.ipcSave = () => new Promise((resolve) => { w.settleSave = resolve; });
  });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const bar = dialog.getByRole("progressbar");
  await expect(bar).toHaveAccessibleName("Choose where to save the archive…");
  const jobId = String((await saves(page))[0]!.args.jobId);

  // What export_archive::progress_js evals: numbers and the job id.
  await page.evaluate((jobId) => window.dispatchEvent(new CustomEvent("prism:export-save-progress", { detail: { jobId, received: 1024 * 1024, total: 4 * 1024 * 1024 } })), jobId);
  await expect(bar).toHaveAccessibleName("Saving 1.0 MB of 4.0 MB…");
  await expect(bar).toHaveAttribute("aria-valuenow", String(1024 * 1024));
  // Progress for another job is not this dialog's.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("prism:export-save-progress", { detail: { jobId: "someone-else", received: 9, total: 10 } })));
  await expect(bar).toHaveAccessibleName("Saving 1.0 MB of 4.0 MB…");

  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await saves(page)).filter((c) => c.args.cancel === true).map((c) => c.args.jobId)).toEqual([jobId]);
  // The shell answers a cancelled save with null.
  await page.evaluate(() => (window as any).settleSave(null));
  await expect(dialog.getByRole("heading", { name: "Export ready" })).toBeVisible();
  await expect(dialog.locator("[data-export-unsaved]")).toHaveText("Not saved yet. Choose “Save…” to pick a place for it.");
});

test("native export: cancelling the save panel keeps the export; a failure says why; Save… tries again", async ({ page }) => {
  const { dialog } = await startExport(page);
  await page.evaluate(() => { (window as any).ipcSave = () => Promise.resolve(null); }); // the person closed the save panel
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Export ready" })).toBeVisible();
  await expect(dialog.locator("[data-export-unsaved]")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // The shell refuses (its own words reach the person; nothing is claimed to be saved).
  await page.evaluate(() => { (window as any).ipcSave = () => Promise.reject("This export has expired. Export again."); });
  await dialog.getByRole("button", { name: "Save…", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("This export has expired. Export again.");
  await expect(dialog.getByRole("heading", { name: "Export ready" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Export saved" })).toHaveCount(0);

  await page.evaluate(() => { (window as any).ipcSave = () => Promise.resolve("Workspace.zip"); });
  await dialog.getByRole("button", { name: "Save…", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Export saved" })).toBeVisible();
  await expect(dialog).toContainText("in Workspace.zip");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await saves(page)).toHaveLength(3);
});

test("native export: closing the dialog while the shell is saving cancels the save", async ({ page }) => {
  const { dialog } = await startExport(page);
  await page.evaluate(() => { (window as any).ipcSave = () => new Promise(() => {}); });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toHaveAccessibleName("Choose where to save the archive…");
  const jobId = String((await saves(page))[0]!.args.jobId);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await saves(page)).some((c) => c.args.cancel === true && c.args.jobId === jobId)).toBe(true);
});

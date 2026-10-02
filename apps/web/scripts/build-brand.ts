/** Deterministic vector/raster/native exports from the same React SVG geometry. */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { PrismMark, PrismAppIcon } from "../../../packages/core/src/components/brand/PrismMark.tsx";

const root = new URL("../../../", import.meta.url);
async function save(path: string, contents: string | Buffer) {
  const url = new URL(path, root);
  await mkdir(new URL("./", url), { recursive: true });
  await writeFile(url, contents);
}
const mark = renderToStaticMarkup(createElement(PrismMark, { width: 96, height: 64, color: "#25262a" }));
const mono = renderToStaticMarkup(createElement(PrismMark, { width: 96, height: 64, monochrome: true, color: "#25262a" }));
const icon = renderToStaticMarkup(createElement(PrismAppIcon, { compact: true }));
for (const app of ["web", "desktop"]) {
  await save(`apps/${app}/public/prism-mark.svg`, mark);
  await save(`apps/${app}/public/prism-monochrome.svg`, mono);
  await save(`apps/${app}/public/prism-icon.svg`, icon);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const pngs = new Map<number, Buffer>();
  for (const size of [16, 32, 64, 128, 180, 192, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    const svg = renderToStaticMarkup(createElement(PrismAppIcon, { size }));
    await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">${svg}</body></html>`);
    pngs.set(size, await page.screenshot({ omitBackground: true }));
  }
  for (const app of ["web", "desktop"]) {
    for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
      await save(`apps/${app}/public/${name}`, pngs.get(size)!);
    }
  }
  const chunks = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]] as const;
  const encoded = chunks.map(([type, size]) => {
    const bytes = pngs.get(size)!;
    const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([header, bytes]);
  });
  const icnsHeader = Buffer.alloc(8); icnsHeader.write("icns"); icnsHeader.writeUInt32BE(8 + encoded.reduce((n, b) => n + b.length, 0), 4);
  const icns = Buffer.concat([icnsHeader, ...encoded]);
  const icoHeader = Buffer.alloc(22); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
  icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12); icoHeader.writeUInt32LE(pngs.get(256)!.length, 14); icoHeader.writeUInt32LE(22, 18);
  const ico = Buffer.concat([icoHeader, pngs.get(256)!]);
  for (const app of ["client", "desktop"]) {
    for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 1024]] as const) {
      await save(`apps/${app}/src-tauri/icons/${name}`, pngs.get(size)!);
    }
    await save(`apps/${app}/src-tauri/icons/icon.icns`, icns);
    await save(`apps/${app}/src-tauri/icons/icon.ico`, ico);
  }
} finally { await browser.close(); }
console.log(`Prism brand assets exported from canonical SVG geometry in ${fileURLToPath(root)}`);

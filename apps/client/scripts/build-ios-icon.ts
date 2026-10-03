/**
 * iOS app icon master (WP5): the same PrismAppIcon geometry as the desktop/web icons
 * (apps/web/scripts/build-brand.ts), but FULL-BLEED: iOS applies its own corner mask
 * and App Store Connect rejects a marketing icon with transparency, so the square is
 * opaque and has no rounded corners or hairline stroke.
 *
 *   node --import tsx apps/client/scripts/build-ios-icon.ts <out.png>
 *   npx tauri icon <out.png> -o <tmpdir> --ios-color "#22242a"
 *   # tauri icon keeps an alpha channel; App Store Connect refuses one on the 1024 icon, so flatten:
 *   for f in <tmpdir>/ios/*.png; do sips -s format jpeg -s formatOptions 100 "$f" --out /tmp/i.jpg &&
 *     sips -s format png /tmp/i.jpg --out apps/client/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/$(basename "$f"); done
 *   (the PNGs are git-ignored repo-wide: `git add -f` them)
 *
 * (Only the ios/ outputs are copied: `tauri icon` would otherwise overwrite the
 * desktop icons, which build-brand.ts owns.)
 */
import { writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { PrismMark } from "../../../packages/core/src/components/brand/PrismMark.tsx";

const out = process.argv[2];
if (!out) throw new Error("usage: build-ios-icon.ts <out.png>");
const SIZE = 1024;
const mark = renderToStaticMarkup(
  createElement(PrismMark, { x: 13, y: 25, width: 70, height: 47, color: "#faf9f6", decorative: true }),
);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 96 96"><rect width="96" height="96" fill="#22242a"/>${mark}</svg>`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: SIZE, height: SIZE } });
  await page.setContent(`<html><body style="margin:0;background:#22242a">${svg}</body></html>`);
  await writeFile(out, await page.screenshot({ omitBackground: false }));
} finally {
  await browser.close();
}
console.log(`iOS icon master written to ${out}`);

#!/usr/bin/env node
/**
 * Guard: shipped UI writes the clipboard only through `copyText` (`@prism/core` lib/clipboard.ts).
 *
 * A browser accepts a clipboard write only inside the user's click / tap / key press. WebKit
 * (Safari, and the Prism Client's WKWebView on macOS and iOS) refuses
 * `navigator.clipboard.writeText()` once an `await` has passed — e.g. after the server created
 * the share link — and several call sites used to swallow that or say "Copied" anyway.
 * `copyText(text | Promise<text>)` starts the write synchronously, falls back to
 * `document.execCommand("copy")`, and resolves true only when something was really written.
 *
 * Reads the TypeScript syntax tree (no regex over source), so a comment or a string is not a
 * finding. Flags, called or merely referenced:
 *   navigator.clipboard.writeText / navigator.clipboard.write   (also `x.clipboard.write…`,
 *   `navigator.clipboard?.writeText`, `clipboard.writeText` on a variable named `clipboard`,
 *   and the `["writeText"]` spelling), and  <anything>.execCommand.
 * Reading (`clipboard.read`, `readText`) and paste / copy EVENT data (`event.clipboardData`) are
 * not writes and are not flagged.
 *
 * Allowed files (exactly these):
 *   packages/core/src/lib/clipboard.ts          the helper itself
 *   packages/core/src/lib/tiptap/mediaViews.ts  copies an IMAGE blob (`clipboard.write`)
 *   packages/core/src/lib/tiptap/moveBlock.ts   copies blocks as HTML + Markdown in one item
 *
 *   node scripts/check-clipboard.mjs            # packages/core/src + apps/web/src
 *   node scripts/check-clipboard.mjs <dir…>     # other roots (used by the guard's own test)
 */
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : [join(repo, "packages/core/src"), join(repo, "apps/web/src")];

const ALLOWED = new Set([
  "packages/core/src/lib/clipboard.ts",
  "packages/core/src/lib/tiptap/mediaViews.ts",
  "packages/core/src/lib/tiptap/moveBlock.ts",
]);
const WRITES = new Set(["writeText", "write"]);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) yield path;
  }
}

/** `a.b` / `a?.b` / `a["b"]` → "b", else null. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}
/** Parentheses and `!` / `as` wrappers do not hide what is underneath. */
function bare(node) {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return node;
}
/** Is this expression "the clipboard": `….clipboard` or a variable named `clipboard`? */
function isClipboard(node) {
  node = bare(node);
  return (ts.isIdentifier(node) && node.text === "clipboard") || memberName(node) === "clipboard";
}

const findings = [];
let files = 0;
for (const root of roots) {
  for (const path of sources(root)) {
    files++;
    const where = relative(repo, path).split(sep).join("/");
    if (ALLOWED.has(where)) continue;
    const text = readFileSync(path, "utf8");
    if (!/clipboard|execCommand/.test(text)) continue;
    const kind = /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const visit = (node) => {
      const name = memberName(node);
      let what = null;
      if (name === "execCommand") what = "execCommand";
      else if (name && WRITES.has(name) && isClipboard(node.expression)) what = `clipboard.${name}`;
      if (what) {
        const at = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push(`${where}:${at.line + 1}:${at.character + 1}  ${what}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (findings.length) {
  console.error(`Direct clipboard writes in shipped UI (${findings.length}). WebKit (Safari and the app's web view) refuses a write that is not made inside the user's click / tap / key press, and these call sites decide for themselves whether to say "Copied".`);
  console.error("Use copyText(text | Promise<text>) from @prism/core lib/clipboard.ts: call it synchronously in the handler (pass the pending promise, do not await first) and say \"Copied\" only when it resolves true.\n");
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`Clipboard writes go through copyText: ${files} source files checked (clipboard.writeText / clipboard.write / execCommand).`);

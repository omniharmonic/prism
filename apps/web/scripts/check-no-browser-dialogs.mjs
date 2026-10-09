#!/usr/bin/env node
/**
 * Guard: shipped UI never calls the browser's blocking dialogs.
 *
 * The Prism Client's web view (Tauri / wry, macOS and iOS) implements no JavaScript-dialog
 * delegate, so `window.prompt()` answers null, `window.confirm()` answers false and
 * `window.alert()` shows nothing: the action behind one silently does nothing in the apps
 * (found on the owner's iPhone, 2026-10-09: Embed, Web bookmark, Image from URL, and every
 * `confirm()`-guarded delete / revoke / sign-out).
 *
 * Use instead: `askConfirm` / `showMessage` / `<ConfirmDialog>` (`@prism/core` components/ui/
 * ConfirmDialog.tsx) and the editor's address field (`requestEditorPrompt`).
 *
 * Reads the TypeScript syntax tree (no regex over source), so a comment, a string such as
 * "javascript:alert(1)" or a method named `.confirm()` on some other object is not a finding.
 * Flags:  window.prompt(…) / globalThis.confirm(…) / self.alert(…) / window["alert"](…),
 *         EVERY bare prompt(…) / confirm(…) / alert(…) call — there is no exemption for a file
 *         that declares its own function of that name (a local `confirm` would hide a real one
 *         beside it): name a local helper something else,
 *         and taking the function without calling it (`const ask = window.confirm`).
 *
 *   node scripts/check-no-browser-dialogs.mjs            # packages/core/src + apps/web/src
 *   node scripts/check-no-browser-dialogs.mjs <dir…>     # other roots (used by the guard's own test)
 */
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : [join(repo, "packages/core/src"), join(repo, "apps/web/src")];

const NAMES = new Set(["prompt", "confirm", "alert"]);
const GLOBALS = new Set(["window", "globalThis", "self", "top", "parent"]);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) yield path;
  }
}

/** `window.alert`, `globalThis["confirm"]` → the dialog's name, else null. */
function globalDialog(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text) && NAMES.has(node.name.text)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text) && ts.isStringLiteralLike(node.argumentExpression) && NAMES.has(node.argumentExpression.text)) return node.argumentExpression.text;
  return null;
}

const findings = [];
let files = 0;
for (const root of roots) {
  for (const path of sources(root)) {
    files++;
    const text = readFileSync(path, "utf8");
    if (!/\b(prompt|confirm|alert)\b/.test(text)) continue;
    const kind = /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const report = (node, what) => {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push(`${relative(repo, path)}:${at.line + 1}:${at.character + 1}  ${what}`);
    };
    const visit = (node) => {
      const viaGlobal = globalDialog(node);
      if (viaGlobal) report(node, `${node.expression.text}.${viaGlobal}`);
      else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && NAMES.has(node.expression.text)) report(node, `${node.expression.text}(…)`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (findings.length) {
  console.error(`Browser dialogs in shipped UI (${findings.length}). The app's web view shows none of them — the action silently does nothing.`);
  console.error("Use askConfirm / showMessage / <ConfirmDialog> (components/ui/ConfirmDialog.tsx) or requestEditorPrompt (lib/tiptap/editorPrompt.ts).\n");
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`No browser dialogs: ${files} source files checked (window.prompt / confirm / alert).`);

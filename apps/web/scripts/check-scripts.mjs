import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// App tsconfig intentionally excludes executable verifiers. Parse each verifier
// too, so an otherwise-green typecheck cannot hide a merge syntax error.
const dir = new URL("./", import.meta.url);
let failures = 0;
for (const name of readdirSync(dir).filter((n) => /\.[cm]?tsx?$/.test(n))) {
  const path = fileURLToPath(new URL(name, dir));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  for (const diagnostic of source.parseDiagnostics) {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    console.error(`${name}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    failures++;
  }
}
if (failures) process.exitCode = 1;
else console.log("Verification scripts: syntax checks passed");

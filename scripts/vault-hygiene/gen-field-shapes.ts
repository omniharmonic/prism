/**
 * Generate (or check) the "Field shapes" prompt block from the contract.
 *
 *   node --import tsx scripts/vault-hygiene/gen-field-shapes.ts            # --check (default): exit 1 when stale
 *   node --import tsx scripts/vault-hygiene/gen-field-shapes.ts --write    # rewrite docs/vault-field-shapes.md
 *   node --import tsx scripts/vault-hygiene/gen-field-shapes.ts --print    # the block on stdout
 *
 * Source: packages/core/src/lib/schemas/vault-shapes.json (the contract).
 * Output: docs/vault-field-shapes.md — exactly the block, nothing else. Every
 * prompt that tells an agent how to write notes carries this block between its
 * markers (agent repo: `scripts/gen_field_shapes.py` injects it into the routines).
 * Local files only: no vault, no network.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderFieldShapesBlock, renderFieldShapesBody, type VaultShapesContract } from "../../packages/core/src/lib/schemas/vault-shapes";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTRACT_PATH = resolve(ROOT, "packages/core/src/lib/schemas/vault-shapes.json");
export const BLOCK_PATH = resolve(ROOT, "docs/vault-field-shapes.md");

/**
 * The hash in the block's marker: SHA-256 of the block's TEXT (not of the contract
 * file). So the block — and with it every routine prompt — changes only when a rule
 * an agent reads changes, never because an unrelated contract key (a lint tag) moved.
 */
export function bodySha256(contract: VaultShapesContract): string {
  return createHash("sha256").update(renderFieldShapesBody(contract), "utf8").digest("hex");
}

/** The committed file's exact expected content (block + one trailing newline). */
export function expectedBlockFile(path = CONTRACT_PATH): string {
  const contract = JSON.parse(readFileSync(path, "utf8")) as VaultShapesContract;
  return `${renderFieldShapesBlock(bodySha256(contract), contract)}\n`;
}

/**
 * Prompt files in THIS repo that tell an agent how to write notes. Each carries the
 * block between its markers; `--write` refreshes them, `--check` fails when one is stale.
 */
export const PROMPT_FILES = [".claude/skills/reconcile/SKILL.md", ".claude/skill-meeting-processor.md"] as const;

const BEGIN_RE = /<!-- field-shapes:begin[^\n]*-->[\s\S]*?<!-- field-shapes:end -->/;

/** `text` with its field-shapes block replaced by `block`; null when it has no markers. */
export function withBlock(text: string, block: string): string | null {
  return BEGIN_RE.test(text) ? text.replace(BEGIN_RE, () => block) : null;
}

/** Relative paths of prompt files whose block is missing or not the current one. */
export function stalePromptFiles(root = ROOT, files: readonly string[] = PROMPT_FILES): string[] {
  const block = expectedBlockFile().trimEnd();
  return files.filter((rel) => {
    let text = "";
    try {
      text = readFileSync(resolve(root, rel), "utf8");
    } catch {
      return true;
    }
    return !text.includes(block);
  });
}

function main(argv: string[]): number {
  const want = expectedBlockFile();
  if (argv.includes("--print")) {
    process.stdout.write(want);
    return 0;
  }
  if (argv.includes("--write")) {
    writeFileSync(BLOCK_PATH, want);
    console.log(`wrote ${BLOCK_PATH}`);
    for (const rel of PROMPT_FILES) {
      const path = resolve(ROOT, rel);
      const next = withBlock(readFileSync(path, "utf8"), want.trimEnd());
      if (next === null) {
        console.error(`${rel}: no field-shapes markers — add "<!-- field-shapes:begin -->" / "<!-- field-shapes:end -->" where the block belongs`);
        return 1;
      }
      writeFileSync(path, next);
      console.log(`updated ${rel}`);
    }
    return 0;
  }
  let have = "";
  try {
    have = readFileSync(BLOCK_PATH, "utf8");
  } catch {
    /* missing = stale */
  }
  const stale = stalePromptFiles();
  if (have === want && stale.length === 0) {
    console.log("field-shapes block: up to date");
    return 0;
  }
  console.error(
    `field-shapes block is STALE (${[...(have === want ? [] : ["docs/vault-field-shapes.md"]), ...stale].join(", ")}): run \`node --import tsx scripts/vault-hygiene/gen-field-shapes.ts --write\` and commit the result`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

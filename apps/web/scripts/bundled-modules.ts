/**
 * Records which source files end up in the native web build (dist-native), so the Prism Client's
 * THIRD-PARTY-LICENSES.md lists exactly the npm packages the app ships — not every dependency of
 * the workspace (apps/client/scripts/licenses/).
 *
 * Collected from rollup's output: every module that rendered code into a chunk (tree-shaken modules
 * are left out), every stylesheet module, and the source files of emitted assets (fonts, images
 * that a package's CSS references). Workers are separate rollup builds; the same recorder is added to
 * `worker.plugins`, so a worker's modules (maplibre-gl's) are counted too.
 *
 * Written to apps/web/dist-native.modules.json — beside the build, never inside it (the whole of
 * dist-native is embedded in the app). Paths are relative to the repository root, without a query.
 */
import { writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const BUNDLED_MODULES_FILE = resolve(repoRoot, "apps/web/dist-native.modules.json");

function clean(id: string): string | null {
  const bare = id.replace(/^\0/, "").split("?")[0];
  if (!isAbsolute(bare)) return null; // virtual modules
  return relative(repoRoot, bare).split("\\").join("/");
}

interface Chunkish {
  type: "chunk" | "asset";
  modules?: Record<string, { renderedLength: number }>;
  moduleIds?: string[];
  originalFileNames?: string[];
}

/** One recorder for the main build and its worker builds; the main build writes the file. */
export function bundledModules(): { main: Plugin; worker: () => Plugin } {
  const seen = new Set<string>();
  const collect = (bundle: Record<string, Chunkish>) => {
    for (const out of Object.values(bundle)) {
      if (out.type === "chunk") {
        for (const [id, m] of Object.entries(out.modules ?? {})) {
          if (m.renderedLength > 0 || /\.css$/.test(id.split("?")[0])) {
            const c = clean(id);
            if (c) seen.add(c);
          }
        }
        // Stylesheets render no JavaScript; they are listed by id.
        for (const id of out.moduleIds ?? []) if (/\.css$/.test(id.split("?")[0])) {
          const c = clean(id);
          if (c) seen.add(c);
        }
      } else {
        for (const f of out.originalFileNames ?? []) {
          const c = clean(isAbsolute(f) ? f : resolve(repoRoot, "apps/web", f));
          if (c) seen.add(c);
        }
      }
    }
  };
  const worker = (): Plugin => ({
    name: "prism-bundled-modules-worker",
    apply: "build",
    generateBundle(_o, bundle) {
      collect(bundle as unknown as Record<string, Chunkish>);
    },
  });
  const main: Plugin = {
    name: "prism-bundled-modules",
    apply: "build",
    generateBundle(_o, bundle) {
      collect(bundle as unknown as Record<string, Chunkish>);
    },
    writeBundle() {
      writeFileSync(BUNDLED_MODULES_FILE, JSON.stringify({ build: "dist-native", modules: [...seen].sort() }, null, 1) + "\n");
    },
  };
  return { main, worker };
}

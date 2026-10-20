/**
 * Find every Mach-O file in an unpacked host bundle and say how it is signed
 * (packaging/host/release/sign-bundle.sh reads this; docs/host-bundle.md § Release).
 *
 *   node --import tsx packaging/host/release/macho.ts <bundle-dir>          # TSV: kind<TAB>path
 *   node --import tsx packaging/host/release/macho.ts <bundle-dir> --json
 *
 * Files are recognised by their magic number, never by name: thin 64-bit (MH_MAGIC_64,
 * cf fa ed fe), thin 32-bit (ce fa ed fe) and universal (ca fe ba be with a plausible
 * architecture count — a Java class file starts with the same four bytes). Symlinks are skipped
 * (their target is signed where it lives). Kinds, in the order they are signed (inside out):
 *   library  — a .node add-on, .dylib or .so (signed with the hardened runtime, no entitlements)
 *   exec     — any other Mach-O executable (esbuild for tsx; hardened runtime, no entitlements)
 *   node     — runtime/node/bin/node (hardened runtime + release/entitlements/node.plist)
 */
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type MachoKind = "library" | "exec" | "node";
export interface MachoFile {
  path: string;
  kind: MachoKind;
}

/** Is this header the start of a Mach-O file? (pure) */
export function isMachO(head: Buffer): boolean {
  if (head.length < 8) return false;
  const le = head.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) return true; // thin, little-endian (arm64 / x86_64)
  const be = head.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = head.readUInt32BE(4);
    return n > 0 && n < 20; // a Java class file has its version here (≥ 45)
  }
  return false;
}

export function kindOf(rel: string): MachoKind {
  if (rel === "runtime/node/bin/node") return "node";
  return /\.(node|dylib|so)$/.test(rel) ? "library" : "exec";
}

const ORDER: Record<MachoKind, number> = { library: 0, exec: 1, node: 2 };

export function findMachO(root: string): MachoFile[] {
  const found: MachoFile[] = [];
  const head = Buffer.alloc(8);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size >= 8) {
        const fd = openSync(p, "r");
        try {
          readSync(fd, head, 0, 8, 0);
        } finally {
          closeSync(fd);
        }
        if (isMachO(head)) {
          const rel = relative(root, p);
          found.push({ path: rel, kind: kindOf(rel) });
        }
      }
    }
  };
  walk(root);
  return found.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: macho.ts <bundle-dir> [--json]");
    process.exit(2);
  }
  const files = findMachO(root);
  if (!files.some((f) => f.kind === "node")) {
    console.error(`${root}: no runtime/node/bin/node — not an unpacked host bundle`);
    process.exit(1);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(files, null, 2));
  else for (const f of files) console.log(`${f.kind}\t${f.path}`);
}

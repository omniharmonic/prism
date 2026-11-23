/**
 * Which installed packages the server can reach. `npm ci --omit=dev` for the server and
 * core workspaces also installs the monorepo ROOT dependencies (the web UI's React,
 * Excalidraw, Monaco … — they are hoisted root deps that @prism/core's browser code uses),
 * ~650 MB. The server only reaches a fraction of them. This keeps exactly what the
 * server's import graph names plus everything those packages need, resolved the way Node
 * does it, from the lockfile — so nothing is added that the lockfile did not install.
 */
export interface LockPackage {
  version?: string;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  license?: string;
}

export interface Lock {
  packages: Record<string, LockPackage>;
}

/** The lock path of the folder that contains `path`'s node_modules lookup chain. */
function parentOf(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/node_modules/");
  if (i !== -1) return path.slice(0, i);
  if (path.startsWith("node_modules/")) return "";
  // a workspace folder (apps/server, packages/core): its parent chain ends at the root
  return "";
}

/** Resolve `name` required from the package at lock path `from`, as Node's lookup would. */
export function resolveFrom(lock: Lock, from: string, name: string): string | null {
  let p: string | null = from;
  while (p !== null) {
    const candidate = `${p ? `${p}/` : ""}node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    p = parentOf(p);
  }
  return null;
}

/**
 * The closure of lock paths reachable from `roots` (bare package names imported by
 * first-party code, resolved from each `from` folder). Links (workspaces) are followed.
 */
export function reachable(lock: Lock, roots: Array<{ from: string; name: string }>, present: (lockPath: string) => boolean = () => true, pinned: string[] = []): Set<string> {
  // `pinned` = lock paths kept as they are without following them (the workspace links).
  const keep = new Set<string>(pinned.filter((p) => lock.packages[p]));
  const queue: string[] = [];
  const add = (path: string | null) => {
    if (!path || keep.has(path) || !present(path)) return;
    keep.add(path);
    queue.push(path);
  };
  for (const r of roots) add(resolveFrom(lock, r.from, r.name));
  while (queue.length) {
    const path = queue.shift()!;
    const pkg = lock.packages[path]!;
    if (pkg.link && pkg.resolved) {
      add(pkg.resolved);
      continue;
    }
    // An optional peer is only there if something else installs it; follow required peers only.
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((d) => !pkg.peerDependenciesMeta?.[d]?.optional);
    const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...peers]);
    for (const d of deps) add(resolveFrom(lock, path, d));
  }
  return keep;
}

/** Installed package folders (lock paths under some node_modules) that are not in `keep`. */
export function prunable(lock: Lock, keep: Set<string>): string[] {
  return Object.keys(lock.packages)
    .filter((p) => p.includes("node_modules/") && !keep.has(p))
    // a nested folder goes with its parent: list only the outermost ones
    .sort()
    .filter((p, _, all) => !all.some((q) => q !== p && p.startsWith(`${q}/`) && !keep.has(q)));
}

/** The package name a bare import specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

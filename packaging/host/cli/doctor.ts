/**
 * `prism doctor`: can this Mac host Prism? Every probe is injected, so tests decide what
 * the machine looks like; the real probes only read (a port is tested by binding it on
 * 127.0.0.1 for a moment — only the ports the install would use).
 */
import { createServer } from "node:net";
import { statfsSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { compareVersions, parseVersion } from "./semver";

export interface Check {
  id: string;
  ok: boolean;
  /** A failing fatal check stops `install`. */
  fatal: boolean;
  detail: string;
}

export interface MachineProbes {
  /** "arm64" when the hardware is Apple silicon (also under Rosetta). */
  hardwareArch(): string;
  platform(): string;
  macosVersion(): string | null;
  portFree(port: number): Promise<boolean>;
  freeBytes(path: string): number | null;
  isRoot(): boolean;
}

export const MIN_MACOS = "14.0.0";
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

export async function runDoctor(p: MachineProbes, opts: { ports: number[]; prefix: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const platform = p.platform();
  checks.push({ id: "platform", ok: platform === "darwin", fatal: true, detail: platform === "darwin" ? "macOS" : `${platform} — the v1 host bundle is macOS only` });
  const arch = p.hardwareArch();
  checks.push({ id: "apple-silicon", ok: arch === "arm64", fatal: true, detail: arch === "arm64" ? "Apple silicon" : `${arch} — the v1 host bundle needs an Apple-silicon Mac` });
  const mac = p.macosVersion();
  const macNorm = mac && parseVersion(mac.split(".").concat(["0", "0"]).slice(0, 3).join(".")) ? mac.split(".").concat(["0", "0"]).slice(0, 3).join(".") : null;
  const macOk = !!macNorm && compareVersions(macNorm, MIN_MACOS) >= 0;
  checks.push({ id: "macos", ok: macOk, fatal: true, detail: mac ? `macOS ${mac}${macOk ? "" : " — needs macOS 14 or newer"}` : "could not read the macOS version" });
  checks.push({ id: "not-root", ok: !p.isRoot(), fatal: true, detail: p.isRoot() ? "run as your own user, not root: Prism installs per-user launchd agents" : "running as a normal user" });
  for (const port of opts.ports) {
    const free = await p.portFree(port);
    checks.push({ id: `port-${port}`, ok: free, fatal: true, detail: free ? `port ${port} is free` : `port ${port} is in use (another Prism Server? choose one with --port)` });
  }
  const bytes = p.freeBytes(opts.prefix);
  const diskOk = bytes !== null && bytes >= MIN_FREE_BYTES;
  checks.push({ id: "disk", ok: diskOk, fatal: true, detail: bytes === null ? "could not read free disk space" : `${(bytes / 1024 ** 3).toFixed(1)} GB free${diskOk ? "" : " — needs at least 2 GB"}` });
  return checks;
}

function nearestExisting(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

export const realProbes: MachineProbes = {
  hardwareArch() {
    if (process.arch === "arm64") return "arm64";
    try {
      // Under Rosetta, process.arch is x64 but the hardware is still Apple silicon.
      return execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1" ? "arm64" : process.arch;
    } catch {
      return process.arch;
    }
  },
  platform: () => process.platform,
  macosVersion() {
    try {
      return execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  },
  portFree: (port) =>
    new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
    }),
  freeBytes(path) {
    try {
      const s = statfsSync(nearestExisting(path));
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  },
  isRoot: () => typeof process.getuid === "function" && process.getuid() === 0,
};

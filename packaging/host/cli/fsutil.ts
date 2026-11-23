/** Small filesystem helpers with the install's permission rules built in. */
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError, EXIT } from "./exit-codes";

/** Create `dir` (and parents) and make sure it is exactly `mode` — tightened when looser. */
export function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  const cur = statSync(dir).mode & 0o777;
  if (cur !== mode) chmodSync(dir, mode);
}

/** Write a file atomically (temp file in the same folder, fsync, rename) with `mode`. */
export function writeFileAtomic(path: string, data: string, mode: number): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** Point `link` at `target` atomically (a new symlink renamed over the old one). */
export function symlinkAtomic(target: string, link: string): void {
  const tmp = join(dirname(link), `.${randomBytes(6).toString("hex")}.link`);
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

export function readLinkOrNull(link: string): string | null {
  try {
    return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch {
    return null;
  }
}

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the install's lock (one changing command at a time). A lock left by a process that
 * is gone is taken over. Returns the release function.
 */
export function acquireLock(lockPath: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(readTextOrNull(lockPath) ?? "");
      if (holder && holder !== process.pid && pidAlive(holder)) {
        throw new CliError(EXIT.PRECONDITION, `another prism command is running (pid ${holder})`, { lock: lockPath });
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new CliError(EXIT.PRECONDITION, "could not take the install lock", { lock: lockPath });
}

/** What a run-wide lock file holds (no secret). */
export interface RunLockInfo {
  pid: number;
  startedAt: string;
  command: string;
}

export function readRunLock(path: string): RunLockInfo | null {
  const t = readTextOrNull(path);
  if (t === null) return null;
  try {
    const j = JSON.parse(t) as Partial<RunLockInfo>;
    if (typeof j.pid === "number" && Number.isInteger(j.pid) && j.pid > 0 && typeof j.startedAt === "string") return { pid: j.pid, startedAt: j.startedAt, command: typeof j.command === "string" ? j.command : "?" };
  } catch {
    /* corrupt */
  }
  return null;
}

export type RunLockState = { state: "free"; path: string } | { state: "held"; path: string; holder: RunLockInfo } | { state: "stale"; path: string; holder: RunLockInfo | null };

/** Where a run lock stands, without taking it (`--dry-run`). */
export function runLockState(path: string, alive: (pid: number) => boolean = pidAlive): RunLockState {
  if (!existsSync(path)) return { state: "free", path };
  const holder = readRunLock(path);
  if (holder && alive(holder.pid)) return { state: "held", path, holder };
  return { state: "stale", path, holder };
}

/**
 * A run-wide lock (`prism setup`): a JSON file `{pid, startedAt, command}` created atomically
 * (written to a temp file, then hard-linked into place, so a reader never sees half a lock).
 * Held by a live pid → refused (exit 4, the holder named). Left by a pid that is gone, or
 * unreadable → taken over (`tookOver` names the old holder). Released by the returned function,
 * and on process exit; a crash leaves it stale, which the next run takes over.
 * Residual: a pid reused by another process reads as alive — the message says how to clear it.
 */
export function acquireRunLock(path: string, o: { command: string; now: Date; pid?: number; alive?: (pid: number) => boolean }): { release: () => void; info: RunLockInfo; tookOver: RunLockInfo | null } {
  const alive = o.alive ?? pidAlive;
  const info: RunLockInfo = { pid: o.pid ?? process.pid, startedAt: o.now.toISOString(), command: o.command };
  const body = JSON.stringify(info) + "\n";
  let tookOver: RunLockInfo | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.lock`);
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = readTextOrNull(path);
      const holder = readRunLock(path);
      if (holder && alive(holder.pid)) {
        throw new CliError(EXIT.PRECONDITION, `another \`${holder.command}\` is running (pid ${holder.pid}, since ${holder.startedAt}); wait for it to finish. If no such run is going on, delete ${path}`, { lock: { path, held: true, ...holder } });
      }
      // Stale: remove it only if it is still the lock we judged (another run may have taken it over meanwhile).
      if (readTextOrNull(path) === seen) rmSync(path, { force: true });
      tookOver = holder;
      continue;
    } finally {
      rmSync(tmp, { force: true });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off("exit", release);
      try {
        if (readTextOrNull(path) === body) unlinkSync(path);
      } catch {
        /* already gone */
      }
    };
    process.on("exit", release);
    return { release, info, tookOver };
  }
  throw new CliError(EXIT.PRECONDITION, `could not take the run lock ${path}`, { lock: { path } });
}

export { existsSync };

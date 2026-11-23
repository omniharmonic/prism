/**
 * `launchctl` for the user's GUI domain (`gui/<uid>`), behind an injectable runner so
 * tests and `--dry-run` never load anything. Read-only queries (`print`) still run under
 * `--dry-run`; anything that changes launchd state is only printed.
 */
import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<ExecResult>;

export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const c = (err as { code?: unknown } | null)?.code; // a number = the exit status; a string = spawn error
      const code = err ? (typeof c === "number" ? c : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export interface AgentInfo {
  loaded: boolean;
  pid: number | null;
  state: string | null;
  lastExit: string | null;
}

/** How long `bootout` waits for a job to be gone (its plist's ExitTimeOut is 20 s). */
export const BOOTOUT_WAIT_MS = 30_000;
const BOOTOUT_POLL_MS = 250;

export interface LaunchdOptions {
  /** Tests: a sleep that does not wait. */
  sleep?(ms: number): Promise<void>;
  /** How long `bootout` waits for the job to unload (default BOOTOUT_WAIT_MS). */
  stopWaitMs?: number;
}

export class Launchd {
  readonly domain: string;
  /** Commands that changed (or, under dry-run, would have changed) launchd state. */
  readonly changes: string[] = [];

  constructor(
    private readonly run: Runner,
    uid: number,
    private readonly dryRun: boolean,
    private readonly opts: LaunchdOptions = {},
  ) {
    this.domain = `gui/${uid}`;
  }

  private async change(args: string[]): Promise<ExecResult> {
    this.changes.push(["launchctl", ...args].join(" "));
    if (this.dryRun) return { code: 0, stdout: "", stderr: "" };
    return this.run("launchctl", args);
  }

  async info(label: string): Promise<AgentInfo> {
    const r = await this.run("launchctl", ["print", `${this.domain}/${label}`]);
    if (r.code !== 0) return { loaded: false, pid: null, state: null, lastExit: null };
    return parsePrint(r.stdout);
  }

  /** Load the plist (a no-op when it is already loaded). */
  async bootstrap(label: string, plist: string): Promise<void> {
    if (!this.dryRun && (await this.info(label)).loaded) return;
    const r = await this.change(["bootstrap", this.domain, plist]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap ${label} failed: ${r.stderr.trim() || r.code}`);
  }

  /**
   * Unload (stops the job) and wait until launchd no longer lists it. A job that is not loaded is
   * fine. `launchctl bootout` returns while the job is still stopping (up to its ExitTimeOut):
   * a `prism start` straight after `prism stop` used to find the job still "loaded", skip the
   * bootstrap, and its kickstart then failed or the job finished unloading and nothing ran
   * (the demo server's reset.sh failed every time). So bootout returns only once it is gone.
   */
  async bootout(label: string): Promise<void> {
    if (!this.dryRun && !(await this.info(label)).loaded) return;
    const r = await this.change(["bootout", `${this.domain}/${label}`]);
    // 3 = "No such process", 113 = "Could not find service": already gone.
    if (r.code !== 0 && r.code !== 3 && r.code !== 113) throw new Error(`launchctl bootout ${label} failed: ${r.stderr.trim() || r.code}`);
    if (this.dryRun) return;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const wait = this.opts.stopWaitMs ?? BOOTOUT_WAIT_MS;
    for (let waited = 0; (await this.info(label)).loaded; waited += BOOTOUT_POLL_MS) {
      if (waited >= wait) throw new Error(`launchctl bootout ${label}: the job is still loaded after ${Math.round(wait / 1000)} s`);
      await sleep(BOOTOUT_POLL_MS);
    }
  }

  /** Restart a loaded job (`-k` kills the running instance first). */
  async kickstart(label: string, kill = true): Promise<void> {
    const r = await this.change(["kickstart", ...(kill ? ["-k"] : []), `${this.domain}/${label}`]);
    if (r.code !== 0) throw new Error(`launchctl kickstart ${label} failed: ${r.stderr.trim() || r.code}`);
  }
}

/** The few fields of `launchctl print` we read. Its format is not an API; missing fields are null. */
export function parsePrint(text: string): AgentInfo {
  const pid = /^\s*pid = (\d+)/m.exec(text);
  const state = /^\s*state = ([^\n]+)/m.exec(text);
  const last = /^\s*last exit code = ([^\n]+)/m.exec(text);
  return { loaded: true, pid: pid ? Number(pid[1]) : null, state: state ? state[1]!.trim() : null, lastExit: last ? last[1]!.trim() : null };
}

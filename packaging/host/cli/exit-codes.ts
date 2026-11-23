/**
 * Exit codes of the `prism` CLI (docs/host-bundle.md § Exit codes). An agent reads these,
 * so a number never changes meaning; add new ones at the end.
 */
export const EXIT = {
  /** Done (or nothing to do). */
  OK: 0,
  /** Unexpected failure; the message says what. */
  ERROR: 1,
  /** Bad command line. */
  USAGE: 2,
  /** No host install at this prefix. */
  NOT_INSTALLED: 3,
  /** A precondition failed: unsupported machine, port taken, wrong command for this state, locked. */
  PRECONDITION: 4,
  /** A checksum, signature or integrity check failed. Nothing was changed. */
  VERIFY_FAILED: 5,
  /** Refused by the version gate (a downgrade over newer data). `--force` overrides. */
  VERSION_REFUSED: 6,
  /** The new version did not become healthy; the previous one was restored and is healthy. */
  ROLLED_BACK: 7,
  /** The new version failed AND the rollback did not become healthy. Needs a person. */
  ROLLBACK_FAILED: 8,
  /** A destructive step needs confirmation (`--yes`). Nothing was changed. */
  NEEDS_CONFIRMATION: 9,
  /** Installed, but the server is not running. */
  NOT_RUNNING: 10,
  /** Running, but not healthy (vault unreachable or the wrong version answers). */
  DEGRADED: 11,
  /** `prism setup`: stopped at a step only the person can do (its `next` says what). Re-run with `--from <step>`. */
  NEEDS_PERSON: 12,
  /** `prism run`: a dependency (Parachute) is not ready yet — launchd retries. */
  TEMPFAIL: 75,
  /** `prism run`: the configuration cannot start a server (e.g. no vault token). */
  CONFIG: 78,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error that carries the exit code the CLI should end with. */
export class CliError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

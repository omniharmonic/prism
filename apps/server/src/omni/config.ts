/**
 * Omni module configuration (owner-only gateway between the Omni app and Hermes;
 * docs/omni-module.md). Read from the environment AT CALL TIME (not at import) so
 * tests and a restart-free flag flip both see the current value. Everything is
 * off by default: with OMNI_ENABLED unset every /api/omni/* route answers 404.
 */
import { config } from "../config";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === "" ? undefined : v;
};
const int = (k: string, d: number): number => {
  const n = Number(env(k));
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const omniConfig = {
  /** Master switch. Off → every /api/omni route (hooks included) is a 404. */
  enabled: (): boolean => env("OMNI_ENABLED") === "true",
  /** Hermes API server base URL (the Hermes gateway's `api_server` platform). */
  hermesUrl: (): string => (env("OMNI_HERMES_URL") ?? "http://127.0.0.1:8642").replace(/\/+$/, ""),
  /** NAME of the env var that holds Hermes' API_SERVER_KEY (the key itself never sits in a
   *  file this module reads, and is never logged). Default `OMNI_HERMES_KEY`. */
  hermesKey: (): string | undefined => env(env("OMNI_HERMES_KEY_ENV") ?? "OMNI_HERMES_KEY"),
  /** Shared secret Hermes' `omni-bridge` plugin (and the proactivity sweeps) present on the
   *  loopback-only hook routes. Unset = the hooks are refused. */
  serviceToken: (): string | undefined => env("OMNI_SERVICE_TOKEN"),
  requestTimeoutMs: (): number => int("OMNI_HERMES_TIMEOUT_MS", 15_000),
  /** A streamed turn is abandoned when Hermes sends nothing (not even a keepalive) this long. */
  streamIdleMs: (): number => int("OMNI_HERMES_STREAM_IDLE_MS", 300_000),
  /** How long a cancel keeps asking Hermes to stop the run (it cannot be stopped until its
   *  agent exists, a few seconds after the run starts). */
  stopRetryMs: (): number => int("OMNI_HERMES_STOP_RETRY_MS", 30_000),
  /** Hard ceiling for one turn's stream. */
  turnMaxMs: (): number => int("OMNI_TURN_MAX_MS", 60 * 60_000),
  /** Default lifetime of a proposed approval. */
  approvalTtlMs: (): number => int("OMNI_APPROVAL_TTL_MS", 24 * 60 * 60_000),
  /** Persisted stream events kept per thread (oldest pruned). */
  eventsPerThread: (): number => int("OMNI_EVENTS_PER_THREAD", 2_000),
  /** Concurrent /api/omni/events + thread-stream connections. */
  maxStreams: (): number => int("OMNI_MAX_STREAMS", 16),
  /**
   * Which sender runs an approved email (Benjamin, 2026-10-08: option B).
   * `proton-send` (default) = the agent repo's `scripts/proton_send.py --approved`, which
   * refuses markdown and holds the third-party-recipient guard; `live-actions` = Prism's
   * own Proton SMTP action (behind ACTIONS_EMAIL_ENABLED).
   */
  emailExecutor: (): "proton-send" | "live-actions" => (env("OMNI_EMAIL_EXECUTOR") === "live-actions" ? "live-actions" : "proton-send"),
  /**
   * `OMNI_EXECUTORS=off`: no approved draft is executed, whatever the per-family flags say
   * (`ACTIONS_*_ENABLED`, `OMNI_PROTON_SEND`) — those also serve Prism's own live actions, so
   * this is the switch that turns OMNI's sending off by itself. Approving then answers
   * `executor_disabled` and the draft stays pending.
   */
  /** Unset preserves family flags; set values must be entirely recognized, or all sends fail closed. */
  executorKindAllowed: (kind: string): boolean => {
    const raw = process.env.OMNI_EXECUTOR_KINDS;
    if (raw === undefined) return true;
    const kinds = raw.split(",").map(k => k.trim());
    const known = new Set(["email", "email-reply", "message", "calendar-rsvp", "calendar-invite", "tweet", "wallet-proposal"]);
    return kinds.length > 0 && kinds.every(k => known.has(k)) && kinds.includes(kind);
  },
  executorsOff: (): boolean => (env("OMNI_EXECUTORS") ?? "").toLowerCase() === "off",
  /** `OMNI_COMMAND_APPROVALS=off`: a tool call Hermes paused for approval can never be
   *  approved (so it never runs). On by default. */
  commandApprovalsOff: (): boolean => (env("OMNI_COMMAND_APPROVALS") ?? "").toLowerCase() === "off",
  /** Absolute path to proton_send.py. Unset = approved emails are refused (executor_disabled). */
  protonSendPath: (): string | undefined => env("OMNI_PROTON_SEND"),
  /** Python used to run it (the agent repo's venv on the Mini). */
  protonPython: (): string => env("OMNI_PROTON_PYTHON") ?? "python3",
  protonSendTimeoutMs: (): number => int("OMNI_PROTON_SEND_TIMEOUT_MS", 90_000),
  tweetSendPath: (): string | undefined => env("OMNI_TWEET_SEND"),
  tweetPython: (): string => env("OMNI_TWEET_PYTHON") ?? "python3",
  ownerEmail: (): string => config.ownerEmail,
  appOrigin: (): string => config.appOrigin,
};

export const OMNI_API_VERSION = 1;
export const OMNI_MIN_CLIENT = "1.0";

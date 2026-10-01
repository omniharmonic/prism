/**
 * Billing-mode detection for the agent runner (Arch v2 WP3.4).
 *
 * The runner uses whatever login the `claude` CLI has under HOME. On a claude.ai
 * SUBSCRIPTION login the CLI's `total_cost_usd` is an API-equivalent ESTIMATE
 * (it counts against subscription usage, nothing is billed); on an API-key login
 * it is a real charge. The UI labels the figure accordingly, so the server probes
 * once (`claude auth status` → `authMethod`) and caches the answer.
 *
 * - the probe is injectable (`configureBilling`); tests never run the real CLI;
 * - it runs with the runner's secret-free env allowlist (`dispatchEnv`);
 * - only the auth METHOD is read — email / org / account ids in the output are
 *   never stored or logged.
 * - nothing probes lazily: `probeBilling()` is called at boot (index.ts) and on a
 *   slow timer, and until it has answered the mode is "unknown".
 */
import { execFile } from "node:child_process";
import { dispatchEnv, resolveClaude } from "./agent-exec";

export type BillingMode = "subscription" | "api" | "unknown";

/** Run the CLI and return its raw stdout (or null on failure/timeout). */
export type AuthStatusRunner = () => Promise<string | null>;

const defaultRunner: AuthStatusRunner = () =>
  new Promise((resolve) => {
    let claude: string;
    try {
      claude = resolveClaude();
    } catch {
      resolve(null);
      return;
    }
    execFile(
      claude,
      ["auth", "status"],
      { env: dispatchEnv(process.env, claude), timeout: 15_000, maxBuffer: 256 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

/** Map the CLI's `authMethod` to a billing mode. Pure. */
export function billingFromAuthStatus(raw: string | null): BillingMode {
  if (!raw) return "unknown";
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!j || typeof j !== "object") return "unknown";
  const o = j as Record<string, unknown>;
  if (o.loggedIn === false) return "unknown";
  const m = typeof o.authMethod === "string" ? o.authMethod.toLowerCase() : "";
  if (!m) return "unknown";
  if (/claude\.?ai|subscription|oauth|max|pro/.test(m) && !/api[-_ ]?key/.test(m)) return "subscription";
  if (/api|console|key|bedrock|vertex|foundry/.test(m)) return "api";
  return "unknown";
}

let runner: AuthStatusRunner = defaultRunner;
let cached: { mode: BillingMode; at: number } = { mode: "unknown", at: 0 };

/** Override the probe (tests) or reset it (no args). Also clears the cache. */
export function configureBilling(r?: AuthStatusRunner): void {
  runner = r ?? defaultRunner;
  cached = { mode: "unknown", at: 0 };
}

/** The cached billing mode ("unknown" until a probe has answered). Never probes. */
export function getBillingMode(): BillingMode {
  return cached.mode;
}

/** Probe now and cache the result. Never throws. */
export async function probeBilling(now = Date.now()): Promise<BillingMode> {
  let mode: BillingMode = "unknown";
  try {
    mode = billingFromAuthStatus(await runner());
  } catch {
    mode = "unknown";
  }
  cached = { mode, at: now };
  return mode;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Probe at boot (fire-and-forget) and hourly after (unref'd). Idempotent. */
export function startBillingProbe(): void {
  void probeBilling().then((m) => console.log(`[agent] billing mode: ${m}`));
  if (!timer) {
    timer = setInterval(() => void probeBilling(), 3600_000);
    timer.unref();
  }
}

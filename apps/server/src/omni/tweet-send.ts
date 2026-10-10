/** Called only after the human approval ledger atomically claims an exact draft. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { omniConfig } from "./config";
import { realSpawner, type Spawner } from "./proton-send";
import type { ExecOutcome } from "./approvals";

export function tweetSendConfigured(): boolean {
  const p = omniConfig.tweetSendPath();
  return !!p && isAbsolute(p) && existsSync(p);
}
let spawner: Spawner = realSpawner;
export function setTweetSpawnerForTests(value: Spawner | null): void { spawner = value ?? realSpawner; }
export async function runTweetSend(payload: Record<string, unknown>): Promise<ExecOutcome> {
  if (!tweetSendConfigured()) return { status: "disabled", detail: { error: "executor_disabled", executor: "approved-tweet" } };
  if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 4000)
    return { status: "failed", detail: { error: "invalid_payload", executor: "approved-tweet" } };
  const script = omniConfig.tweetSendPath()!;
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "TZ"]) if (process.env[key]) env[key] = process.env[key]!;
  const result = await spawner(omniConfig.tweetPython(), [script, "--approved-json"], {
    cwd: dirname(dirname(script)), env, input: JSON.stringify({ text: payload.text }), timeoutMs: 45_000,
  });
  const detail: Record<string, unknown> = { executor: "approved-tweet" };
  if (result.signal === "spawn_error") return { status: "failed", detail: { ...detail, error: "spawn_error" } };
  if (result.signal || result.timedOut) return { status: "unknown", detail: { ...detail, error: "outcome_unknown" } };
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (result.code === 0 && value.status === "sent" && typeof value.postId === "string" && /^\d{1,30}$/.test(value.postId))
      return { status: "sent", detail: { ...detail, postId: value.postId } };
    const failed = new Set(["invalid_payload", "approval_executor_only", "credentials_unavailable", "approved_json_required", "provider_rejected"]);
    if (result.code !== 0 && value.status === "failed" && typeof value.error === "string" && failed.has(value.error))
      return { status: "failed", detail: { ...detail, error: value.error } };
  } catch { /* Never turn a malformed or missing receipt into success. */ }
  return { status: "unknown", detail: { ...detail, error: "outcome_unknown" } };
}

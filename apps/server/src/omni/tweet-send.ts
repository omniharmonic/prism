/** Called only after the human approval ledger atomically claims an exact draft. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { omniConfig } from "./config";
import { realSpawner, type Spawner } from "./proton-send";
import type { ExecOutcome } from "./approvals";
import { GRANT_ENV, GRANT_FD, mintSendGrant, revokeSendGrant, tweetSendDigest } from "./send-grant";

export function tweetSendConfigured(): boolean {
  const p = omniConfig.tweetSendPath();
  return !!p && isAbsolute(p) && existsSync(p);
}
let spawner: Spawner = realSpawner;
export function setTweetSpawnerForTests(value: Spawner | null): void { spawner = value ?? realSpawner; }
export async function runTweetSend(payload: Record<string, unknown>, approvalId: string): Promise<ExecOutcome> {
  if (!tweetSendConfigured()) return { status: "disabled", detail: { error: "executor_disabled", executor: "approved-tweet" } };
  if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 4000)
    return { status: "failed", detail: { error: "invalid_payload", executor: "approved-tweet" } };
  const script = omniConfig.tweetSendPath()!;
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "TZ"]) if (process.env[key]) env[key] = process.env[key]!;
  // One-time grant bound to this approval and these exact bytes (send-grant.ts); the
  // script verifies and consumes it with this server before it calls the provider.
  const grant = mintSendGrant(approvalId, tweetSendDigest(payload.text));
  env[GRANT_ENV.fd] = String(GRANT_FD);
  env[GRANT_ENV.approval] = approvalId;
  let result: Awaited<ReturnType<Spawner>>;
  try {
    result = await spawner(omniConfig.tweetPython(), [script, "--approved-json"], {
      cwd: dirname(dirname(script)), env, input: JSON.stringify({ text: payload.text }), timeoutMs: 45_000, grant,
    });
  } finally {
    revokeSendGrant(grant);
  }
  const detail: Record<string, unknown> = { executor: "approved-tweet" };
  if (result.signal === "spawn_error") return { status: "failed", detail: { ...detail, error: "spawn_error" } };
  if (result.signal || result.timedOut) return { status: "unknown", detail: { ...detail, error: "outcome_unknown" } };
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (result.code === 0 && value.status === "sent" && typeof value.postId === "string" && /^\d{1,30}$/.test(value.postId))
      return { status: "sent", detail: { ...detail, postId: value.postId } };
    const failed = new Set(["invalid_payload", "approval_executor_only", "credentials_unavailable", "approved_json_required", "provider_rejected", "send_grant_refused"]);
    if (result.code !== 0 && value.status === "failed" && typeof value.error === "string" && failed.has(value.error))
      return { status: "failed", detail: { ...detail, error: value.error } };
  } catch { /* Never turn a malformed or missing receipt into success. */ }
  return { status: "unknown", detail: { ...detail, error: "outcome_unknown" } };
}

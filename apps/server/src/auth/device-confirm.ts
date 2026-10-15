/**
 * New-device consent needs an EXISTING device (one-door review R2-1, controller ruling).
 *
 * A browser session is weaker than a device token: a magic link can be read by anything
 * that reads the owner's mailbox (an agent with a mail-search tool included). So once the
 * owner has at least one live device token, approving a NEW device on the consent page is
 * not enough: the request becomes a `device-sign-in` approval in the Omni app's Needs you,
 * and only a decision from a signed-in DEVICE (`pd_…`, human origin, the exact digest) lets
 * the code exchange finish. Denial, cancellation or 10 minutes of silence refuse it.
 *
 * Bootstrap: with ZERO live devices, the consent page works as before (otherwise nobody
 * could ever sign in a first device). Revoking devices with a browser session is refused
 * (routes/device.ts), so a stolen session cannot empty the account to reopen bootstrap.
 *
 * Applies to the server owner's account while Omni is enabled (the approval queue is the
 * owner's; other accounts have no Omni device to confirm from).
 */
import { config } from "../config";
import { listLiveDeviceTokens, type DeviceAuthRequestRow } from "../db";
import { createApproval, expireApprovals, getApproval } from "../omni/approvals";
import { omniConfig } from "../omni/config";
import { publishNotice, pushOmni } from "../omni/bus";

export const CONFIRM_TTL_MS = 10 * 60_000;

/** parked request id → the approval that decides it (in memory: a restart = start again). */
const pending = new Map<string, { approvalId: string; email: string }>();

export function needsDeviceConfirmation(email: string): boolean {
  return omniConfig.enabled() && email.toLowerCase() === config.ownerEmail.toLowerCase() && listLiveDeviceTokens(email).length > 0;
}

/** Coarse hints for the card (never the full address). */
export function requestHints(get: (k: string) => string | undefined): { ipHint?: string; userAgentHint?: string } {
  const ip = (get("cf-connecting-ip") ?? get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  let ipHint: string | undefined;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) ipHint = ip.split(".").slice(0, 2).join(".") + ".x.x";
  else if (ip.includes(":")) ipHint = ip.split(":").slice(0, 3).join(":") + ":…";
  else ipHint = "this machine or the local network";
  const ua = (get("user-agent") ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, 160);
  return { ipHint, ...(ua ? { userAgentHint: ua } : {}) };
}

/** Ask the owner's existing device. Idempotent per parked request. */
export function requestConfirmation(req: DeviceAuthRequestRow, email: string, label: string, hints: { ipHint?: string; userAgentHint?: string }): string {
  const known = pending.get(req.id);
  if (known) return known.approvalId;
  const a = createApproval({
    owner: config.ownerEmail,
    threadId: null,
    kind: "device-sign-in",
    payload: {
      clientId: req.client_id,
      label,
      redirectUri: req.redirect_uri,
      requestedAt: new Date().toISOString(),
      ...(hints.ipHint ? { ipHint: hints.ipHint } : {}),
      ...(hints.userAgentHint ? { userAgentHint: hints.userAgentHint } : {}),
    },
    summary: `Sign in a new device: ${label}`,
    ttlMs: CONFIRM_TTL_MS,
  });
  pending.set(req.id, { approvalId: a.id, email });
  publishNotice({ type: "approval", id: a.id, op: "pending" });
  pushOmni("OMNI_APPROVAL", a.id);
  return a.id;
}

export type ConfirmState = { state: "none" } | { state: "pending" } | { state: "approved"; email: string } | { state: "denied" };

export function confirmationState(reqId: string): ConfirmState {
  const p = pending.get(reqId);
  if (!p) return { state: "none" };
  expireApprovals();
  const a = getApproval(config.ownerEmail, p.approvalId);
  if (!a) return { state: "denied" };
  if (a.status === "pending" || a.status === "approved") return { state: "pending" };
  if (a.status === "sent") return { state: "approved", email: p.email };
  return { state: "denied" };
}

export const clearConfirmation = (reqId: string): void => void pending.delete(reqId);
export const pendingApprovalFor = (reqId: string): string | null => pending.get(reqId)?.approvalId ?? null;
export function resetDeviceConfirmationsForTests(): void {
  pending.clear();
}

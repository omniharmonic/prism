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
import { createHmac } from "node:crypto";
import { config } from "../config";
import { deviceBootstrapOpen, type DeviceAuthRequestRow } from "../db";
import { createApproval, expireApprovals, getApproval } from "../omni/approvals";
import { omniConfig } from "../omni/config";
import { publishNotice, pushOmni } from "../omni/bus";

export const CONFIRM_TTL_MS = 10 * 60_000;

/** parked request id → the approval that decides it (in memory: a restart = start again). */
const pending = new Map<string, { approvalId: string; email: string }>();

/**
 * Does this sign-in need an existing device's approval? Yes for the owner while Omni is on,
 * unless first-device bootstrap is open: the account never had a device, or its last device
 * stopped being live 24 h ago and not through a session (db.deviceBootstrapOpen, review C1).
 */
export function needsDeviceConfirmation(email: string): boolean {
  return email.toLowerCase() === config.ownerEmail.toLowerCase() && !deviceBootstrapOpen(email);
}
/** Confirmation is only possible while Omni (the approval queue) is on. */
export const confirmationAvailable = (): boolean => omniConfig.enabled();

/**
 * The short code shown on BOTH the waiting page and the Omni card (review I1): the owner
 * approves only if they match, so a second, attacker-started request (same claimed label,
 * same genuine redirect) is told apart. Derived from the parked request id with the server
 * secret: not guessable, stable across page reloads.
 */
export function matchCodeFor(reqId: string): string {
  const h = createHmac("sha256", config.sessionSecret || "unset").update(`device-match:${reqId}`).digest();
  const n = h.readUInt32BE(0) % 1_000_000;
  const d = String(n).padStart(6, "0");
  return `${d.slice(0, 3)} ${d.slice(3)}`;
}

/** A sign-in already waiting for this account's approval (only one at a time). */
export function otherPendingSignIn(reqId: string): boolean {
  for (const [id, p] of pending) {
    if (id === reqId) continue;
    expireApprovals();
    const a = getApproval(config.ownerEmail, p.approvalId);
    if (a && (a.status === "pending" || a.status === "approved")) return true;
  }
  return false;
}

/**
 * Coarse hints for the card (never the full address). The client IP header is set by the
 * Cloudflare tunnel, but anything on this machine can send it too, so it is believed only
 * when the request ALSO arrived for the public host (the tunnel's Host). Otherwise: local.
 * Hints are claims either way; the matching code is the check.
 */
export function requestHints(get: (k: string) => string | undefined): { ipHint?: string; userAgentHint?: string } {
  let publicHost = "";
  try {
    publicHost = new URL(config.appOrigin).host.toLowerCase();
  } catch {
    /* no public origin */
  }
  const viaTunnel = !!get("cf-connecting-ip") && !!publicHost && (get("host") ?? "").toLowerCase() === publicHost && !/^(localhost|127\.|\[::1\])/.test(publicHost);
  const ip = viaTunnel ? (get("cf-connecting-ip") ?? "").trim() : "";
  let ipHint: string;
  // R4 M-b: the Host header can be forged locally too, so every hint is a CLAIM made by the
  // request and is labelled so. The matching code is the check.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) ipHint = "reported from " + ip.split(".").slice(0, 2).join(".") + ".x.x (unverified)";
  else if (ip.includes(":")) ipHint = "reported from " + ip.split(":").slice(0, 3).join(":") + ":… (unverified)";
  else ipHint = "reported from this Mac or the local network (unverified)";
  const ua = (get("user-agent") ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, 160);
  return { ipHint, ...(ua ? { userAgentHint: ua } : {}) };
}

/** Ask the owner's existing device. Idempotent per parked request. */
export function requestConfirmation(req: DeviceAuthRequestRow, email: string, label: string, hints: { ipHint?: string; userAgentHint?: string }): string {
  const known = pending.get(req.id);
  if (known) return known.approvalId;
  // Never outlive the parked request (review M1).
  // Never outlive the parked request (review M1 / R4 M-a): min(own TTL, request's life).
  const ttlMs = Math.min(CONFIRM_TTL_MS, req.expires_at - Date.now());
  const a = createApproval({
    owner: config.ownerEmail,
    threadId: null,
    kind: "device-sign-in",
    payload: {
      clientId: req.client_id,
      label,
      redirectUri: req.redirect_uri,
      requestedAt: new Date().toISOString(),
      matchCode: matchCodeFor(req.id),
      ...(hints.ipHint ? { ipHint: hints.ipHint } : {}),
      ...(hints.userAgentHint ? { userAgentHint: hints.userAgentHint } : {}),
    },
    summary: `Sign in a new device: ${label}`,
    ttlMs,
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

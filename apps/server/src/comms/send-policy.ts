// Who may send where (comms/send.ts) — kept apart so the read path (timeline.ts) can show the
// per-channel `send` capability without importing the send pipeline.
import { config } from "../config";
import type { Capabilities, Network } from "./types";
import { blueBubblesActive, blueBubblesCreds } from "../bluebubbles/config";
import { blueBubblesReachable } from "../bluebubbles/ready";
import { omniConfig } from "../omni/config";
import { executorFor } from "../omni/approvals";

/** Matrix-bridged networks a Comms send may target (imessage / sms: BLUEBUBBLES_NETWORKS; email: no). */
// NOT "matrix": in a native Matrix room the message would be posted as the stored account
// (@omni-agent) — it would read as Omni speaking, not the owner (D9; controller ruling M9).
// Bridged networks relay it as the owner's own account.
export const SEND_NETWORKS: ReadonlySet<Network> = new Set<Network>(["whatsapp", "telegram", "discord", "messenger", "x", "signal", "slack", "instagram", "linkedin"]);

/** iMessage / SMS (BlueBubbles, D5/D6): sent through the BlueBubbles transport, not Matrix. */
export const BLUEBUBBLES_NETWORKS: ReadonlySet<Network> = new Set<Network>(["imessage", "sms"]);
export const isBlueBubblesNetwork = (n: Network): boolean => BLUEBUBBLES_NETWORKS.has(n);

const sendSwitch = (): boolean => config.commsEnabled && config.commsSendEnabled;
/** Matrix-bridged sending: COMMS_SEND_ENABLED + the Matrix live-action family flag. */
export const matrixSendEnabled = (): boolean => sendSwitch() && config.actionsMatrixEnabled;
/** iMessage/SMS sending: COMMS_SEND_ENABLED + BLUEBUBBLES_ENABLED (loopback URL + credential)
 *  + BlueBubbles answered recently (bluebubbles/ready.ts). */
export const imessageSendEnabled = (): boolean => sendSwitch() && blueBubblesActive() && !!blueBubblesCreds() && blueBubblesReachable();

/** Email (comms/email-send.ts): COMMS_SEND_ENABLED + COMMS_EMAIL_SEND_ENABLED + COMMS_EMAIL_ENABLED,
 *  and the ONE DOOR it goes through must be open — OMNI_ENABLED (the send-grant verify route lives
 *  there) and the Omni email executor switched on (proton_send.py configured, executors not off). */
export const emailSendEnabled = (): boolean =>
  sendSwitch() && config.commsEmailEnabled && config.commsEmailSendEnabled && omniConfig.enabled()
  // Only through proton_send.py (never Prism's own SMTP live action).
  && omniConfig.emailExecutor() === "proton-send" && executorFor("email-reply").enabled && executorFor("email").enabled;

/** The kill switch: any family can send (COMMS_SEND_ENABLED + its family flag + COMMS_ENABLED). */
export const commsSendEnabled = (): boolean => matrixSendEnabled() || imessageSendEnabled() || emailSendEnabled();

/** Per-channel `send` capability (wire): sending on for that network's family. Email: a reply to
 *  the thread's newest inbound note through the Omni approval executor (comms/email-send.ts). */
export const channelCanSend = (network: Network): boolean =>
  network === "email" ? emailSendEnabled()
  : isBlueBubblesNetwork(network) ? imessageSendEnabled() : matrixSendEnabled() && SEND_NETWORKS.has(network);

/** Bridged networks whose mautrix bridge turns a Matrix mention pill (matrix.to link +
 *  m.mentions) into the network's own @mention. Not linkedin / x (no group mentions bridged). */
export const MENTION_NETWORKS: ReadonlySet<Network> = new Set<Network>(["whatsapp", "telegram", "signal", "slack", "discord", "messenger"]);

/** Capabilities as the wire shows them: the projection's flags + `send` (+ `mentions`). */
export function withSendFlag(network: Network, caps: Capabilities): Capabilities {
  // `react` on the wire = Comms can react here: the room supports it AND sending is possible
  // (same gates: flags, a bridged network, not encrypted). Phase 1 showed the projection's value.
  const sendable = channelCanSend(network) && caps.encrypted !== true;
  const mentions = sendable && !isBlueBubblesNetwork(network) && MENTION_NETWORKS.has(network);
  return { ...caps, react: caps.react && sendable, send: sendable, ...(mentions ? { mentions: true } : {}) };
}


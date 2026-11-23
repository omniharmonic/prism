// Bridge bots and bridge management rooms, shared by the projection (project.ts: such rooms are
// never listed) and the send path (send.ts: never a send target).
import { agentSenderIds, isBridgeBot } from "../worker/matrix.js";
import { storedOwnerSenders } from "./owner.js";

/** A bridge bot by the mautrix naming (`…bot:`, `@_…`), or an account named exactly after a
 *  bridged network (`@signal:hs`, `@whatsapp:hs` — a bot with a configured bare name). Such a
 *  member never counts as a person: a room holding only them is a management room. */
const BARE_BRIDGE_NAME = /^@(whatsapp|telegram|signal|slack|discord|meta|messenger|facebook|instagram|twitter|gmessages|imessage|sms|linkedin|googlechat|gchat)(bot)?:/i;
export const isBridgeLike = (id: string): boolean => isBridgeBot(id) || BARE_BRIDGE_NAME.test(id);

/** A bridge puppet (`@<network>_<id>:`): a real chat on the other side. */
const PUPPET = /^@[a-z]+_[^:]+:/i;

/** One of Omni's own bridge-puppet accounts (OMNI_AGENT_MATRIX_IDS, e.g. the Omni Telegram bot):
 *  a conversation partner shown as Omni (isOmni, NOT the owner's outgoing bubbles), and a
 *  recipient for sending (S2 ruling). The stored account itself is not a puppet. */
export function isAgentPuppet(id: string, agents: readonly string[] = agentSenderIds(), owners: readonly string[] = storedOwnerSenders()): boolean {
  const l = id.toLowerCase();
  // The owner's own ghost stays the owner even when it is also listed as an agent sender.
  return PUPPET.test(l) && agents.some((a) => a.toLowerCase() === l) && !owners.some((o) => o.toLowerCase() === l);
}

/**
 * A bridge management / status room ("Successfully synchronized chats …"): besides the owner's
 * own ids there is nobody but bridge bots and native (non-puppet) agent accounts, and at least
 * one bridge bot. A room where the other person simply left (no bot) is not one. An agent
 * PUPPET (the owner's Omni Telegram bot, S2 ruling) is a real conversation partner.
 */
export function isManagementRoom(memberIds: readonly string[], isSelf: (id: string) => boolean): boolean {
  const agents = new Set(agentSenderIds().map((a) => a.toLowerCase()));
  const notSelf = memberIds.filter((id) => !isSelf(id));
  if (!notSelf.some(isBridgeLike)) return false;
  return notSelf.every((id) => isBridgeLike(id) || (agents.has(id.toLowerCase()) && !isAgentPuppet(id)));
}

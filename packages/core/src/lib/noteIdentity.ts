/** Virtual workspace destinations are never vault note IDs. */
const VIRTUAL_IDS = new Set([
  "messages-dashboard", "calendar-dashboard", "vault-messages", "agent-activity",
  "network", "map", "agent-chat",
]);
export function isVaultNoteId(id: string | null | undefined): id is string {
  return !!id && !id.includes(":") && !VIRTUAL_IDS.has(id);
}

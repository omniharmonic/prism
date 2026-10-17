/**
 * One door (review S6): an email-reply draft's subject and threading headers are fixed when the
 * draft is CREATED, from the stored email note in the primary vault (applyReplyContext). Every
 * way a reply draft becomes an approval goes through here: the propose hook, the owner's edit,
 * and a card option the owner chose. The send script refuses a reply without them.
 */
import { ApprovalInputError, applyReplyContext } from "./approvals";
import { omniConfig } from "./config";
import { vaultClient, VaultError } from "../parachute";
import { resolveVaultEntry } from "../db";

type ReplyNote = { tags?: string[] | null; metadata?: Record<string, unknown> | null } | null;
const vaultNote = async (noteId: string): Promise<ReplyNote> =>
  (await vaultClient(resolveVaultEntry(undefined).id).getNote(noteId)) as unknown as ReplyNote;
let readNote: (noteId: string) => Promise<ReplyNote> = vaultNote;
/** Tests: where the email note is read from (the check itself is unchanged). null restores the vault. */
export function setReplyNoteReaderForTests(fn: ((noteId: string) => Promise<ReplyNote>) | null): void {
  readNote = fn ?? vaultNote;
}

/** An email-reply draft gets its subject + threading from the PRIMARY vault's note now. */
export async function withReplyContext(kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (kind !== "email-reply") return payload;
  let note: ReplyNote = null;
  try {
    note = await readNote(String(payload.noteId));
  } catch (e) {
    if (!(e instanceof VaultError && e.status === 404)) throw new ApprovalInputError("noteId: the email note could not be read right now; try again");
  }
  return applyReplyContext(payload, note, omniConfig.ownerEmail());
}

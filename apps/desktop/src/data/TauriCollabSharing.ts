import { invoke } from "@tauri-apps/api/core";
import type { CollabSharing, NoteAccess, ShareLevel, ShareLink } from "@prism/core";

/**
 * Desktop implementation of the CollabSharing seam — full parity with the web
 * shell's share dialog (people grants, capability links, tag-grants). Every call
 * is proxied through the `acl_request` Rust command, which talks to the Prism
 * Server's owner-only `/acl` API using the COLLAB_TOKEN held in the desktop
 * config. The token never enters the web context; the frontend only ever names
 * a method + path, exactly like the web client's `fetch('/acl' + path)`.
 *
 * Because `getAccess` is present, `ShareButton` lights up the rich Google-Docs
 * dialog instead of the legacy one-shot "edit link" dropdown.
 */
async function acl<T>(method: string, path: string, body?: unknown): Promise<T> {
  return invoke<T>("acl_request", { method, path, body: body ?? null });
}

const enc = encodeURIComponent;

async function createLink(
  noteId: string,
  level: ShareLevel,
  expiresInDays?: number,
): Promise<ShareLink> {
  return acl<ShareLink>("POST", `/notes/${enc(noteId)}/links`, { level, expiresInDays });
}

export const tauriCollabSharing: CollabSharing = {
  // Legacy one-click link → an "edit" capability link (kept for compatibility;
  // the rich dialog supersedes it now that getAccess is implemented).
  async createShareLink(noteId: string): Promise<string> {
    return (await createLink(noteId, "edit")).url;
  },

  async getAccess(noteId: string): Promise<NoteAccess> {
    return acl<NoteAccess>("GET", `/notes/${enc(noteId)}`);
  },
  async setPerson(noteId: string, email: string, level: ShareLevel): Promise<void> {
    await acl("PUT", `/notes/${enc(noteId)}/people`, { email, level });
  },
  async removePerson(noteId: string, email: string): Promise<void> {
    await acl("DELETE", `/notes/${enc(noteId)}/people/${enc(email)}`);
  },
  createLink,
  async revokeLink(noteId: string, linkId: string): Promise<void> {
    await acl("DELETE", `/notes/${enc(noteId)}/links/${enc(linkId)}`);
  },
  async listUsers(): Promise<string[]> {
    const users = await acl<Array<{ email: string }>>("GET", `/users`);
    return users.map((u) => u.email);
  },
};

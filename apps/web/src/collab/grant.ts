import type { CollabSharing, NoteAccess, ShareLevel, ShareLink } from "@prism/core";
import { GATEWAY_ORIGIN } from "../config";

/**
 * Web sharing impl, backed by the Prism Server ACL API (/acl, owner-only). The
 * browser never holds a vault token; these calls ride the owner's session
 * cookie. Powers the full share dialog (people + capability links + tag-grants).
 */
async function acl(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${GATEWAY_ORIGIN}/acl${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string>) },
  });
  if (!r.ok) throw new Error(`ACL ${init?.method ?? "GET"} ${path} → ${r.status}`);
  return r;
}

const enc = encodeURIComponent;

async function createLink(noteId: string, level: ShareLevel, expiresInDays?: number): Promise<ShareLink> {
  return (await acl(`/notes/${enc(noteId)}/links`, {
    method: "POST",
    body: JSON.stringify({ level, expiresInDays }),
  })).json();
}

export const webCollabSharing: CollabSharing = {
  // Legacy one-click link → an "edit" capability link.
  async createShareLink(noteId: string): Promise<string> {
    return (await createLink(noteId, "edit")).url;
  },

  async getAccess(noteId: string): Promise<NoteAccess> {
    return (await acl(`/notes/${enc(noteId)}`)).json();
  },
  async setPerson(noteId: string, email: string, level: ShareLevel): Promise<void> {
    await acl(`/notes/${enc(noteId)}/people`, { method: "PUT", body: JSON.stringify({ email, level }) });
  },
  async removePerson(noteId: string, email: string): Promise<void> {
    await acl(`/notes/${enc(noteId)}/people/${enc(email)}`, { method: "DELETE" });
  },
  createLink,
  async revokeLink(noteId: string, linkId: string): Promise<void> {
    await acl(`/notes/${enc(noteId)}/links/${enc(linkId)}`, { method: "DELETE" });
  },
  async listUsers(): Promise<string[]> {
    const users = (await (await acl(`/users`)).json()) as Array<{ email: string }>;
    return users.map((u) => u.email);
  },
};

/**
 * Retired: minted a collab grant from the Worker using the browser's vault
 * token. Throwing stub keeps the /collab route compiling until the
 * Hocuspocus-based path (P3) replaces it. Callers wrap this in `.catch`.
 */
export async function mintGrant(_noteId: string, _token: string): Promise<string> {
  throw new Error("Collab grant minting moved server-side (Prism Server, P3).");
}

import type {
  CollabSharing,
  NoteAccess,
  PublicationInfo,
  SetPersonResult,
  ShareLevel,
  ShareLink,
} from "@prism/core";
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
  async setPerson(noteId: string, email: string, level: ShareLevel): Promise<SetPersonResult> {
    return (await acl(`/notes/${enc(noteId)}/people`, { method: "PUT", body: JSON.stringify({ email, level }) })).json();
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

  // ── Publishing (turn a tag into a public, read-only Wiki) ──
  async listPublications(): Promise<PublicationInfo[]> {
    return (await acl(`/publications`)).json();
  },
  async publishTag(
    tag: string,
    opts?: { template?: string; title?: string; password?: string },
  ): Promise<{ slug: string; url: string; count: number; passwordRequired: boolean }> {
    return (await acl(`/tags/${enc(tag)}/publish`, { method: "POST", body: JSON.stringify(opts ?? {}) })).json();
  },
  async setPublishPassword(tag: string, password: string | null): Promise<void> {
    await acl(`/tags/${enc(tag)}/publish/password`, {
      method: "PUT",
      body: JSON.stringify({ password: password ?? "" }),
    });
  },
  async unpublishTag(tag: string): Promise<void> {
    await acl(`/tags/${enc(tag)}/publish`, { method: "DELETE" });
  },
};

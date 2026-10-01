import {
  apiBase,
  capabilityHeader,
  contextHeaders,
  fetchMe,
  getCapabilityToken,
  getMe,
} from "../config";

/** Persist identity, never credentials. Resolved IDs prevent default-vault drift. */
export interface WriteScope {
  api: string;
  workspace: string;
  vault: string;
  actor: string;
}
export interface WriteContext {
  scope: WriteScope;
  headers: Record<string, string>;
}
export function scopeKey(scope: WriteScope): string {
  return JSON.stringify([scope.api, scope.workspace, scope.vault, scope.actor]);
}
export function sameScope(
  a: WriteScope | undefined,
  b: WriteScope | undefined,
): boolean {
  return !!a && !!b && scopeKey(a) === scopeKey(b);
}

export async function captureWriteContext(
  refresh = false,
): Promise<WriteContext> {
  const capability = getCapabilityToken();
  if (refresh && !capability && !(await fetchMe()).authenticated) {
    throw new Error("Reconnect before sending saved changes.");
  }
  const headers = { ...contextHeaders(), ...capabilityHeader() };
  const api = new URL(apiBase(), location.origin).href;
  const me = getMe();
  if (
    !capability &&
    (!me?.authenticated || !me.email || !me.vaultId || !me.workspace?.id)
  ) {
    throw new Error(
      "Reconnect to this workspace before saving a new offline change.",
    );
  }
  let actor: string;
  if (capability) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(capability),
    );
    actor = `capability:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (getCapabilityToken() !== capability)
      throw new Error("Access changed while preparing this change. Try again.");
  } else {
    actor = `user:${me!.email}`;
  }
  const scope: WriteScope = {
    api,
    vault: capability ? (headers["X-Prism-Vault"] ?? "primary") : me!.vaultId!,
    workspace: capability
      ? (headers["X-Prism-Workspace"] ?? "default")
      : me!.workspace!.id,
    actor,
  };
  return {
    scope,
    headers: {
      "Content-Type": "application/json",
      ...headers,
      "X-Prism-Vault": scope.vault,
      "X-Prism-Workspace": scope.workspace,
      "X-Prism-Write-Actor": actor,
    },
  };
}

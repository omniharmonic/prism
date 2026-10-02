import type { HumanCollabSend } from "@prism/core/collab-commands";
import { captureWriteContext, scopeKey } from "../offline/writeScope";
import { serverFetch } from "../transport";
import { contextHeaders, getCapabilityToken } from "../config";
export function humanCommandsFor(noteId: string): HumanCollabSend {
  const binding = JSON.stringify([contextHeaders(), getCapabilityToken()]);
  const initial = captureWriteContext();
  return async command => {
    const original = await initial;
    const current = await captureWriteContext(true);
    if (binding !== JSON.stringify([contextHeaders(), getCapabilityToken()]) || scopeKey(original.scope) !== scopeKey(current.scope)) throw new Error("Workspace or account changed. Reopen the original document to recover your draft.");
    const response = await serverFetch(`${original.scope.api}/collab/${encodeURIComponent(noteId)}/commands`, { method: "POST", credentials: "include", headers: original.headers, body: JSON.stringify(command) });
    const body = await response.json();
    if (binding !== JSON.stringify([contextHeaders(), getCapabilityToken()]) || scopeKey(original.scope) !== scopeKey((await captureWriteContext()).scope)) throw new Error("Workspace or account changed. Reopen the original document to check this submission.");
    if (!response.ok) throw Object.assign(new Error(typeof body.error === "string" ? body.error : "Could not confirm this change."), { status: response.status });
    if (!body || ![body.suggestionId, body.threadId].some(v => typeof v === "string" && v.length > 0)) throw new Error("The server did not confirm the change. Retry the same request.");
    return body;
  };
}

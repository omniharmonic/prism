// The Comms read API for Prism's Messages screens (`/api/comms/*`, owner only; D19 stage 1–2).
// Reads only — sending through Comms is device-only and comes with the composer stage.
// Every call goes through serverFetch (session cookie in the PWA, device bearer in the native
// shell). Never read-through cached: comms answers are `private, no-store` and change constantly.
import type {
  CommsFolder, CommsMessagePage, CommsPerson, CommsReadClient, CommsStatusCounts, CommsThreadDetail, CommsThreadPage,
  CommsThreadQuery,
} from "@prism/core/shell";
import { threadQueryString, VaultRequestError } from "@prism/core/shell";
import { apiBase, contextHeaders } from "../config";
import { isNative, serverFetch } from "../transport";

async function get<T>(path: string): Promise<T> {
  const resp = await serverFetch(`${apiBase()}/comms${path}`, { headers: { Accept: "application/json", ...contextHeaders() }, cache: "no-store" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null) as { error?: string } | null;
    throw new VaultRequestError(resp.status, `GET /comms${path.split("?")[0]} failed: ${resp.status} ${body?.error ?? ""}`.trim());
  }
  return resp.json() as Promise<T>;
}

const seg = (id: string) => encodeURIComponent(id);

export const commsReadClient: CommsReadClient = {
  listThreads: (q: CommsThreadQuery) => get<CommsThreadPage>(`/threads${threadQueryString(q)}`),
  statusCounts: (folder: CommsFolder) => get<CommsStatusCounts>(`/threads/status-counts?folder=${seg(folder)}`),
  getThread: (id: string) => get<CommsThreadDetail>(`/threads/${seg(id)}`),
  getMessages: (id: string, before?: string) =>
    get<CommsMessagePage>(`/threads/${seg(id)}/messages${before ? `?before=${seg(before)}` : ""}`),
  getPerson: (id: string) => get<CommsPerson>(`/people/${seg(id)}`),
  // Media tokens are signed and bound to this credential; the native shell re-points the element to a
  // blob: URL fetched with the bearer (native/externalImages.ts), the PWA loads it with its cookie.
  mediaUrl: (token: string) => `${apiBase()}/comms/media/${seg(token)}`,
  // Native: audio/video load only when pressed (the bearer can't ride a <video src>, and the blob
  // route would otherwise fetch every clip in full as soon as the transcript renders).
  ...(isNative
    ? {
        loadMedia: async (token: string) => {
          const resp = await serverFetch(`${apiBase()}/comms/media/${seg(token)}`, { headers: contextHeaders() });
          if (!resp.ok) throw new VaultRequestError(resp.status, `GET /comms/media failed: ${resp.status}`);
          return URL.createObjectURL(await resp.blob());
        },
      }
    : {}),
};

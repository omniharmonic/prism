/**
 * Which transport the folder / database sync UI uses (Client parity B).
 *
 *  - Legacy desktop → its Tauri commands (`githubSyncApi` / `notionDbSyncApi`).
 *  - Web / Prism Client → the Prism Server through HostServices
 *    (`/api/sync/github/*`, `/api/sync/notion-db/*`), owner only.
 *  - Anyone else (non-owner, capability viewer) → null: the modal shows a notice.
 *
 * Both transports expose the same shape, so GitHubSyncModal / NotionDbSyncModal /
 * the MetadataPanel GitHub row are transport-agnostic.
 */
import { useIsWeb } from "../../data/Platform";
import { useHostServices } from "../../data/HostServicesContext";
import { githubSyncApi, notionDbSyncApi } from "../parachute/client";
import type { GitHubSyncHost, NotionDbSyncHost } from "./services";

export function useGitHubSyncApi(): { api: GitHubSyncHost | null; viaServer: boolean } {
  const isWeb = useIsWeb();
  const host = useHostServices();
  if (!isWeb) return { api: githubSyncApi as GitHubSyncHost, viaServer: false };
  return { api: host?.githubSync ?? null, viaServer: true };
}

export function useNotionDbSyncApi(): { api: NotionDbSyncHost | null; viaServer: boolean } {
  const isWeb = useIsWeb();
  const host = useHostServices();
  if (!isWeb) return { api: notionDbSyncApi as NotionDbSyncHost, viaServer: false };
  return { api: host?.notionDbSync ?? null, viaServer: true };
}

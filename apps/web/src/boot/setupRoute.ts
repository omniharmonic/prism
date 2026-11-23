import { useNetworkTabRequest, type InitialTab } from "@prism/core/shell";

/**
 * `/setup` — a client route like `/agent`: the app opens Workspace settings at Server, where the
 * first-run checklist is. The owner's local sign-in (`prism signin`, server route
 * /auth/local/signin) lands here while setup is unfinished. Returns the tab to open first, or
 * undefined for any other path. (Not a server route, so the service worker answers it with the app.)
 */
export function setupInitialTab(path: string): InitialTab | undefined {
  if (path !== "/setup" && path !== "/setup/") return undefined;
  // Taken by Workspace settings once it knows the viewer's role (a tab they may not see is not selected).
  useNetworkTabRequest.getState().request("server");
  return { id: "network", title: "Workspace settings", type: "network" };
}

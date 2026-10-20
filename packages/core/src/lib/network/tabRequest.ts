import { create } from "zustand";

/**
 * "Open Workspace settings AT this tab" (Settings → Inputs & integrations → Manage
 * connections). The Workspace settings tab takes the request when it mounts or while
 * it is open, then clears it; a tab the viewer may not see is simply not selected.
 */
export const useNetworkTabRequest = create<{ tab: string | null; request: (tab: string) => void; clear: () => void }>((set) => ({
  tab: null,
  request: (tab) => set({ tab }),
  clear: () => set({ tab: null }),
}));

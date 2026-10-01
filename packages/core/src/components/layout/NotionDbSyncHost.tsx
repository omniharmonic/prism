/**
 * Always-mounted host for the Notion database sync modal (Client parity B). The
 * command bar unmounts when it closes, so it opens the modal through this tiny
 * store instead ("Notion Database Sync…").
 */
import { create } from "zustand";
import { NotionDbSyncModal } from "./NotionDbSyncModal";

export const useNotionDbSyncModal = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function NotionDbSyncHost() {
  const { open, setOpen } = useNotionDbSyncModal();
  if (!open) return null;
  return <NotionDbSyncModal isOpen onClose={() => setOpen(false)} />;
}

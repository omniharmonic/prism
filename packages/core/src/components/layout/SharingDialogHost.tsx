import { useEffect } from "react";
import { create } from "zustand";
import { useCollabSharing } from "../../data/CollabSharing";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { ShareDialog } from "./ShareDialog";

// Ephemeral and audience-bound. The host lives beside the other Shell overlays,
// outside the document/header tree which remounts when the layout changes.
const useSharingDialog = create<{
  target: { noteId: string; scope: string | null } | null;
}>(() => ({ target: null }));
const close = () => useSharingDialog.setState({ target: null });
export function openSharingDialog(noteId: string) {
  useSharingDialog.setState({
    target: { noteId, scope: useAgentChatStore.getState().scope },
  });
}
export function SharingDialogHost() {
  const sharing = useCollabSharing();
  const target = useSharingDialog((s) => s.target);
  const scope = useAgentChatStore((s) => s.scope);
  useEffect(() => {
    if (target && target.scope !== scope) close();
  }, [target, scope]);
  useEffect(() => close, []);
  if (!sharing || !target || target.scope !== scope) return null;
  return (
    <ShareDialog
      key={target.noteId}
      noteId={target.noteId}
      sharing={sharing}
      onClose={close}
    />
  );
}

import { Lock } from "lucide-react";
import type { Note } from "../../lib/types";
import { usePageActions } from "../../lib/pages/usePageActions";
import "./pages.css";

/** Shown above a locked page: editing is off for everyone until someone with edit access unlocks it. */
export function LockedBanner({ note }: { note: Note & { _caps?: string[] } }) {
  const actions = usePageActions();
  const canEdit = !note._caps || note._caps.includes("edit");
  return (
    <div className="page-locked-banner" role="status">
      <Lock size={13} aria-hidden="true" />
      <span>This page is locked, so editing is off.</span>
      {canEdit && (
        <button type="button" className="focus-ring" onClick={() => void actions.toggleLock(note)}>
          Unlock
        </button>
      )}
    </div>
  );
}

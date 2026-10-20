import { createContext, useContext } from "react";
import { RefreshCw } from "lucide-react";

/**
 * NP-OF-05: a newer version of the open page arrived and was NOT taken silently
 * (the reader is in the page, or holds a draft). The host (Canvas) owns the
 * decision; a renderer with its own review surface (the document's "review the
 * latest version" preview) claims it, everything else gets the host's bar.
 */
export interface RemoteUpdateHost {
  /** The pending newer version for this renderer's note, if any. */
  pending: { content: string; updatedAt: string | null; canAdopt: boolean } | null;
  /** Replace what is on screen with the latest version (only if nothing unsaved would be lost). */
  showLatest: () => void;
  /** Keep what is on screen. A later save then conflicts instead of overwriting the newer version. */
  keepMine: () => void;
  /** This renderer shows the review itself; returns the un-claim. */
  claimReview: () => () => void;
}
export const RemoteUpdateContext = createContext<RemoteUpdateHost | null>(null);
export const useRemoteUpdateHost = () => useContext(RemoteUpdateContext);

export const REMOTE_UPDATED = "This page was updated elsewhere";
export const REMOTE_DRAFT_KEPT = "Your draft is kept here and was not changed. Submit or copy it, then reopen the page to see the latest version.";

/** The host's non-blocking bar (renderers without a review surface of their own). */
export function RemoteUpdateBar({ host }: { host: RemoteUpdateHost }) {
  if (!host.pending) return null;
  return (
    <div role="status" className="remote-update-bar" data-testid="remote-update-bar">
      <RefreshCw size={14} aria-hidden="true" />
      <span>{host.pending.canAdopt ? `${REMOTE_UPDATED}.` : `${REMOTE_UPDATED}. ${REMOTE_DRAFT_KEPT}`}</span>
      {host.pending.canAdopt && <button type="button" className="focus-ring remote-update-primary" onClick={host.showLatest}>Show latest</button>}
      <button type="button" className="focus-ring" onClick={host.keepMine}>{host.pending.canAdopt ? "Keep mine" : "Dismiss"}</button>
    </div>
  );
}

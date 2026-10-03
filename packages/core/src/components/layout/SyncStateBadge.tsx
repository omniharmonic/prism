import { AlertCircle, Check, CloudOff, Loader2, Smartphone } from "lucide-react";
import { useSyncStatus, type SyncKind } from "../../lib/sync/syncState";
import "./sync-state.css";

/** The recovery dialog for saved-on-device changes lives in the host shell (web OfflineIndicator). */
export const OPEN_SAVED_CHANGES_EVENT = "prism:open-saved-changes";

const PHONE_LABEL: Record<SyncKind, string> = {
  saved: "Saved",
  saving: "Saving…",
  offline: "Offline",
  local: "Saved on this device",
  waiting: "Saved on this device",
  review: "Needs review",
  failed: "Save failed",
};

function Icon({ kind, size }: { kind: SyncKind; size: number }) {
  if (kind === "saving") return <Loader2 size={size} className="sync-state-spin" aria-hidden />;
  if (kind === "failed" || kind === "review") return <AlertCircle size={size} aria-hidden />;
  if (kind === "offline") return <CloudOff size={size} aria-hidden />;
  if (kind === "local" || kind === "waiting") return <Smartphone size={size} aria-hidden />;
  return <Check size={size} aria-hidden />;
}

/**
 * Truthful save state (NP-OF-01 / NP-PG-06 / NP-SB-15). `header` = the desktop
 * page header, `phone` = the phone header (a dot plus short words when not
 * simply saved), `footer` = the sidebar footer ("Synced"). Actionable states
 * are buttons: a failure retries, saved-on-device changes open recovery.
 */
export function SyncStateBadge({ variant = "header" }: { variant?: "header" | "phone" | "footer" }) {
  const status = useSyncStatus();
  const text = variant === "footer" ? status.footer : variant === "phone" ? PHONE_LABEL[status.kind] : status.label;
  const actionable = status.kind === "failed" || status.kind === "review" || status.kind === "local" || status.kind === "waiting";
  const act = () => {
    if (status.kind === "failed" && status.failure?.retry) status.failure.retry();
    else window.dispatchEvent(new CustomEvent(OPEN_SAVED_CHANGES_EVENT));
  };
  const showText = variant !== "phone" || status.kind !== "saved";
  const body = (
    <>
      {variant === "footer" || variant === "phone"
        ? <span className="sync-state-dot" aria-hidden />
        : <Icon kind={status.kind} size={14} />}
      {showText ? <span className="sync-state-text">{text}</span> : <span className="sr-only">{text}</span>}
    </>
  );
  const common = {
    className: `sync-state sync-state-${variant}`,
    "data-sync-state": status.kind,
    title: status.kind === "failed" ? status.failure?.message ?? text : text,
  };
  // The live region announces changes without stealing focus (NP-AX-03).
  return (
    <span role="status" aria-live="polite" className="sync-state-region">
      {actionable
        ? <button type="button" {...common} onClick={act} aria-label={status.kind === "failed" ? `${text}: retry saving` : `${text}: review saved changes`}>{body}</button>
        : <span {...common}>{body}</span>}
    </span>
  );
}

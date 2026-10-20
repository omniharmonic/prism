import { CloudOff } from "lucide-react";

import { formatDate as fmtDate, formatTime as fmtTime } from "../../lib/datetime/format";
/** When the host served a page from its on-device copy, it stamps the note with when that copy was saved. */
export function offlineCopyAt(note: unknown): string | null {
  const at = (note as { _offlineCopyAt?: unknown } | null | undefined)?._offlineCopyAt;
  return typeof at === "string" && at ? at : null;
}

/** "10:42 AM" today, "Sep 30, 10:42 AM" otherwise. */
export function offlineCopyTime(at: string, now = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "earlier";
  const sameDay = when.toDateString() === now.toDateString();
  const time = fmtTime(when, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${fmtDate(when, when.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}, ${time}`;
}

/** NP-OF-02: a quiet line above a page read from the device with no connection. */
export function OfflineCopyNotice({ at }: { at: string }) {
  return (
    <div role="status" className="offline-copy-notice" data-testid="offline-copy-notice">
      <CloudOff size={14} aria-hidden="true" />
      <span>Offline copy from <time dateTime={at}>{offlineCopyTime(at)}</time></span>
    </div>
  );
}

import { AlertCircle, AlertTriangle, Bell, Check, Clock } from "lucide-react";
import { THREAD_STATUS_LABELS, THREAD_STATUS_TONE, type ThreadStatus } from "../../lib/messages/triage";

const STATUS_ICON: Partial<Record<ThreadStatus, typeof AlertTriangle>> = {
  urgent: AlertTriangle,
  "action-required": Bell,
  unclassified: Clock,
  "triage-failed": AlertCircle,
  handled: Check,
};

/** The row's one classification chip: label (always), icon for the states that ask for you, tone from tokens. */
export function StatusChip({ status }: { status: ThreadStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="prism-status-chip" data-tone={THREAD_STATUS_TONE[status]} data-status={status}>
      {Icon && <Icon size={11} aria-hidden="true" />}
      {THREAD_STATUS_LABELS[status]}
    </span>
  );
}

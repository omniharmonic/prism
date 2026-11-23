import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { useUnreadCount } from "../../lib/notifications/hooks";
import { useUIStore } from "../../app/stores/ui";
import type { ContentType } from "../../lib/types";
import "./inbox.css";

export function openInbox(): void {
  useUIStore.getState().openTab("notifications", "Inbox", "notifications" as ContentType);
}

/** Unread count pill; renders nothing at 0 or when the server has no notifications. */
export function InboxBadge({ max = 99 }: { max?: number }) {
  const { count, available } = useUnreadCount();
  if (!available || count <= 0) return null;
  return <span className="prism-inbox-badge" data-testid="inbox-badge" aria-label={`${count} unread`}>{count > max ? `${max}+` : count}</span>;
}

/**
 * Inbox icon with its unread badge, for bars owned by other groups (the phone
 * bottom bar). Render-prop so the host keeps its own button chrome:
 *   <InboxNavButton>{({ icon, label, onClick, unread, available }) => …}</InboxNavButton>
 */
export function InboxNavButton({ children }: {
  children: (p: { icon: ReactNode; label: string; onClick: () => void; unread: number; available: boolean }) => ReactNode;
}) {
  const { count, available } = useUnreadCount();
  const icon = (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <Inbox size={20} />
      {available && count > 0 && (
        <span className="prism-inbox-badge" aria-hidden style={{ position: "absolute", top: -6, right: -10, minWidth: 16, height: 16, lineHeight: "16px", fontSize: 10 }}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  );
  return <>{children({ icon, label: count > 0 ? `Inbox, ${count} unread` : "Inbox", onClick: openInbox, unread: count, available })}</>;
}

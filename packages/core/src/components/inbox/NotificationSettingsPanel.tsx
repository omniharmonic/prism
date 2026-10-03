import { useEffect, useState } from "react";
import { useNotificationSettings, useSaveNotificationSettings } from "../../lib/notifications/hooks";
import type { NotificationSettings } from "../../lib/notifications/client";
import "./inbox.css";

const ROWS: Array<{ key: keyof NotificationSettings; label: string; hint: string }> = [
  { key: "mention", label: "Mentions", hint: "Someone @mentions you on a page" },
  { key: "comment", label: "Comments", hint: "Replies to your threads and mentions in comments" },
  { key: "reminder", label: "Reminders", hint: "Reminders you set on dates" },
  { key: "access", label: "Access", hint: "Shares and access requests" },
];

/** Per-type delivery settings (NP-CO-04). The Inbox always lists everything; these choose push and email. */
export function NotificationSettingsPanel({ onClose }: { onClose: () => void }) {
  const q = useNotificationSettings();
  const save = useSaveNotificationSettings();
  const [draft, setDraft] = useState<NotificationSettings | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.settings);
  }, [q.data, draft]);
  const available = q.data?.available;
  const set = (key: keyof NotificationSettings, channel: "push" | "email", value: boolean) =>
    setDraft((d) => (d ? { ...d, [key]: { ...d[key], [channel]: value } } : d));
  const pushAvailable = !!available && (available.webPush || available.apns);

  return (
    <section className="prism-inbox-settings" aria-label="Notification settings" data-testid="notification-settings">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">Notification settings</h2>
        <button type="button" className="prism-inbox-btn" onClick={onClose}>Close</button>
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Everything appears in your Inbox. Choose what also reaches you by push or email. Notifications never include page content.</p>
      {q.isLoading && <p className="mt-3 text-sm text-[var(--text-muted)]">Loading settings…</p>}
      {q.isError && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">Couldn’t load notification settings.</p>}
      {draft && (
        <>
          <table className="mt-3">
            <thead>
              <tr><th>Type</th><th style={{ width: 72 }}>Push</th><th style={{ width: 72 }}>Email</th></tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div className="font-medium">{r.label}</div>
                    <div className="text-xs text-[var(--text-muted)]">{r.hint}</div>
                  </td>
                  <td><input type="checkbox" aria-label={`${r.label} push`} checked={draft[r.key].push} disabled={!pushAvailable} onChange={(e) => set(r.key, "push", e.target.checked)} /></td>
                  <td><input type="checkbox" aria-label={`${r.label} email`} checked={draft[r.key].email} disabled={!available?.email} onChange={(e) => set(r.key, "email", e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {available && (!pushAvailable || !available.email) && (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              {!pushAvailable && "Push isn’t set up on this server. "}
              {!available.email && "Email delivery isn’t set up on this server."}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className="prism-inbox-btn" data-variant="primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save settings"}
            </button>
            {save.isSuccess && <span role="status" className="text-xs text-[var(--text-secondary)]">Saved</span>}
            {save.isError && <span role="alert" className="text-xs text-[var(--color-danger)]">Couldn’t save. Try again.</span>}
          </div>
        </>
      )}
    </section>
  );
}

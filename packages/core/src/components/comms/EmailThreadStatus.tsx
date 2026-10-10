import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import type { Note } from "../../lib/types";
import { TRIAGE_TAGS, THREAD_STATUS_LABELS, threadStatus, statusChange, writeTagChange, type ThreadStatus } from "../../lib/messages/triage";
import { syncTriageCaches } from "./triageCache";

/** Classification edits use the same tag operation as chats; delivery status is never edited. */
export function EmailThreadStatus({ note, readOnly }: { note: Note; readOnly: boolean }) {
  const client = useVaultClient();
  return <ScopedStatus key={JSON.stringify([client.scope?.(), note.id])} note={note} readOnly={readOnly} />;
}
function ScopedStatus({ note, readOnly }: { note: Note; readOnly: boolean }) {
  const client = useVaultClient();
  const queries = useQueryClient();
  const [tags, setTags] = useState<readonly string[]>(note.tags ?? []);
  const [status, setStatus] = useState<ThreadStatus>(threadStatus(note.tags));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setTags(note.tags ?? []); setStatus(threadStatus(note.tags)); }, [note.tags]);
  const canEdit = !readOnly && (!note._caps || note._caps.includes("edit"));
  const change = async (next: typeof TRIAGE_TAGS[number]) => {
    if (pending || !canEdit) return;
    const previous = status;
    const patch = statusChange(tags, next);
    setPending(true); setError(""); setStatus(next);
    try {
      await writeTagChange(client, note, patch);
      const confirmed = [...tags.filter(t => !patch.remove.includes(t)), ...patch.add.filter(t => !tags.includes(t))];
      setTags(confirmed); syncTriageCaches(queries, note.id, confirmed, client.scope?.());
    } catch { setStatus(previous); setError("The status update was not confirmed. Refresh this email before trying again."); }
    finally { setPending(false); }
  };
  return <div className="prism-email-category">
    <label><span>Status</span><select className="prism-thread-status focus-ring" aria-label="Thread status" value={status} disabled={!canEdit || pending}
      onChange={e => void change(e.target.value as typeof TRIAGE_TAGS[number])}>
      <option value="unclassified" disabled>{THREAD_STATUS_LABELS.unclassified}</option>
      {status === "triage-failed" && <option value="triage-failed" disabled>{THREAD_STATUS_LABELS["triage-failed"]}</option>}
      {TRIAGE_TAGS.map(tag => <option key={tag} value={tag}>{THREAD_STATUS_LABELS[tag]}</option>)}
    </select></label>
    {error && <p role="status">{error}</p>}
  </div>;
}

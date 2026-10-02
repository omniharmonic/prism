import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Link2, Search, Unlink } from "lucide-react";
import type {
  TranscriptReviewClient,
  TranscriptReviewItem,
  TranscriptCandidate,
  TranscriptDecision,
} from "../../data/TranscriptReviewClientContext";

type Draft = {
  item: TranscriptReviewItem;
  action: "link" | "unlink";
  meetingUpdatedAt: string;
  reason: string;
  confirmed: boolean;
  elsewhere: boolean;
};
const control =
  "min-h-11 rounded-lg border border-[var(--glass-border)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--glass-hover)] disabled:opacity-50";
function dateLabel(start?: string) {
  if (!start) return null;
  const date = new Date(start);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
}
function message(error: unknown) {
  const status = (error as { status?: number })?.status;
  if (status === 409)
    return "These records changed in another window. Reload records to review the latest version. Your reason is still here.";
  if (status === 403)
    return "You no longer have permission to change this association. Reload records to check your access.";
  return "The association could not be confirmed. Your reason is still here; retry or reload records.";
}

export function TranscriptReviewPanel({
  client,
  noteId,
  eventId,
  onOpen,
}: {
  client: TranscriptReviewClient;
  noteId: string;
  eventId?: string;
  onOpen: (id: string, title: string) => void;
}) {
  const scope = client.scope();
  const current = () => client.scope() === scope;
  const queries = useQueryClient();
  const [reviewing, setReviewing] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<{ key: string; body: TranscriptDecision } | null>(
    null,
  );
  const reasonId = useId();
  const result = useQuery({
    queryKey: ["calendar", "transcript-review", scope, noteId, eventId, query],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!current()) throw Error("Workspace changed");
      const review = await client.review(noteId, query);
      if (
        !current() ||
        review.meeting.id !== noteId ||
        (eventId && review.meeting.eventId !== eventId)
      )
        throw Error("Meeting identity changed");
      return review;
    },
  });
  const data = result.data;
  const blocked = busy || pending || result.isFetching || result.isError;
  const begin = (item: TranscriptReviewItem, action: "link" | "unlink") => {
    if (blocked || !data?.canManage || !item.canManage) return;
    request.current = null;
    setError("");
    setNotice("");
    setDraft({
      item,
      action,
      meetingUpdatedAt: data.meeting.updatedAt,
      reason: "",
      confirmed: false,
      elsewhere: "linkedElsewhere" in item && !!item.linkedElsewhere,
    });
  };
  const reload = async () => {
    if (lock.current || !current()) return;
    const fresh = await result.refetch();
    if (!current() || !fresh.data || fresh.error) return;
    if (!pending) {
      setError("");
      setDraft((old) => {
        if (!old) return null;
        const item = [...fresh.data.linked, ...fresh.data.candidates].find(
          (item) => item.id === old.item.id,
        );
        if (!item) return old; // Keep the user's draft; authorization below disables its action.
        return {
          ...old,
          item,
          meetingUpdatedAt: fresh.data.meeting.updatedAt,
          confirmed: false,
          elsewhere: "linkedElsewhere" in item && !!item.linkedElsewhere,
        };
      });
    }
  };
  const submit = async () => {
    if (lock.current || !current() || !draft) return;
    let body: TranscriptDecision;
    if (pending && request.current) body = request.current.body;
    else {
      if (
        blocked ||
        !data?.canManage ||
        !draft.reason.trim() ||
        (draft.elsewhere && !draft.confirmed)
      )
        return;
      const item = (
        draft.action === "unlink" ? data.linked : data.candidates
      ).find((item) => item.id === draft.item.id);
      if (!item?.canManage) return;
      const payload = {
        transcriptId: draft.item.id,
        action: draft.action,
        reason: draft.reason.trim(),
        meetingUpdatedAt: draft.meetingUpdatedAt,
        transcriptUpdatedAt: draft.item.updatedAt,
        expectedRevision: draft.item.decisionRevision,
      };
      const key = JSON.stringify(payload);
      if (request.current?.key !== key)
        request.current = {
          key,
          body: { ...payload, requestId: crypto.randomUUID() },
        };
      body = request.current.body;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await client.decide(noteId, body);
      if (!current()) return;
      if (receipt.status === "pending") {
        setPending(true);
        setNotice(
          "Your decision is saved. Prism is still updating the linked records. Retry to finish applying it before making another change.",
        );
      } else {
        setPending(false);
        setDraft(null);
        request.current = null;
        setNotice(
          body.action === "link"
            ? "Transcript linked to this meeting."
            : "Association removed. The transcript is still in your vault.",
        );
        await queries.invalidateQueries({ queryKey: ["calendar"] });
      }
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const editableDraft =
    draft &&
    data?.canManage &&
    (draft.action === "unlink" ? data.linked : data.candidates).some(
      (item) => item.id === draft.item.id && item.canManage,
    );
  const row = (item: TranscriptReviewItem, candidate = false) => (
    <div
      key={item.id}
      className="min-w-0 rounded-lg border border-[var(--glass-border)] p-2"
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          onClick={() => onOpen(item.id, item.title)}
          className="focus-ring flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg p-2 text-left text-sm"
        >
          <FileText size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {item.title}
            <span className="mt-1 block text-xs text-[var(--text-muted)]">
              {dateLabel(item.start)}
            </span>
          </span>
        </button>
        {data?.canManage && item.canManage && (
          <button
            disabled={blocked || !!draft}
            className={control + " shrink-0"}
            aria-label={(candidate ? "Link " : "Unlink ") + item.title}
            onClick={() => begin(item, candidate ? "link" : "unlink")}
          >
            {candidate ? (
              <Link2 size={15} aria-hidden="true" />
            ) : (
              <Unlink size={15} aria-hidden="true" />
            )}
            <span className="sr-only">{candidate ? "Link" : "Unlink"}</span>
          </button>
        )}
      </div>
      {candidate && (
        <div className="space-y-1 px-2 pb-2 text-xs text-[var(--text-secondary)]">
          {(item as TranscriptCandidate).evidence.length > 0 && (
            <ul
              aria-label="Match evidence"
              className="list-inside list-disc space-y-1"
            >
              {(item as TranscriptCandidate).evidence.map((evidence, index) => (
                <li key={index} className="break-words">
                  {evidence}
                </li>
              ))}
            </ul>
          )}
          {(item as TranscriptCandidate).linkedElsewhere && (
            <p className="font-medium text-[var(--color-warning)]">
              Already linked to another meeting
            </p>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section
      aria-label="Meeting transcripts"
      className="min-w-0 space-y-3 rounded-xl border border-[var(--glass-border)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium">Transcripts</h4>
        <button
          className={control}
          disabled={busy || pending}
          aria-expanded={reviewing}
          onClick={() => setReviewing(!reviewing)}
        >
          {reviewing ? "Hide matches" : "Review matches"}
        </button>
      </div>
      {result.isFetching ? (
        <p role="status" className="text-xs">
          Checking transcripts…
        </p>
      ) : result.isError ? (
        <p role="alert" className="text-xs">
          Couldn't check this meeting's transcripts.{" "}
          <button className="min-h-11 underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : (
        <>
          {data?.linked.map((item) => row(item))}
          {!data?.linked.length && (
            <p className="text-xs text-[var(--text-muted)]">
              No transcript linked to this meeting yet.
            </p>
          )}
          {reviewing && (
            <div className="space-y-3 border-t border-[var(--glass-border)] pt-3">
              <div>
                <h5 className="text-xs font-medium">Possible matches</h5>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Review the recording and match details before linking.
                  Suggestions are not confirmed associations.
                </p>
              </div>
              <form
                className="flex min-w-0 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!blocked && !draft) setQuery(search.trim());
                }}
              >
                <input
                  aria-label="Search transcripts"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={busy || pending || !!draft}
                  placeholder="Search recordings…"
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-xs"
                />
                <button
                  aria-label="Search transcripts"
                  className={control}
                  disabled={busy || pending || !!draft}
                >
                  <Search size={15} />
                </button>
              </form>
              {data?.candidates.map((item) => row(item, true))}
              {!data?.candidates.length && (
                <p className="text-xs text-[var(--text-muted)]">
                  No matching transcripts found. Try a different title or
                  phrase.
                </p>
              )}
              {data?.limited && (
                <p className="text-xs text-[var(--text-muted)]">
                  Showing a limited selection. Search to narrow the recordings.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {draft && (
        <form
          aria-label="Review transcript association"
          className="space-y-3 rounded-lg bg-[var(--glass)] p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h5 className="break-words text-sm font-medium">
            {draft.action === "link" ? "Link" : "Unlink"} {draft.item.title}
          </h5>
          <p className="text-xs text-[var(--text-secondary)]">
            {draft.action === "unlink"
              ? "This removes the meeting association. The recording and transcript stay in your vault."
              : "The transcript will appear with this meeting and its calendar record."}
          </p>
          {draft.elsewhere && (
            <label className="flex min-h-11 items-start gap-2 text-xs text-[var(--color-warning)]">
              <input
                type="checkbox"
                checked={draft.confirmed}
                disabled={busy || pending}
                onChange={(event) =>
                  setDraft({ ...draft, confirmed: event.target.checked })
                }
                className="mt-1"
              />
              <span>
                Move this transcript from its existing meeting to this meeting.
              </span>
            </label>
          )}
          <div>
            <label
              htmlFor={reasonId}
              className="mb-1 block text-xs font-medium"
            >
              Reason for this change
            </label>
            <textarea
              id={reasonId}
              autoFocus
              value={draft.reason}
              onChange={(event) =>
                setDraft({ ...draft, reason: event.target.value })
              }
              disabled={busy || pending}
              required
              maxLength={1000}
              rows={3}
              className="w-full min-w-0 resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] p-2 text-sm"
              placeholder="Explain why this is the correct meeting…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={control}
              disabled={
                busy ||
                (!pending &&
                  (blocked ||
                    !editableDraft ||
                    !draft.reason.trim() ||
                    (draft.elsewhere && !draft.confirmed)))
              }
            >
              {busy
                ? "Saving…"
                : pending
                  ? "Retry pending decision"
                  : draft.action === "link"
                    ? "Confirm link"
                    : "Confirm unlink"}
            </button>
            {!pending && (
              <button
                type="button"
                className={control}
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  request.current = null;
                  setError("");
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className={control}
              disabled={busy || result.isFetching}
              onClick={() => void reload()}
            >
              Reload records
            </button>
          </div>
          {!pending && !editableDraft && !result.isFetching && (
            <p className="text-xs text-[var(--text-secondary)]">
              This association is no longer available to change. Your reason has
              been preserved.
            </p>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-[var(--text-secondary)]">
          {notice}
        </p>
      )}
    </section>
  );
}

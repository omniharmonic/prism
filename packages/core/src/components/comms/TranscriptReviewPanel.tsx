import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Link2, Search, Unlink } from "lucide-react";
import { calendarDate } from "../../lib/sync/client";
import {
  clearTranscriptReceipt,
  readTranscriptReceipt,
  receiptBody,
  reserveTranscriptReceipt,
  transcriptNoteId,
  transcriptReceiptKey,
  type TranscriptReceipt,
} from "./transcriptReviewReceipt";
import type {
  TranscriptReviewClient,
  TranscriptReviewItem,
  TranscriptCandidate,
  TranscriptDecision,
  TranscriptReview,
} from "../../data/TranscriptReviewClientContext";

import { formatDate as fmtDate, formatDateTime as fmtDateTime } from "../../lib/datetime/format";
type Draft = {
  item: TranscriptReviewItem;
  action: "link" | "unlink";
  meetingUpdatedAt: string;
  reason: string;
  confirmed: boolean;
  elsewhere: boolean;
};
const control =
  "focus-ring min-h-control rounded-lg border border-[var(--glass-border)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--glass-hover)] disabled:opacity-50";
function dateLabel(start?: string) {
  if (!start) return null;
  const date = calendarDate(start);
  if (!Number.isFinite(date.getTime())) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(start)
    ? fmtDate(date, { dateStyle: "medium" })
    : fmtDateTime(date, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
type Failure = { status?: number; code?: string; retryAfter?: number };
function message(error: unknown) {
  const { status, code } = (error ?? {}) as Failure;
  if (status === 401)
    return "Sign in again to review this meeting's transcripts.";
  if (status === 403)
    return "You no longer have permission to change this association. Reload records to check your access.";
  if (status === 404)
    return "This meeting or recording is no longer available to you. Reload records to check your access.";
  if (status === 409 && code === "superseded")
    return "A newer decision replaced this one. The old retry has been cleared. Review the refreshed records before making another choice.";
  if (status === 409 && code === "vault_unavailable")
    return "This vault is unavailable or its connection changed. Reconnect to the intended vault, then reload records.";
  if (status === 409 && code === "write_actor_changed")
    return "Your signed-in account changed. Reopen this meeting in the intended account before continuing.";
  if (status === 409)
    return "These records changed in another window. Reload records to review the latest version. Your reason is still here.";
  if (status === 422 && code === "request_reused")
    return "This request identity was already used for a different decision. Reload records and review your choice before submitting a new request.";
  if (status === 429)
    return "Too many transcript requests. Wait before retrying; your decision is kept.";
  if (status === 400 || status === 415)
    return "This decision was not accepted. Reload the meeting's records and check the reason before trying again.";
  return "The association could not be confirmed. Your decision is kept; retry the same request or reload records.";
}
function restoredDraft(receipt: TranscriptReceipt): Draft {
  const body = receiptBody(receipt);
  return {
    item: {
      id: body.transcriptId,
      title: receipt.title,
      updatedAt: body.transcriptUpdatedAt,
      decisionRevision: body.expectedRevision,
      canManage: false,
    },
    action: body.action,
    meetingUpdatedAt: body.meetingUpdatedAt,
    reason: body.reason,
    confirmed: true,
    elsewhere: receipt.elsewhere,
  };
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
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && !!scope && client.scope() === scope;
  const storageKey =
    scope && transcriptNoteId(noteId)
      ? transcriptReceiptKey(scope, noteId)
      : null;
  const [initial] = useState(() =>
    storageKey
      ? readTranscriptReceipt(storageKey)
      : { receipt: null, warning: "", corrupt: false },
  );
  const queries = useQueryClient();
  const [reviewing, setReviewing] = useState(!!initial.receipt);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(() =>
    initial.receipt ? restoredDraft(initial.receipt) : null,
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [pending, setPending] = useState(!!initial.receipt);
  const [mustReload, setMustReload] = useState(false);
  const [storageWarning, setStorageWarning] = useState(initial.warning);
  const [corrupt, setCorrupt] = useState(initial.corrupt);
  const [showReceipt, setShowReceipt] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    initial.receipt
      ? "A previous decision needs confirmation. Review it below, then explicitly retry the same request. No change was sent automatically."
      : "",
  );
  const request = useRef<TranscriptReceipt | null>(initial.receipt);
  const reasonId = useId();
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const cooldown = remaining > 0;
  const rateLimit = (failure: unknown) => {
    const detail = failure as Failure;
    if (detail?.status === 429) {
      const time = Date.now();
      setNow(time);
      setRetryAt(
        time + Math.max(1, Math.min(3600, detail.retryAfter ?? 60)) * 1000,
      );
    }
  };
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt, cooldown]);
  const result = useQuery({
    queryKey: ["calendar", "transcript-review", scope, noteId, eventId, query],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: !!scope && transcriptNoteId(noteId),
    queryFn: async () => {
      if (!current()) throw Error("Workspace changed");
      const review = await client.review(noteId, query);
      if (
        !current() ||
        review.meeting.id !== noteId ||
        (eventId &&
          review.meeting.eventId &&
          review.meeting.eventId !== eventId)
      )
        throw Error("Meeting identity changed");
      return review;
    },
  });
  useEffect(() => {
    if (result.error) rateLimit(result.error);
  }, [result.error]);
  const data = result.data;
  const blocked =
    busy ||
    pending ||
    mustReload ||
    corrupt ||
    cooldown ||
    !scope ||
    result.isFetching ||
    result.isError;
  const updateDraft = (review: TranscriptReview) =>
    setDraft((old) => {
      if (!old) return null;
      const item = (
        old.action === "unlink" ? review.linked : review.candidates
      ).find((item) => item.id === old.item.id);
      return {
        ...old,
        item: item ?? { ...old.item, canManage: false },
        meetingUpdatedAt: review.meeting.updatedAt,
        confirmed: false,
        elsewhere:
          item && "linkedElsewhere" in item
            ? !!item.linkedElsewhere
            : old.elsewhere,
      };
    });
  const clearRequest = async () => {
    if (storageKey && request.current) {
      const warning = await clearTranscriptReceipt(storageKey, request.current);
      if (!current()) return;
      setStorageWarning(warning);
    }
    request.current = null;
    setPending(false);
  };
  const begin = (item: TranscriptReviewItem, action: "link" | "unlink") => {
    if (
      blocked ||
      !data?.canManage ||
      !item.canManage ||
      !transcriptNoteId(item.id)
    )
      return;
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
    if (lock.current || !current() || cooldown) return;
    const fresh = await result.refetch();
    if (!current() || !fresh.data || fresh.error) return;
    setMustReload(false);
    if (!pending) {
      setError("");
      updateDraft(fresh.data);
    }
  };
  const submit = async () => {
    if (
      lock.current ||
      !current() ||
      !draft ||
      cooldown ||
      mustReload ||
      corrupt ||
      !storageKey ||
      (pending && (!data?.canManage || result.isFetching || result.isError))
    )
      return;
    if (
      !pending &&
      (blocked ||
        !data?.canManage ||
        !draft.reason.trim() ||
        draft.reason.trim().length > 500 ||
        (draft.elsewhere && !draft.confirmed))
    )
      return;
    if (!pending) {
      const item = (
        draft.action === "unlink" ? data!.linked : data!.candidates
      ).find((item) => item.id === draft.item.id);
      if (!item?.canManage || !transcriptNoteId(item.id)) return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!request.current) {
        const body: TranscriptDecision = {
          transcriptId: draft.item.id,
          action: draft.action,
          reason: draft.reason.trim(),
          meetingUpdatedAt: draft.meetingUpdatedAt,
          transcriptUpdatedAt: draft.item.updatedAt,
          expectedRevision: draft.item.decisionRevision,
          requestId: crypto.randomUUID(),
        };
        const proposed: TranscriptReceipt = {
          version: 1,
          body: JSON.stringify(body),
          title: draft.item.title.slice(0, 500),
          elsewhere: draft.elsewhere,
        };
        const saved = await reserveTranscriptReceipt(storageKey, proposed);
        if (!current()) return;
        setStorageWarning(saved.warning);
        setCorrupt(saved.corrupt);
        if (!saved.receipt) return;
        request.current = saved.receipt;
        setPending(true);
        if (saved.receipt.body !== proposed.body) {
          setDraft(restoredDraft(saved.receipt));
          setNotice(
            "Another view already saved a decision for this meeting. Review and retry that request before starting another.",
          );
          return;
        }
      }
      const body = receiptBody(request.current);
      const receipt = await client.decide(noteId, body);
      if (!current()) return;
      if (receipt.status === "pending") {
        setPending(true);
        setNotice(
          "Your decision is saved. Prism is still updating the linked records. Retry the same decision to finish applying it before making another change.",
        );
      } else if (receipt.status === "applied") {
        await clearRequest();
        if (!current()) return;
        setDraft(null);
        setNotice(
          body.action === "link"
            ? "Transcript linked to this meeting."
            : "Association removed. The transcript is still in your vault.",
        );
        await queries.invalidateQueries({ queryKey: ["calendar"] });
      } else throw Error("Unrecognized decision result");
    } catch (cause) {
      if (!current()) return;
      setError(message(cause));
      rateLimit(cause);
      const { status, code } = (cause ?? {}) as Failure;
      if (
        (status === 409 && ["stale", "superseded"].includes(code ?? "")) ||
        status === 422 ||
        status === 400 ||
        status === 415
      ) {
        await clearRequest();
        if (!current()) return;
        setMustReload(true);
        if (code === "superseded") {
          const fresh = await result.refetch();
          if (current() && fresh.data && !fresh.error) {
            updateDraft(fresh.data);
            setMustReload(false);
          }
        }
      } else if (
        status === 401 ||
        status === 403 ||
        status === 404 ||
        (status === 409 &&
          ["vault_unavailable", "write_actor_changed"].includes(code ?? ""))
      )
        setMustReload(true);
      // Network, 503, rate limit and unknown outcomes retain the exact stored request.
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
          className="focus-ring flex min-h-control min-w-0 flex-1 items-start gap-2 rounded-lg p-2 text-left text-sm"
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
            <p className="font-medium text-[var(--text-secondary)]">
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
        <h4 className="text-sm font-semibold">Conversation records</h4>
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
          {message(result.error)}{" "}
          <button
            disabled={cooldown}
            className="focus-ring min-h-control underline disabled:opacity-50"
            onClick={() => void reload()}
          >
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
                  className="min-h-control min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-xs"
                />
                <button
                  aria-label="Search transcripts"
                  className={control}
                  disabled={blocked || !!draft}
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
            <label className="flex min-h-control items-start gap-2 text-xs text-[var(--text-secondary)]">
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
              maxLength={500}
              rows={3}
              className="w-full min-w-0 resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] p-2 text-sm"
              placeholder="Explain why this is the correct meeting…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={control + " font-medium"}
              style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
              disabled={
                busy ||
                cooldown ||
                mustReload ||
                corrupt ||
                (pending &&
                  (!data?.canManage || result.isFetching || result.isError)) ||
                (!pending &&
                  (blocked ||
                    !editableDraft ||
                    !draft.reason.trim() ||
                    draft.reason.trim().length > 500 ||
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
                  setError("");
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className={control}
              disabled={busy || result.isFetching || cooldown}
              onClick={() => void reload()}
            >
              Reload records
            </button>
          </div>
          {pending && !result.isFetching && !data?.canManage && (
            <p className="text-xs text-[var(--text-secondary)]">
              Your saved decision is kept. Permission to manage this meeting is
              required before retrying.
            </p>
          )}
          {!pending && !editableDraft && !result.isFetching && (
            <p className="text-xs text-[var(--text-secondary)]">
              This association is no longer available to change. Your reason has
              been preserved.
            </p>
          )}
        </form>
      )}
      {mustReload && !draft && (
        <button
          className={control}
          disabled={busy || result.isFetching || cooldown}
          onClick={() => void reload()}
        >
          Reload records
        </button>
      )}
      {cooldown && (
        <p role="status" className="text-xs text-[var(--text-secondary)]">
          Retry available in {remaining} seconds.
        </p>
      )}
      {storageWarning && (
        <div
          role="status"
          className="space-y-2 text-xs text-[var(--text-secondary)]"
        >
          <p>{storageWarning}</p>
          {request.current && (
            <>
              <button
                type="button"
                className={control}
                onClick={() => setShowReceipt(!showReceipt)}
              >
                Show retry details to copy
              </button>
              {showReceipt && (
                <textarea
                  aria-label="Retry details"
                  readOnly
                  value={JSON.stringify(request.current)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full min-w-0 rounded-lg border p-2 text-xs"
                  rows={5}
                />
              )}
            </>
          )}
        </div>
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

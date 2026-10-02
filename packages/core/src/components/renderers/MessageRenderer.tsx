import { messageInitials, messageColor } from "../comms/messageAppearance";
import type { CSSProperties } from "react";
import { useIsWeb } from "../../data/Platform";
import { parseLegacyThread } from "../../lib/messages/legacyThread";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { RendererProps } from "./RendererProps";
import { matrixApi } from "../../lib/matrix/client";
import { useVaultClient } from "../../data/VaultClientContext";
import {
  useLiveActions,
  useLiveActionsClient,
} from "../../data/LiveActionsContext";
import { MessageThread } from "../comms/MessageThread";
import { MessageComposer } from "../comms/MessageComposer";
import { PlatformBadge } from "../comms/PlatformBadge";

import {
  TRIAGE_TAGS,
  THREAD_STATUS_LABELS,
  threadStatus,
} from "../../lib/messages/triage";

export default function MessageRenderer({ note, readOnly }: RendererProps) {
  const actionClient = useLiveActionsClient();
  const scope = actionClient?.scope?.() || null;
  return (
    <ScopedMessageRenderer
      key={JSON.stringify([scope, note.id])}
      note={note}
      scope={scope}
      readOnly={readOnly}
    />
  );
}

function ScopedMessageRenderer({
  note,
  scope,
  readOnly,
}: Pick<RendererProps, "note" | "readOnly"> & { scope: string | null }) {
  const vault = useVaultClient();
  const meta = note.metadata as Record<string, unknown> | null;
  const roomId =
    (meta?.matrixRoomId as string) || (meta?.matrix_room_id as string) || "";
  const platform = (meta?.platform as string) || "matrix";
  const queryClient = useQueryClient();

  // Vault content is the source of truth — parse it once for instant render.
  const imported = useMemo(
    () => parseLegacyThread(note.content),
    [note.content],
  );
  const vaultMessages = imported.messages;
  const [view, setView] = useState<"saved" | "live">("saved");
  const [triageError, setTriageError] = useState<string | null>(null);
  const [triagePending, setTriagePending] = useState(false);
  const [sent, setSent] = useState(false);
  const [savedCount, setSavedCount] = useState(100);
  const canTriage = !readOnly && (!note._caps || note._caps.includes("edit"));
  const isWeb = useIsWeb();

  const currentTriage = threadStatus(note.tags);
  const [triageStatus, setTriageStatus] = useState(currentTriage);
  useEffect(() => setTriageStatus(currentTriage), [currentTriage]);

  const handleTriageChange = useCallback(
    async (newTag: (typeof TRIAGE_TAGS)[number]) => {
      if (triagePending || !canTriage) return;
      setTriagePending(true);
      setTriageError(null);
      try {
        // `triaged` is also the worker's processing marker; preserve it when
        // choosing a more specific classification.
        const oldTags: readonly string[] = TRIAGE_TAGS.filter(
          (tag) => tag !== "triaged",
        );
        // Add the new value before removing old values; a partial failure leaves
        // a visible classification to reconcile, not a silently untagged thread.
        await vault.addTags(note.id, [newTag]);
        const toRemove = (note.tags || []).filter(
          (tag) => oldTags.includes(tag) && tag !== newTag,
        );
        if (toRemove.length) await vault.removeTags(note.id, toRemove);
        setTriageStatus(newTag);
        setSent(false);
      } catch {
        setTriageError(
          "The status update was not confirmed. Refresh this thread before trying again.",
        );
      } finally {
        setTriagePending(false);
        void queryClient.invalidateQueries({ queryKey: ["vault"] });
      }
    },
    [note.id, note.tags, queryClient, triagePending, vault, canTriage],
  );

  const showLive =
    !readOnly && !!roomId && (view === "live" || vaultMessages.length === 0);
  const liveQuery = useInfiniteQuery({
    queryKey: ["matrix", "messages", scope ?? vault.scope?.(), note.id, roomId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      vault.getThreadMessages
        ? vault.getThreadMessages(note.id, pageParam)
        : matrixApi.getMessages(roomId, 50, pageParam),
    getNextPageParam: (last, pages) =>
      pages.length < 20 && last.has_more ? (last.end ?? undefined) : undefined,
    enabled: showLive && !readOnly && !!roomId,
    retry: false,
    refetchInterval: showLive ? 15_000 : false,
  });
  const liveMessages = useMemo(() => {
    const seen = new Set<string>();
    return (liveQuery.data?.pages.flatMap((page) => page.messages) ?? [])
      .filter((message) => {
        if (seen.has(message.event_id)) return false;
        seen.add(message.event_id);
        return true;
      })
      .reverse();
  }, [liveQuery.data]);

  // Web/native: send through the server (WP1.5 live actions) when it offers
  // Matrix actions; desktop (no provider) keeps its Tauri command.
  const live = useLiveActions("matrix");
  const handleSend = useCallback(
    async (body: string, requestId?: string) => {
      if (readOnly || !roomId || (isWeb && !live))
        throw new Error("Messaging is unavailable for this thread");
      if (live) {
        if (!scope || live.scope?.() !== scope)
          throw new Error(
            "Workspace changed. Reopen this thread before sending.",
          );
        await live.matrixSend(roomId, body, { idempotencyKey: requestId });
      } else await matrixApi.sendMessage(roomId, body);
      queryClient.invalidateQueries({
        queryKey: [
          "matrix",
          "messages",
          scope ?? vault.scope?.(),
          note.id,
          roomId,
        ],
      });
    },
    [roomId, queryClient, live, isWeb, scope, readOnly, vault, note.id],
  );

  // Saved legacy transcripts have no stable source event IDs: keep the two
  // views explicit rather than guessing overlap or inventing delivery status.
  const messages = showLive
    ? liveQuery.isError
      ? []
      : liveMessages
    : vaultMessages.slice(-savedCount);
  const more = showLive
    ? liveQuery.hasNextPage
    : savedCount < vaultMessages.length;

  const title =
    note.path?.split("/").pop()?.replace(/-/g, " ") || "Conversation";
  return (
    <div className="prism-conversation flex flex-col h-full min-h-0">
      <header className="prism-conversation-heading">
        <div
          aria-hidden="true"
          className="prism-message-avatar"
          style={{ "--avatar-tone": messageColor(note.id) } as CSSProperties}
        >
          {messageInitials(title)}
        </div>
        <div className="prism-conversation-title">
          <h2>{title}</h2>
          <div className="prism-conversation-meta">
            <PlatformBadge platform={platform} />
            <span>{showLive ? "Live conversation" : "Saved conversation"}</span>
            {roomId && !readOnly && (
              <button
                type="button"
                className="prism-thread-view-toggle focus-ring"
                onClick={() => setView(showLive ? "saved" : "live")}
              >
                {showLive ? "View saved history" : "View latest messages"}
              </button>
            )}
          </div>
        </div>
        <label className="shrink-0">
          <span className="sr-only">Thread status</span>
          <select
            aria-label="Thread status"
            value={triageStatus}
            disabled={triagePending || !canTriage}
            onChange={(event) =>
              void handleTriageChange(
                event.target.value as (typeof TRIAGE_TAGS)[number],
              )
            }
            className="prism-thread-status focus-ring"
          >
            <option value="unclassified" disabled>
              Needs triage
            </option>
            {TRIAGE_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {THREAD_STATUS_LABELS[tag]}
              </option>
            ))}
          </select>
        </label>
      </header>
      {triageError && (
        <p role="alert" className="px-4 py-2 text-xs">
          {triageError}
        </p>
      )}
      {showLive && liveQuery.isPending && (
        <p role="status" className="px-4 py-2 text-xs">
          Loading latest messages…
        </p>
      )}
      {showLive && liveQuery.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
        >
          <span>
            Live messages could not be refreshed. Saved history is still
            available.
          </span>
          <button
            className="focus-ring rounded px-2 py-2 underline"
            onClick={() => void liveQuery.refetch()}
          >
            Retry messages
          </button>
        </div>
      )}
      {showLive && liveQuery.data?.pages.length === 20 && (
        <p className="px-4 py-2 text-xs">
          Showing the latest 1,000 source events. Older records remain in saved
          history.
        </p>
      )}
      {!showLive && imported.preamble && (
        <details
          className="px-4 py-2 text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          <summary>Imported thread details</summary>
          <pre className="whitespace-pre-wrap break-words mt-2">
            {imported.preamble}
          </pre>
        </details>
      )}
      <MessageThread
        key={showLive ? "live" : "saved"}
        messages={messages}
        hasMore={more}
        isLoadingMore={showLive && liveQuery.isFetchingNextPage}
        onLoadMore={() => {
          if (showLive) void liveQuery.fetchNextPage();
          else setSavedCount((n) => n + 100);
        }}
      />
      {sent &&
        (triageStatus === "urgent" || triageStatus === "action-required") && (
          <div className="px-4 py-2 text-xs">
            Reply sent.{" "}
            <button
              type="button"
              disabled={triagePending}
              className="underline"
              onClick={() => void handleTriageChange("handled")}
            >
              Mark handled
            </button>
          </div>
        )}
      {(readOnly || !roomId || (isWeb && !live)) && (
        <p className="px-4 py-2 text-xs" role="status">
          Replying is unavailable for this thread on this connection.
        </p>
      )}
      <MessageComposer
        draftScope={scope}
        draftKey={`matrix:${roomId || note.id}`}
        retrySafe={!!live}
        disabled={readOnly || !roomId || (isWeb && !live)}
        onSend={async (body, options) => {
          await handleSend(body, options.requestId);
          setSent(true);
          setView("live");
        }}
      />
    </div>
  );
}

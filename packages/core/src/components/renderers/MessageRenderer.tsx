import { ConversationBack, ConversationOpenPage } from "../comms/conversationChrome";
import { AgentConversationSummary, AgentReplyDraft } from "../comms/AgentReplyDraft";
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
  statusChange,
  retryClassification,
  writeTagChange,
  type ThreadStatus,
} from "../../lib/messages/triage";
import { syncTriageCaches } from "../comms/triageCache";

import { useAgentChatStore } from "../../lib/agent/chatStore";

export default function MessageRenderer({ note, readOnly }: RendererProps) {
  const actionClient = useLiveActionsClient();
  const vaultClient = useVaultClient();
  const actorScope = useAgentChatStore(state => state.scope);
  const vaultScope = vaultClient.scope?.() || null;
  const scope = actionClient?.scope?.() || null;
  return (
    <ScopedMessageRenderer
      key={JSON.stringify([scope, actorScope, vaultScope, note.id])}
      note={note}
      scope={scope}
      readingAudience={(scope || actorScope) && vaultScope ? JSON.stringify([actorScope, scope, vaultScope]) : undefined}
      readOnly={readOnly}
    />
  );
}

function ScopedMessageRenderer({
  note,
  scope,
  readOnly,
  readingAudience,
}: Pick<RendererProps, "note" | "readOnly"> & { scope: string | null; readingAudience?: string }) {
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
  const [agentIntent, setAgentIntent] = useState<"reply" | "summary" | null>(null);
  const [view, setView] = useState<"saved" | "live">("saved");
  const [triageError, setTriageError] = useState<string | null>(null);
  const [triagePending, setTriagePending] = useState(false);
  const [sent, setSent] = useState(false);
  const [savedCount, setSavedCount] = useState(100);
  const canTriage = !readOnly && (!note._caps || note._caps.includes("edit"));
  const isWeb = useIsWeb();

  const currentTriage = threadStatus(note.tags);
  const [triageStatus, setTriageStatus] = useState<ThreadStatus>(currentTriage);
  // The tags this view last confirmed: a second change in a row diffs against them, not the prop.
  const [triageTags, setTriageTags] = useState<readonly string[]>(note.tags ?? []);
  useEffect(() => { setTriageStatus(currentTriage); setTriageTags(note.tags ?? []); }, [currentTriage, note.tags]);

  /** ONE write per change (add + remove together); the lists follow from the confirmed tags. */
  const applyTriage = useCallback(
    async (change: { add: string[]; remove: string[] }, next: ThreadStatus) => {
      if (triagePending || !canTriage) return;
      setTriagePending(true);
      setTriageError(null);
      const previous = triageStatus;
      setTriageStatus(next); // pending indicator: the control shows the choice, disabled, until confirmed
      try {
        await writeTagChange(vault, note, change);
        const tags = [...triageTags.filter((t) => !change.remove.includes(t)), ...change.add.filter((t) => !triageTags.includes(t))];
        setTriageTags(tags);
        syncTriageCaches(queryClient, note.id, tags);
        setSent(false);
      } catch {
        setTriageStatus(previous); // roll back: nothing was confirmed
        setTriageError(
          "The status update was not confirmed. Refresh this thread before trying again.",
        );
      } finally {
        setTriagePending(false);
      }
    },
    [note, queryClient, triagePending, triageStatus, triageTags, vault, canTriage],
  );
  const handleTriageChange = useCallback(
    (newTag: (typeof TRIAGE_TAGS)[number]) => applyTriage(statusChange(triageTags, newTag), newTag),
    [applyTriage, triageTags],
  );
  const retryTriage = useCallback(
    () => applyTriage(retryClassification(triageTags), "unclassified"),
    [applyTriage, triageTags],
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
        <ConversationBack />
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
            <span className="prism-conversation-state">{showLive ? "Live conversation" : "Saved conversation"}</span>
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
              {THREAD_STATUS_LABELS.unclassified}
            </option>
            {triageStatus === "triage-failed" && (
              <option value="triage-failed" disabled>
                {THREAD_STATUS_LABELS["triage-failed"]}
              </option>
            )}
            {TRIAGE_TAGS.map((tag) => (
              <option key={tag} value={tag}>
                {THREAD_STATUS_LABELS[tag]}
              </option>
            ))}
          </select>
        </label>
        <ConversationOpenPage />
      </header>
      {triageStatus === "triage-failed" && (
        <p className="prism-triage-failed-note px-4 py-2 text-xs">
          The classifier couldn’t sort this conversation and won’t try again on its own. Choose a
          status above, or{" "}
          {canTriage ? (
            <button
              type="button"
              className="underline focus-ring"
              disabled={triagePending}
              onClick={() => void retryTriage()}
            >
              send it back to be classified
            </button>
          ) : (
            "ask someone who can edit it to send it back"
          )}
          .
        </p>
      )}
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
        readingIdentity={readingAudience ? {audience:readingAudience,conversation:JSON.stringify([note.id,platform,roomId,showLive ? "live" : "saved"])} : undefined}
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
      <div className="flex flex-wrap items-center gap-2">
        <AgentConversationSummary
          noteId={note.id}
          title={title}
          active={agentIntent === "summary"}
          onActivate={() => setAgentIntent("summary")}
        />
        <AgentReplyDraft active={agentIntent === "reply"} onActivate={() => setAgentIntent("reply")} scope={scope} noteId={note.id} title={title} draftKey={`matrix:${roomId || note.id}`} destination={JSON.stringify({ platform, roomId })} disabled={readOnly || !roomId || (isWeb && !live)} />
      </div>
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

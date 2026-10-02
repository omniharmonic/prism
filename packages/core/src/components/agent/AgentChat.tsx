import "./agent-chat.css";
import { AgentFollowupQueue, followupKey } from "./AgentFollowupQueue";
import { AgentSnapshotAttachments, AgentSnapshotPreview } from "./AgentSnapshotAttachments";
import { validContextSnapshots, type AgentContextSnapshot } from "../../lib/agent/contextSnapshots";
/**
 * Agent chat (Arch v2 WP3.2) — durable server-side agent sessions over the
 * AgentClient seam. Rendered as the "agent-chat" virtual tab (Registry + Canvas
 * VIRTUAL_TAB_IDS + Navigation) and, compact, inside the context panel.
 *
 * Wide: session list | conversation. Mobile: the list in the canvas, and a
 * full-screen conversation over the command pill with the composer pinned above
 * the keyboard (visualViewport) and safe-area insets; inputs are 16px (no iOS zoom).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bot,
  Check,
  FileText,
  Loader2,
  Lock,
  Maximize2,
  PenLine,
  Plus,
  Send,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { useAgentClient, useAgentAvailability, useAgentLimits, useAgentLimitsQuery, agentKeys } from "../../data/AgentClientContext";
import { AgentBudgetLine } from "./AgentBudget";
import { formatAgentCost, PROFILE_LABELS, isReadOnlyProfile } from "../../lib/agent/cost";
import { useAgentChatStore, openAgentChat, isAskableNoteId, type PendingAsk, type AgentDraftContext } from "../../lib/agent/chatStore";
import { useComposerDraft } from "../../lib/agent/useComposerDraft";
import { requestReceipt, clearRequestReceipt } from "../../lib/agent/requestReceipt";
import { AgentApiError } from "../../lib/agent/sessions";
import { useAgentConversation, agentErrorText } from "../../lib/agent/useAgentConversation";
import { turnProblem, type TurnView } from "../../lib/agent/sessionReducer";
import type { AgentClient, AgentProfile, AgentPermissionMode, AgentSessionSummary } from "../../lib/agent/sessions";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useUIStore } from "../../app/stores/ui";
import { useNote } from "../../app/hooks/useParachute";
import { Spinner } from "../ui/Spinner";
import { PrismMark } from "../brand/PrismMark";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentSourcePreview } from "./AgentSourcePreview";
import { AgentContextAttachments } from "./AgentContextAttachments";
import type { RendererProps } from "../renderers/RendererProps";

// ── helpers ──────────────────────────────────────────────────────────────────

function relTime(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDuration(ms: number | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const isRunning = (s: string | null | undefined) => s === "queued" || s === "running";

/** Height of the visual viewport (shrinks when the iOS keyboard is up). */
function useVisualViewportHeight(active: boolean): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return;
    const on = () => setH(vv.height);
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, [active]);
  return h;
}

// ── renderer ─────────────────────────────────────────────────────────────────

export default function AgentChat(_props: RendererProps) {
  const client = useAgentClient();
  const availability = useAgentAvailability();
  if (!client || availability === "none") {
    return <Unavailable text="Agent chat runs on the Prism Server. It isn't available in this app yet." />;
  }
  if (availability === "checking") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }
  if (availability === "error") return <Unavailable text="Can't reach the Prism server right now." />;
  if (availability === "no") return <Unavailable text="Agent chat is available to the server owner only." />;
  return <AgentChatView key={client.scope?.() ?? ""} client={client} />;
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" data-testid="agent-unavailable">
      <Bot size={28} style={{ color: "var(--text-muted)" }} />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {text}
      </p>
    </div>
  );
}

/** A new (not yet created) session: it is created on the first send. */
type Draft = AgentDraftContext;

function AgentChatView({ client }: { client: AgentClient }) {
  const isMobile = useIsMobile();
  const activeSessionId = useAgentChatStore((s) => s.activeSessionId);
  const setActiveSession = useAgentChatStore((s) => s.setActiveSession);
  const pendingAsk = useAgentChatStore((s) => s.pendingAsk);
  const setPendingAsk = useAgentChatStore((s) => s.setPendingAsk);
  const draft = useAgentChatStore((s) => s.draft);
  const setDraft = useAgentChatStore((s) => s.setDraft);
  const [autoPrompt, setAutoPrompt] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const keys = agentKeys(client);

  const { data: sessions, isLoading, isError: listError, refetch: reloadSessions } = useQuery({
    queryKey: keys.list(false),
    queryFn: () => client.listSessions({ limit: 50 }),
    refetchInterval: (q) => ((q.state.data as AgentSessionSummary[] | undefined)?.some((s) => isRunning(s.lastTurnStatus)) ? 5_000 : 60_000),
  });

  // A stale remembered id (archived elsewhere) falls back to the list.
  useEffect(() => {
    if (activeSessionId && sessions && !sessions.some((s) => s.id === activeSessionId)) {
      // It may be brand new (list not refetched yet) — only drop it if the list is fresh.
      const scope = client.scope?.();
      void client.getSession(activeSessionId).catch((error) => {
        if (error instanceof AgentApiError && error.status === 404 && scope === client.scope?.() && useAgentChatStore.getState().activeSessionId === activeSessionId) setActiveSession(null);
      });
    }
  }, [activeSessionId, sessions, client, setActiveSession]);

  // Consume a pending ask (command bar / "Ask about this note").
  useEffect(() => {
    if (!pendingAsk) return;
    // "Ask about this note" continues an existing session — wait for the list.
    if (pendingAsk.noteId && !pendingAsk.prompt && !sessions) return;
    const ask: PendingAsk = pendingAsk;
    setPendingAsk(null);
    if (ask.prompt) {
      setActiveSession(null);
      setDraft({ noteId: ask.noteId, noteTitle: ask.noteTitle });
      setAutoPrompt(ask.prompt);
      return;
    }
    if (ask.noteId) {
      // Continue the latest session about this note, else start one.
      const existing = sessions?.find((s) => s.note_id === ask.noteId);
      if (existing) {
        setDraft(null);
        setActiveSession(existing.id);
      } else {
        setActiveSession(null);
        setDraft({ noteId: ask.noteId, noteTitle: ask.noteTitle });
      }
      return;
    }
    setActiveSession(null);
    setDraft({});
  }, [pendingAsk, sessions, setPendingAsk, setActiveSession, setDraft]);

  const startNew = () => {
    setActiveSession(null);
    setDraft({});
  };
  const openSession = (id: string) => {
    setDraft(null);
    setActiveSession(id);
  };
  const archive = async (id: string) => {
    if (!window.confirm("Archive this session? Its transcript note stays in the vault.")) return;
    try {
      await client.archiveSession(id);
    } catch (e) {
      window.alert(agentErrorText(e));
    }
    if (id === activeSessionId) setActiveSession(null);
    void queryClient.invalidateQueries({ queryKey: keys.all });
  };

  const showingConversation = !!activeSessionId || !!draft;
  const conversation = showingConversation ? (
    <Conversation
      key={activeSessionId ?? `draft:${draft?.noteId ?? "new"}`}
      client={client}
      sessionId={activeSessionId}
      draft={draft}
      autoPrompt={autoPrompt}
      onAutoPromptConsumed={() => setAutoPrompt(null)}
      onCreated={(id) => {
        setDraft(null);
        setActiveSession(id);
      }}
      onBack={
        isMobile
          ? () => {
              setDraft(null);
              setActiveSession(null);
            }
          : undefined
      }
      onArchive={activeSessionId ? () => void archive(activeSessionId) : undefined}
      fullScreen={isMobile}
    />
  ) : null;

  const list = (
    <SessionList
      sessions={sessions ?? []}
      loading={isLoading}
      error={listError}
      onRetry={() => void reloadSessions()}
      activeId={activeSessionId}
      onOpen={openSession}
      onNew={startNew}
      onArchive={(id) => void archive(id)}
      mobile={isMobile}
    />
  );

  if (isMobile) {
    return (
      <div className="h-full" data-testid="agent-chat">
        {list}
        {conversation}
      </div>
    );
  }
  return (
    <div className="prism-agent-workspace flex h-full" data-testid="agent-chat">
      <div className="prism-agent-rail h-full flex-shrink-0 overflow-hidden">
        {list}
      </div>
      <div className="h-full min-w-0 flex-1">
        {conversation ?? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <PrismMark width={58} height={40} decorative style={{ color: "var(--text-primary)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Chat with the agent on your Prism server. Conversations keep running when you close the tab.
            </p>
            <button onClick={startNew} className="press flex items-center gap-1.5 rounded-full px-4 py-2 text-sm" style={{ background: "var(--color-accent)", color: "#fff" }}>
              <Plus size={15} /> New session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── session list ─────────────────────────────────────────────────────────────

function SessionList({ sessions, loading, error, onRetry, activeId, onOpen, onNew, onArchive, mobile }: {
  sessions: AgentSessionSummary[]; loading: boolean; error: boolean; onRetry: () => void;
  activeId: string | null; onOpen: (id: string) => void; onNew: () => void;
  onArchive: (id: string) => void; mobile: boolean;
}) {
  const billing = useAgentLimits()?.billing;
  const [filter, setFilter] = useState("");
  const shown = sessions.filter(session => (session.title || "Untitled session").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = [
    { title: "Today", rows: shown.filter(session => (session.lastTurnAt ?? session.updated_at) >= today.getTime()) },
    { title: "Yesterday", rows: shown.filter(session => (session.lastTurnAt ?? session.updated_at) < today.getTime() && (session.lastTurnAt ?? session.updated_at) >= yesterday.getTime()) },
    { title: "Earlier", rows: shown.filter(session => (session.lastTurnAt ?? session.updated_at) < yesterday.getTime()) },
  ];
  return <div className="prism-agent-sessions flex h-full min-h-0 flex-col">
    <header className="prism-agent-list-heading">
      <h2>Agent</h2>
      <button onClick={onNew} data-testid="agent-new-session" className="prism-agent-new focus-ring"><Plus size={16} /> New conversation</button>
      <input aria-label="Filter recent conversations" placeholder="Filter recent conversations…" value={filter} onChange={event => setFilter(event.target.value)} className="prism-agent-session-filter focus-ring" />
      <p>Recent conversations{sessions.length >= 50 ? " · latest 50" : ""}</p>
    </header>
    <div className="prism-agent-session-scroll min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: mobile ? 110 : 16 }}>
      {loading && <div role="status" className="flex justify-center gap-2 p-5 text-sm"><Spinner size={18} /> Loading conversations…</div>}
      {error && <div role="alert" className="prism-agent-list-feedback">Couldn’t refresh conversations. <button onClick={onRetry} className="focus-ring underline">Try again</button></div>}
      {!loading && !error && sessions.length === 0 && <p className="prism-agent-list-feedback">Start a conversation about a page or explore your vault.</p>}
      {!loading && sessions.length > 0 && shown.length === 0 && <p className="prism-agent-list-feedback">No recent conversations match this filter.</p>}
      {groups.filter(group => group.rows.length > 0).map(group => <section key={group.title} aria-label={group.title}>
        <h3 className="prism-agent-list-group">{group.title}</h3>
        {group.rows.map(session => {
          const active = session.id === activeId;
          const running = isRunning(session.lastTurnStatus);
          const status = session.lastTurnStatus === "queued" ? "Queued" : session.lastTurnStatus === "running" ? "Working…" : session.lastTurnStatus === "error" ? "Failed" : session.lastTurnStatus === "interrupted" ? "Interrupted" : session.lastTurnStatus === "cancelled" ? "Stopped" : session.lastTurnStatus === "done" ? "Completed" : "No messages yet";
          return <div key={session.id} className="prism-agent-session-row group" data-active={active || undefined}>
            <button data-testid="agent-session-row" onClick={() => onOpen(session.id)} aria-current={active ? "true" : undefined} className="prism-agent-session-open focus-ring">
              {session.note_id ? <FileText size={18} className="shrink-0" /> : <Bot size={18} className="shrink-0" />}
              <span className="min-w-0 flex-1"><span className="prism-agent-session-title">{session.title || "Untitled session"}</span>
                <span className="prism-agent-session-meta"><span className={running ? "prism-agent-session-running" : undefined}>{status}</span><span aria-hidden="true">·</span><span>{relTime(session.lastTurnAt ?? session.updated_at)}</span></span>
                {(isReadOnlyProfile(session.profile) || session.cost_usd > 0) && <span className="prism-agent-session-meta">{isReadOnlyProfile(session.profile) && <span className="inline-flex items-center gap-1"><Lock size={10} /> Read-only</span>}{session.cost_usd > 0 && <span title={formatAgentCost(session.cost_usd, billing)?.title} data-testid="agent-session-cost">{formatAgentCost(session.cost_usd, billing)?.text}</span>}</span>}
              </span>
            </button>
            <button onClick={() => onArchive(session.id)} aria-label="Archive session" title="Archive" className={`prism-agent-session-archive focus-ring ${mobile ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}><Archive size={14} /></button>
          </div>;
        })}
      </section>)}
    </div>
  </div>;
}

// ── conversation ─────────────────────────────────────────────────────────────

export function Conversation({
  client,
  sessionId,
  draft,
  autoPrompt,
  onAutoPromptConsumed,
  onCreated,
  onBack,
  onArchive,
  onExpand,
  fullScreen,
  compact,
}: {
  client: AgentClient;
  sessionId: string | null;
  draft?: Draft | null;
  autoPrompt?: string | null;
  onAutoPromptConsumed?: () => void;
  onCreated: (sessionId: string) => void;
  onBack?: () => void;
  onArchive?: () => void;
  onExpand?: () => void;
  fullScreen?: boolean;
  compact?: boolean;
}) {
  const conv = useAgentConversation(client, sessionId);
  const mobileComposer = useIsMobile();
  const queryClient = useQueryClient();
  const limitsQuery = useAgentLimitsQuery();
  const limits = limitsQuery.data;
  const limitsUnavailable = !!client.getLimits && !limits && !(limitsQuery.error instanceof AgentApiError && limitsQuery.error.status === 404);
  // The profiles the server offers (prism-* only when enabled); older servers: the two vault profiles.
  const pickable: AgentProfile[] = limits?.profiles?.length ? limits.profiles : ["vault-ro", "vault-rw"];
  const composerDraft = useComposerDraft(client.scope?.() || null, sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`);
  const { text: input, setText: setInput, clearIfUnchanged } = composerDraft;
  const contextDraft = useComposerDraft(client.scope?.() || null, `context:${sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`}`);
  const contextNoteIds: string[] = useMemo(() => {
    try { const ids: unknown = JSON.parse(contextDraft.text || "[]"); return Array.isArray(ids) && ids.length <= 5 && ids.every((id) => typeof id === "string") ? ids : []; } catch { return []; }
  }, [contextDraft.text]);
  const snapshotDraft = useComposerDraft(client.scope?.() || null, `snapshots:${sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`}`);
  const contextSnapshots = useMemo(() => {
    try { const parsed: unknown = JSON.parse(snapshotDraft.text || "[]"); return validContextSnapshots(parsed) ? parsed : []; } catch { return []; }
  }, [snapshotDraft.text]);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const pendingFollowup = useComposerDraft(client.scope?.() || null, `pending-followup:${sessionId ?? "new"}`);
  const pendingQueuedRequest = useMemo(() => {
    try {
      const value = JSON.parse(pendingFollowup.text || "null");
      return value && typeof value.prompt === "string" && typeof value.requestId === "string" ? value as Parameters<NonNullable<AgentClient["queueFollowup"]>>[1] : null;
    } catch { return null; }
  }, [pendingFollowup.text]);
  const [readingFile, setReadingFile] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const draftPermissions = useComposerDraft(client.scope?.() || null, `permissions:note:${draft?.noteId ?? "new"}`);
  const profile: AgentProfile = ["vault-ro", "vault-rw", "prism-ro", "prism-rw", "prism-suggest"].includes(draftPermissions.text) ? draftPermissions.text as AgentProfile : "vault-ro";
  const draftMode: AgentPermissionMode = ["read-only", "suggest", "read-write"].includes(draftPermissions.text) ? draftPermissions.text as AgentPermissionMode : "read-only";
  const [changingMode, setChangingMode] = useState(false);
  const permissionModes = limits?.permissionModes;
  const idempotentRequests = limits?.idempotentRequests === true;
  const modeLabels: Record<AgentPermissionMode, string> = { "read-only": "Read-only", suggest: "Suggested edits only", "read-write": "Read/write" };
  const permissionPending = conv.session?.pending_mode;
  useEffect(() => {
    if (!permissionPending) return;
    const timer = window.setInterval(() => { void conv.reload(); }, 1000);
    return () => window.clearInterval(timer);
  }, [permissionPending, conv.reload]);
  const changeMode = async (mode: AgentPermissionMode) => {
    if (!sessionId) { draftPermissions.setText(mode); return; }
    if (!client.updatePermissions || !conv.session?.policy_version || changingMode) return;
    setChangingMode(true);
    try {
      await client.updatePermissions(sessionId, mode, conv.session.policy_version);
      conv.setError(null);
      await conv.reload();
      void queryClient.invalidateQueries({ queryKey: agentKeys(client).all });
    } catch (error) { await conv.reload(); conv.setError(agentErrorText(error)); }
    finally { setChangingMode(false); }
  };
  const [creating, setCreating] = useState<string | null>(null); // prompt being sent in a draft
  const [draftError, setDraftError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const vvh = useVisualViewportHeight(!!fullScreen);

  const isDraft = !sessionId;
  const awaitingSession = !isDraft && (conv.loading || conv.session?.id !== sessionId);
  const running = !!conv.active;
  const canQueue = !!sessionId && !!limits?.followups && !!client.queueFollowup && !!client.listFollowups && !!client.changeFollowup;
  // A turn just finished → today's spend changed: refresh the budget line.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void queryClient.invalidateQueries({ queryKey: agentKeys(client).limits });
    wasRunning.current = running;
  }, [running, queryClient, client]);
  const error = isDraft ? draftError : conv.error;

  // Keep the view pinned to the newest text while the user is at the bottom.
  const lastTurn = conv.state.turns[conv.state.turns.length - 1];
  const tailSig = lastTurn ? `${conv.state.turns.length}:${lastTurn.blocks.map((b) => b.text.length).join(",")}:${lastTurn.tools.length}:${lastTurn.status}` : "";
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tailSig, creating]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Autosize the composer.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const submit = useCallback(
    async (textArg?: string) => {
      const text = (textArg ?? input).trim();
      if ((!text && !pendingQueuedRequest) || readingFile || (running && !canQueue) || creating || sendingRef.current || permissionPending || changingMode || awaitingSession || limitsUnavailable) return;
      if ((pendingQueuedRequest && !canQueue) || (pendingFollowup.text && !pendingQueuedRequest)) {
        conv.setError("The pending queued message needs confirmation before another instruction can be sent. Reconnect to the queue-enabled server or inspect the queue in a new session.");
        return;
      }
      if (contextSnapshots.length && !limits?.contextSnapshots) {
        const message = "This server can't accept captured snapshots. Remove them or reconnect to the updated server.";
        if (isDraft) setDraftError(message); else conv.setError(message);
        return;
      }
      if (contextNoteIds.length && !limits?.contextNotes) {
        const message = "This server can't accept the attached notes. Remove them before sending, or reconnect to the updated server.";
        if (isDraft) setDraftError(message); else conv.setError(message);
        return;
      }
      const sentDraft = textArg ?? input;
      if (textArg !== undefined) setInput(textArg);
      sendingRef.current = true;
      setSending(true);
      stickToBottom.current = true;
      const scope = client.scope?.();
      const conversation = sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`;
      let requestId: string | undefined;
      if (idempotentRequests && !((running || pendingQueuedRequest) && canQueue)) {
        try {
          if (!scope) throw new Error("Wait for your workspace identity before sending.");
          const receipt = await requestReceipt(scope, conversation, { text, noteId: isDraft ? draft?.noteId : conv.session?.note_id, ...(isDraft ? { mode: permissionModes?.length ? draftMode : profile } : {}), ...(contextNoteIds.length ? { contextNoteIds } : {}), ...(contextSnapshots.length ? { contextSnapshots } : {}) });
          if (scope !== client.scope?.()) throw new Error("Workspace changed. Reopen the draft in its original workspace.");
          requestId = receipt.id;
        } catch (error) {
          if (isDraft) setDraftError(agentErrorText(error)); else conv.setError(agentErrorText(error));
          sendingRef.current = false;
          setSending(false);
          return;
        }
      }
      if ((running || pendingQueuedRequest) && canQueue && sessionId) {
        try {
          if (!scope) throw Error("Wait for your workspace identity before queueing.");
          const payload = pendingQueuedRequest ?? { policyVersion: conv.session!.policy_version!, prompt: text, ...(conv.session?.note_id ? {noteId:conv.session.note_id} : {}), ...(contextNoteIds.length ? {contextNoteIds} : {}), ...(contextSnapshots.length ? {contextSnapshots} : {}) };
          const receipt = pendingQueuedRequest ? { id: pendingQueuedRequest.requestId } : await requestReceipt(scope, `followups:${sessionId}`, payload);
          const queuedRequest = {...payload,requestId:receipt.id};
          const serialized = JSON.stringify(queuedRequest);
          if (!pendingFollowup.setText(serialized)) throw Error("Prism could not save the queue receipt. Copy your draft and free some browser storage before queueing.");
          if (client.scope?.() !== scope) throw Error("Workspace changed");
          await client.queueFollowup!(sessionId, queuedRequest);
          if (client.scope?.() !== scope) return;
          clearRequestReceipt(scope, `followups:${sessionId}`,receipt.id);
          pendingFollowup.clearIfUnchanged(serialized);
          clearIfUnchanged(pendingQueuedRequest ? pendingQueuedRequest.prompt : sentDraft);
          contextDraft.clearIfUnchanged(payload.contextNoteIds?.length ? JSON.stringify(payload.contextNoteIds) : "");
          snapshotDraft.clearIfUnchanged(payload.contextSnapshots?.length ? JSON.stringify(payload.contextSnapshots) : "");
          conv.setError(null);
          await queryClient.invalidateQueries({queryKey:followupKey(client,sessionId)});
          await conv.reload();
        } catch(e) {conv.setError(agentErrorText(e));}
        finally {sendingRef.current=false;setSending(false);}
        return;
      }
      if (isDraft) {
        setDraftError(null);
        setCreating(text);
        try {
          const title = text.replace(/\s+/g, " ").slice(0, 80);
          const { sessionId: id } = await client.createSession({ title, ...(permissionModes?.length ? { permissionMode: draftMode } : { profile }), noteId: draft?.noteId, ...(requestId ? { requestId } : {}) });
          await client.sendTurn(id, text, { ...(draft?.noteId ? { noteId: draft.noteId } : {}), ...(requestId ? { requestId } : {}), ...(contextNoteIds.length ? { contextNoteIds } : {}), ...(contextSnapshots.length ? { contextSnapshots } : {}) });
          void queryClient.invalidateQueries({ queryKey: agentKeys(client).all });
          clearIfUnchanged(sentDraft);
          contextDraft.clearIfUnchanged(contextDraft.text);
          snapshotDraft.clearIfUnchanged(snapshotDraft.text);
          draftPermissions.clearIfUnchanged(draftPermissions.text);
          if (scope && requestId) clearRequestReceipt(scope, conversation, requestId);
          onCreated(id);
        } catch (e) {
          setDraftError(agentErrorText(e));
          setCreating(null);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
        return;
      }
      const noteId = conv.session?.note_id ?? undefined;
      const ok = await conv.send(text, { ...(noteId ? { noteId } : {}), ...(requestId ? { requestId } : {}), ...(contextNoteIds.length ? { contextNoteIds } : {}), ...(contextSnapshots.length ? { contextSnapshots } : {}) });
      if (ok) {
        clearIfUnchanged(sentDraft);
        contextDraft.clearIfUnchanged(contextDraft.text);
          snapshotDraft.clearIfUnchanged(snapshotDraft.text);
        if (scope && requestId) clearRequestReceipt(scope, conversation, requestId);
      }
      sendingRef.current = false;
      setSending(false);
    },
    [input, running, creating, isDraft, client, profile, draft, queryClient, onCreated, conv, setInput, clearIfUnchanged, permissionPending, changingMode, permissionModes, draftMode, idempotentRequests, sessionId, awaitingSession, limitsUnavailable, draftPermissions, contextDraft, contextNoteIds, limits?.contextNotes, contextSnapshots, snapshotDraft, limits?.contextSnapshots, readingFile, canQueue, pendingFollowup, pendingQueuedRequest],
  );

  // Command bar "Ask Claude: …" → send immediately in a fresh draft (once, even
  // under StrictMode's double effect run).
  const autoSent = useRef<string | null>(null);
  useEffect(() => {
    if (isDraft && !limitsUnavailable && autoPrompt && autoSent.current !== autoPrompt) {
      autoSent.current = autoPrompt;
      onAutoPromptConsumed?.();
      void submit(autoPrompt);
    }
  }, [autoPrompt, isDraft, limitsUnavailable]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the composer for a fresh draft (not on touch — avoids popping the keyboard unasked).
  useEffect(() => {
    if (isDraft && !fullScreen && !mobileComposer) requestAnimationFrame(() => inputRef.current?.focus());
  }, [isDraft, fullScreen, mobileComposer]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && (!mobileComposer || e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const title = isDraft ? (draft?.noteTitle ? `About ${draft.noteTitle}` : "New session") : conv.session?.title || "Untitled session";
  const noteId = isDraft ? draft?.noteId : (conv.session?.note_id ?? undefined);

  const permissionControls = <>
      {isDraft && !permissionModes?.length && (
        <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <div className="flex flex-wrap rounded-full p-0.5" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }} role="radiogroup" aria-label="Agent permissions">
            {pickable.map((p) => [p, PROFILE_LABELS[p].label, isReadOnlyProfile(p) ? <Lock key="l" size={11} /> : <PenLine key="p" size={11} />] as [AgentProfile, string, ReactNode]).map(([p, label, icon]) => (
              <button
                key={p}
                role="radio"
                aria-checked={profile === p}
                data-testid={`agent-profile-${p}`}
                onClick={() => draftPermissions.setText(p)}
                className="flex items-center gap-1 rounded-full px-2.5 py-1"
                style={{
                  background: profile === p ? "var(--color-accent)" : "transparent",
                  color: profile === p ? "#fff" : "var(--text-secondary)",
                }}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <span className="truncate">{PROFILE_LABELS[profile].hint}</span>
        </div>
      )}
      {!!permissionModes?.length && (isDraft || !!client.updatePermissions) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
            Agent permissions
            <select
              aria-label="Agent permissions"
              value={isDraft ? draftMode : conv.session?.permission_mode ?? (isReadOnlyProfile(conv.session?.profile) ? "read-only" : conv.session?.profile === "prism-suggest" ? "suggest" : "read-write")}
              disabled={changingMode || !!permissionPending || (!isDraft && !conv.session)}
              onChange={(event) => { void changeMode(event.target.value as AgentPermissionMode); }}
              className="rounded-lg border px-2 py-2"
              style={{ background: "var(--bg-surface)", borderColor: "var(--glass-border)", color: "var(--text-primary)", minHeight: 36 }}
            >
              {permissionModes.map((mode) => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}
            </select>
          </label>
          {permissionPending && <span role="status">Stopping previous work before switching to {modeLabels[permissionPending]}…</span>}
        </div>
      )}
  </>;

  const header = (
    <div
      className="prism-agent-heading flex-shrink-0"
      style={{
        minHeight: compact ? 40 : 52,
        paddingTop: fullScreen ? "env(safe-area-inset-top)" : undefined,
        borderBottom: "1px solid var(--glass-border)",
      }}
    >
      <div className="prism-agent-heading-top">
      {onBack && (
        <button onClick={onBack} aria-label="Back to sessions" className="interactive flex items-center justify-center rounded-full" style={{ width: 36, height: 36, color: "var(--text-secondary)" }}>
          <ArrowLeft size={19} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="prism-agent-conversation-title" style={{ color: "var(--text-primary)" }} data-testid="agent-conversation-title">
          {title}
        </div>
        {!compact && !isDraft && <AgentBudgetLine sessionCostUsd={conv.session?.cost_usd} />}
      </div>
      {onExpand && (
        <button onClick={onExpand} aria-label="Open in Agent tab" title="Open in Agent tab" className="interactive flex items-center justify-center rounded" style={{ width: 28, height: 28, color: "var(--text-muted)" }}>
          <Maximize2 size={13} />
        </button>
      )}
      {onArchive && !compact && (
        <button onClick={onArchive} aria-label="Archive session" title="Archive" className="interactive flex items-center justify-center rounded" style={{ width: 32, height: 32, color: "var(--text-muted)" }}>
          <Archive size={15} />
        </button>
      )}
      </div>
      {noteId && <div className="prism-agent-working-document" data-testid="agent-working-document"><span>Working on</span><NoteChip noteId={noteId} label={isDraft ? draft?.noteTitle : undefined} /></div>}
      <div className="prism-agent-permissions">{permissionControls}</div>
      {conv.conn === "reconnecting" && <p role="status" className="prism-agent-connection">Reconnecting… Your conversation and draft are kept here.</p>}
    </div>
  );

  const empty = isDraft && !creating && (
    <div className="flex flex-col items-center gap-3 px-4 pt-10 text-center">
      <PrismMark width={58} height={40} decorative style={{ color: "var(--text-primary)" }} />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {draft?.noteId ? "Ask anything about this note." : "Ask the agent about your vault."}
        <br />
        It keeps working if you close the app.
      </p>
    </div>
  );

  const composer = (
    <div
      className="prism-agent-composer flex-shrink-0"
      style={{
        borderTop: "1px solid var(--glass-border)",
        paddingBottom: fullScreen ? "calc(env(safe-area-inset-bottom) + 8px)" : 8,
        background: fullScreen ? "var(--bg-surface)" : undefined,
      }}
    >
      {canQueue && sessionId && <AgentFollowupQueue client={client} sessionId={sessionId} mode={conv.session?.permission_mode ?? "read-only"} policyVersion={conv.session?.policy_version ?? 0} onAdmitted={conv.reload}/> }
      {isDraft && <AgentBudgetLine />}
      {pendingQueuedRequest && <p role="status" className="mb-2 text-xs">A queued message is awaiting confirmation. Check it before sending another instruction.</p>}
      {pendingFollowup.error && <p role="status" className="mb-2 text-xs">{pendingFollowup.error}</p>}
      {(limits?.contextSnapshots || contextSnapshots.length > 0) && <AgentSnapshotAttachments noteId={isDraft ? draft?.noteId : conv.session?.note_id} snapshots={contextSnapshots} available={!!limits?.contextSnapshots} onReading={setReadingFile} disabled={sending} onChange={next=>snapshotDraft.setText(next.length ? JSON.stringify(next) : "")} />}
      {snapshotDraft.error && <p role="status" className="mb-2 text-xs">{snapshotDraft.error}</p>}
      {(limits?.contextNotes || contextNoteIds.length > 0) && <AgentContextAttachments ids={contextNoteIds} onChange={(ids) => contextDraft.setText(ids.length ? JSON.stringify(ids) : "")} onPreview={setAttachmentPreview} disabled={sending} maxNotes={limits?.contextNotes?.maxNotes ?? 0} maxCharacters={limits?.contextNotes?.maxCharactersPerNote ?? 8000} />}
      {attachmentPreview && <AgentSourcePreview noteId={attachmentPreview} onClose={() => setAttachmentPreview(null)} />}
      {contextDraft.error && <p role="status" className="mb-2 text-xs">{contextDraft.error}</p>}
      {limitsUnavailable && <p role="status" className="mb-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        {limitsQuery.isError ? <>Couldn't check agent settings. <button className="underline" onClick={() => void limitsQuery.refetch()}>Try again</button></> : "Checking agent settings…"}
      </p>}
      {isDraft && draftPermissions.error && <p role="status" className="mb-2 text-xs">{draftPermissions.error}</p>}
      {composerDraft.error && <p role="status" className="mb-2 text-xs" style={{ color: "var(--text-secondary)" }}>{composerDraft.error}</p>}
      <div className="prism-agent-compose-surface flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={input}
          aria-label="Message the agent"
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          enterKeyHint={mobileComposer ? "enter" : undefined}
          placeholder={running ? (canQueue ? "Add a follow-up…" : "The agent is working…") : isDraft ? "Ask the agent…" : "Reply…"}
          data-testid="agent-input"
          className="prism-agent-input min-w-0 flex-1 resize-none outline-none"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            fontSize: 16, // no iOS zoom-on-focus
            lineHeight: 1.4,
            minHeight: 40,
            maxHeight: 160,
          }}
        />
        {running && canQueue && <button onClick={()=>void submit()} disabled={(!input.trim() && !pendingQueuedRequest) || sending || readingFile || changingMode || !!permissionPending || awaitingSession || limitsUnavailable} className="focus-ring min-h-10 shrink-0 rounded-full border border-[var(--glass-border)] px-3 text-xs disabled:opacity-40" aria-label={pendingQueuedRequest ? "Check queued message" : "Queue follow-up"}>{pendingQueuedRequest ? "Check" : "Queue"}</button>}
        {running ? (
          <button
            onClick={() => void conv.cancel()}
            aria-label="Stop"
            title="Stop"
            data-testid="agent-cancel"
            className="press flex flex-shrink-0 items-center justify-center rounded-full"
            style={{ width: 44, height: 44, borderRadius: 9, background: "var(--color-danger)", color: "#fff" }}
          >
            <Square size={14} fill="#fff" />
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={(!input.trim() && !pendingQueuedRequest) || sending || readingFile || changingMode || !!permissionPending || awaitingSession || limitsUnavailable}
            aria-label={pendingQueuedRequest ? "Check queued message" : "Send"}
            data-testid="agent-send"
            className="press flex flex-shrink-0 items-center justify-center rounded-full disabled:opacity-40"
            style={{ width: 44, height: 44, borderRadius: 9, background: "var(--action-bg)", color: "var(--action-fg)" }}
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        )}
      </div>
    </div>
  );

  const body = (
    <div ref={scrollRef} onScroll={onScroll} className="prism-agent-transcript min-h-0 flex-1 overflow-y-auto" data-testid="agent-messages">
      {empty}
      {conv.loading && conv.state.turns.length === 0 && !isDraft && (
        <div className="flex justify-center py-8">
          <Spinner size={18} />
        </div>
      )}
      <div className="prism-agent-turns mx-auto flex flex-col">
        {conv.state.turns.map((t) => (
          <TurnBlock key={t.id} turn={t} compact={compact} />
        ))}
        {creating && (
          <>
            <UserBubble text={creating} />
            <Thinking label="Starting session…" />
          </>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mx-auto mt-3 flex max-w-3xl items-start gap-2 rounded-lg px-3 py-2 text-sm"
          style={{ background: "color-mix(in srgb, var(--color-danger) 10%, transparent)", color: "var(--color-danger)" }}
        >
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => (isDraft ? setDraftError(null) : conv.setError(null))} aria-label="Dismiss" className="flex-shrink-0">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div
        className="prism-agent-conversation fixed left-0 right-0 top-0 flex flex-col"
        style={{ height: vvh ?? "100dvh", zIndex: "var(--z-overlay)" as unknown as number, background: "var(--bg-base, var(--bg-surface))" }}
        data-testid="agent-conversation"
      >
        {header}
        {body}
        {composer}
      </div>
    );
  }
  return (
    <div className="prism-agent-conversation flex h-full min-h-0 flex-col" data-compact={compact || undefined} data-testid="agent-conversation">
      {header}
      {body}
      {composer}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="prism-agent-user-block">
      <div className="prism-agent-speaker"><span className="prism-agent-avatar" aria-hidden="true">Y</span><span>You</span></div>
      <div
        className="prism-agent-user-text whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]"
        style={{ color: "var(--text-primary)" }}
        data-testid="agent-user-message"
      >
        {text}
      </div>
    </div>
  );
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs" style={{ color: "var(--text-muted)" }}>
      <Loader2 size={13} className="animate-spin" style={{ color: "var(--color-accent)" }} />
      {label}
    </div>
  );
}

function TurnBlock({ turn, compact }: { turn: TurnView; compact?: boolean }) {
  const [snapshotPreview, setSnapshotPreview] = useState<AgentContextSnapshot | null>(null);
  const running = isRunning(turn.status);
  const problem = turnProblem(turn);
  const billing = useAgentLimits()?.billing;
  const cost = formatAgentCost(turn.costUsd, billing);
  const dur = fmtDuration(turn.durationMs);
  const hasText = turn.blocks.some((b) => b.text.trim());
  return (
    <div className="prism-agent-turn flex flex-col gap-2" data-compact={compact || undefined} data-testid="agent-turn" data-status={turn.status}>
      {turn.prompt && <UserBubble text={turn.prompt} />}
      {snapshotPreview && <AgentSnapshotPreview snapshot={snapshotPreview} onClose={()=>setSnapshotPreview(null)}/>}
      {!!turn.context?.length && <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="agent-supplied-context" style={{ color: "var(--text-muted)" }}>
        <span>{turn.context.some(s=>s.snapshot) ? "Context supplied:" : "Saved text supplied:"}</span>
        {turn.context.map((source,index) => <span key={`${source.noteId}:${index}`} className="flex flex-wrap items-center gap-1">{source.snapshot ? <button className="focus-ring min-h-10 rounded-lg border border-[var(--glass-border)] px-2" onClick={()=>setSnapshotPreview(source.snapshot!)}>{source.snapshot.kind === "selection" ? "Selected passage" : source.snapshot.kind === "document" ? "Document snapshot" : "Text file"}</button> : <NoteChip noteId={source.noteId} op="context" />}<span title={source.updatedAt ? `Saved version: ${source.updatedAt}` : undefined}>{source.characters.toLocaleString()} characters{source.truncated ? " · truncated" : ""}</span></span>)}
      </div>}
      <div className="prism-agent-speaker prism-agent-speaker-assistant" style={{ color: "var(--text-secondary)" }}>
        <span className="prism-agent-avatar" aria-hidden="true"><PrismMark width={24} height={18} decorative /></span>
        <span className="font-medium">Prism agent</span>
        {turn.startedAt && <time dateTime={new Date(turn.startedAt).toISOString()} title={new Date(turn.startedAt).toLocaleString()} style={{ color: "var(--text-muted)" }}>{new Date(turn.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>}
      </div>
      {turn.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {turn.tools.map((tool) => (
            <span
              key={tool.id}
              title={tool.summary}
              data-testid="agent-tool-chip"
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              style={{
                background: "var(--glass)",
                border: `1px solid ${tool.ok === false ? "color-mix(in srgb, var(--color-danger) 50%, transparent)" : "var(--glass-border)"}`,
                color: tool.ok === false ? "var(--color-danger)" : "var(--text-secondary)",
              }}
            >
              <Wrench size={10} />
              {tool.name}
              {tool.ok === true && <Check size={11} style={{ color: "var(--color-success)" }} />}
              {tool.ok === false && <X size={11} />}
              {tool.ok === undefined && running && <Loader2 size={10} className="animate-spin" />}
            </span>
          ))}
        </div>
      )}
      {hasText && (
        <div className="prism-agent-assistant-text min-w-0 max-w-full [overflow-wrap:anywhere]" style={{ color: "var(--text-primary)" }} data-testid="agent-assistant-message">
          {turn.blocks
            .filter((b) => b.text.trim())
            .map((b, i) => (
              <div key={b.blockId} className={i > 0 ? "mt-2" : undefined}>
                <AgentMarkdown text={b.text} />
                {b.streaming && running && <span className="ml-0.5 inline-block animate-pulse" style={{ color: "var(--color-accent)" }}>▍</span>}
              </div>
            ))}
        </div>
      )}
      {running && !hasText && <Thinking label={turn.status === "queued" ? turn.reason ? `Queued — ${turn.reason}` : "Queued…" : "Thinking…"} />}
      {turn.touched.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {turn.touched.map((x) => (
            <NoteChip key={`${x.noteId}:${x.op}`} noteId={x.noteId} op={x.op} />
          ))}
        </div>
      )}
      {problem && (
        <div className="text-xs" style={{ color: problem.tone === "error" ? "var(--color-danger)" : "var(--text-muted)" }} data-testid="agent-turn-problem">
          {problem.text}
        </div>
      )}
      {!running && (cost || dur) && (
        <div className="text-[11px]" style={{ color: "var(--text-muted)" }} data-testid="agent-turn-footer">
          {dur}
          {dur && cost ? " · " : ""}
          {cost && <span title={cost.title}>{cost.text}</span>}
        </div>
      )}
    </div>
  );
}

/** Inspect a source without replacing the working document or active tab. */
function NoteChip({ noteId, op, label }: { noteId: string; op?: string; label?: string }) {
  const deleted = op === "delete";
  const { data: note, isError } = useNote(deleted ? null : noteId);
  const [preview, setPreview] = useState(false);
  const name = isError ? "Unavailable note" : label || note?.path?.split("/").pop() || noteId.slice(0, 10);
  const verb = op === "create" ? "Created" : op === "update" ? "Updated" : op === "delete" ? "Deleted" : null;
  return (
    <>
    <button
      disabled={deleted}
      onClick={() => setPreview(true)}
      data-testid="agent-note-chip"
      className="prism-agent-note-chip focus-ring flex max-w-full items-center gap-1 text-xs disabled:cursor-default"
      style={{
        background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
        color: deleted ? "var(--text-muted)" : "var(--color-accent)",
        textDecoration: deleted ? "line-through" : undefined,
      }}
    >
      <FileText size={11} className="flex-shrink-0" />
      {verb && <span style={{ opacity: 0.75 }}>{verb}</span>}
      <span className="truncate">{name}</span>
    </button>
    {preview && <AgentSourcePreview noteId={noteId} onClose={() => setPreview(false)} />}
    </>
  );
}

// ── compact panel (context panel "Agent" tab on the web) ─────────────────────

/** The context-panel chat on shells with an AgentClient: the shared active session,
 *  or a new one about the open note. */
export function AgentPanelChat({ client }: { client: AgentClient }) {
  const activeSessionId = useAgentChatStore((s) => s.activeSessionId);
  const setActiveSession = useAgentChatStore((s) => s.setActiveSession);
  const draft = useAgentChatStore((s) => s.draft);
  const setDraft = useAgentChatStore((s) => s.setDraft);
  const scope = useAgentChatStore((s) => s.scope);
  const tab = useUIStore((s) => s.openTabs.find((t) => t.id === s.activeTabId));
  const noteId = isAskableNoteId(tab?.noteId) ? tab!.noteId : undefined;
  const noteTitle = noteId ? tab?.title : undefined;
  // Capture once. Reading a citation or expanding the panel must never retarget
  // an unsent request. Only an explicit New action chooses another document.
  useEffect(() => {
    if (scope && !activeSessionId && !draft) setDraft({ noteId, noteTitle });
  }, [scope, activeSessionId, draft, noteId, noteTitle, setDraft]);
  const startNew = () => { setActiveSession(null); setDraft({ noteId, noteTitle }); };
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-end gap-1 px-2 py-1" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <button onClick={startNew} title={noteTitle ? `New conversation about ${noteTitle}` : "New vault conversation"} className="interactive focus-ring flex items-center gap-1 rounded px-2 py-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          <Plus size={12} /> New
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Conversation
          key={`${client.scope?.() ?? ""}:${activeSessionId ?? `draft:${draft?.noteId ?? ""}`}`}
          client={client}
          sessionId={activeSessionId}
          draft={draft}
          onCreated={(id) => setActiveSession(id)}
          onExpand={() => {
            // Expansion moves the conversation; do not leave a second composer
            // beside it (or an open mobile drawer covering the expanded view).
            useUIStore.setState({ contextPanelOpen: false });
            openAgentChat({ sessionId: activeSessionId });
          }}
          compact
        />
      </div>
    </div>
  );
}

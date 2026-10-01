/**
 * Agent chat (Arch v2 WP3.2) — durable server-side agent sessions over the
 * AgentClient seam. Rendered as the "agent-chat" virtual tab (Registry + Canvas
 * VIRTUAL_TAB_IDS + Navigation) and, compact, inside the context panel.
 *
 * Wide: session list | conversation. Mobile: the list in the canvas, and a
 * full-screen conversation over the command pill with the composer pinned above
 * the keyboard (visualViewport) and safe-area insets; inputs are 16px (no iOS zoom).
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { useAgentClient, useAgentAvailability, useAgentLimits, agentKeys } from "../../data/AgentClientContext";
import { AgentBudgetLine } from "./AgentBudget";
import { formatAgentCost, PROFILE_LABELS, isReadOnlyProfile } from "../../lib/agent/cost";
import { useAgentChatStore, openAgentChat, isAskableNoteId, type PendingAsk, type AgentDraftContext } from "../../lib/agent/chatStore";
import { useComposerDraft } from "../../lib/agent/useComposerDraft";
import { AgentApiError } from "../../lib/agent/sessions";
import { useAgentConversation, agentErrorText } from "../../lib/agent/useAgentConversation";
import { turnProblem, type TurnView } from "../../lib/agent/sessionReducer";
import type { AgentClient, AgentProfile, AgentPermissionMode, AgentSessionSummary } from "../../lib/agent/sessions";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useUIStore } from "../../app/stores/ui";
import { useNote } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { Spinner } from "../ui/Spinner";
import { PrismMark } from "../brand/PrismMark";
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

/** Minimal, injection-free markdown: ``` fences, `code`, **bold**; the rest pre-wrapped. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg px-3 py-2 text-[13px]"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", fontFamily: "var(--font-mono, monospace)" }}
          >
            {part.replace(/^[a-z0-9-]*\n/i, "")}
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((tok, j) =>
              tok.startsWith("`") && tok.endsWith("`") && tok.length > 2 ? (
                <code key={j} className="rounded px-1 text-[0.92em]" style={{ background: "var(--glass-hover)", fontFamily: "var(--font-mono, monospace)" }}>
                  {tok.slice(1, -1)}
                </code>
              ) : tok.startsWith("**") && tok.endsWith("**") && tok.length > 4 ? (
                <strong key={j}>{tok.slice(2, -2)}</strong>
              ) : (
                <Fragment key={j}>{tok}</Fragment>
              ),
            )}
          </span>
        ),
      )}
    </>
  );
}

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

  const { data: sessions, isLoading } = useQuery({
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
    <div className="flex h-full" data-testid="agent-chat">
      <div className="h-full flex-shrink-0 overflow-hidden" style={{ width: 272, borderRight: "1px solid var(--glass-border)" }}>
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

function SessionList({
  sessions,
  loading,
  activeId,
  onOpen,
  onNew,
  onArchive,
  mobile,
}: {
  sessions: AgentSessionSummary[];
  loading: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string) => void;
  mobile: boolean;
}) {
  const billing = useAgentLimits()?.billing;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-4" style={{ height: 52, borderBottom: "1px solid var(--glass-border)" }}>
        <PrismMark width={27} height={20} decorative style={{ color: "var(--text-primary)" }} />
        <span className="flex-1 font-semibold" style={{ color: "var(--text-primary)" }}>
          Conversations
        </span>
        <button
          onClick={onNew}
          data-testid="agent-new-session"
          className="press focus-ring flex items-center gap-1 rounded-full px-3 py-1.5 text-sm"
          style={{ background: "var(--color-accent)", color: "#fff" }}
        >
          <Plus size={14} /> New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1" style={{ paddingBottom: mobile ? 110 : 8 }}>
        {loading && (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <p className="px-4 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            No conversations yet.
          </p>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          const running = isRunning(s.lastTurnStatus);
          return (
            <div
              key={s.id}
              className="group mx-1.5 flex items-center rounded-lg pr-1"
              style={{ background: active ? "var(--surface-selected)" : undefined }}
            >
              <button
                data-testid="agent-session-row"
                onClick={() => onOpen(s.id)}
                aria-current={active ? "true" : undefined}
                className="interactive focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left"
                style={{ minHeight: mobile ? 56 : 48 }}
              >
              <span
                className={running ? "animate-pulse" : undefined}
                title={running ? "Running" : s.lastTurnStatus ?? "idle"}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  flexShrink: 0,
                  background: running
                    ? "var(--color-accent)"
                    : s.lastTurnStatus === "error"
                      ? "var(--color-danger)"
                      : "var(--glass-border)",
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" style={{ color: "var(--text-primary)", fontWeight: active ? 560 : 450 }}>
                  {s.title || "Untitled session"}
                </span>
                <span className="flex items-center gap-1.5 truncate text-xs" style={{ color: "var(--text-muted)" }}>
                  {running ? <span style={{ color: "var(--color-accent)" }}>{s.lastTurnStatus === "queued" ? "Queued" : "Working…"}</span> : relTime(s.lastTurnAt ?? s.updated_at)}
                  {isReadOnlyProfile(s.profile) && (
                    <span className="flex items-center gap-0.5">
                      · <Lock size={10} /> read-only
                    </span>
                  )}
                  {s.cost_usd > 0 && (
                    <span className="truncate" title={formatAgentCost(s.cost_usd, billing)?.title} data-testid="agent-session-cost">
                      · {formatAgentCost(s.cost_usd, billing)?.text}
                    </span>
                  )}
                </span>
              </span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(s.id);
                }}
                aria-label="Archive session"
                title="Archive"
                className={`interactive focus-ring flex flex-shrink-0 items-center justify-center rounded ${mobile ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
                style={{ width: mobile ? 44 : 32, height: mobile ? 44 : 32, color: "var(--text-muted)" }}
              >
                <Archive size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const limits = useAgentLimits();
  // The profiles the server offers (prism-* only when enabled); older servers: the two vault profiles.
  const pickable: AgentProfile[] = limits?.profiles?.length ? limits.profiles : ["vault-ro", "vault-rw"];
  const composerDraft = useComposerDraft(client.scope?.() || null, sessionId ? `session:${sessionId}` : `note:${draft?.noteId ?? "new"}`);
  const { text: input, setText: setInput, clearIfUnchanged } = composerDraft;
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [profile, setProfile] = useState<AgentProfile>("vault-ro");
  const [draftMode, setDraftMode] = useState<AgentPermissionMode>("read-only");
  const [changingMode, setChangingMode] = useState(false);
  const permissionModes = limits?.permissionModes;
  const modeLabels: Record<AgentPermissionMode, string> = { "read-only": "Read-only", suggest: "Suggested edits only", "read-write": "Read/write" };
  const permissionPending = conv.session?.pending_mode;
  useEffect(() => {
    if (!permissionPending) return;
    const timer = window.setInterval(() => { void conv.reload(); }, 1000);
    return () => window.clearInterval(timer);
  }, [permissionPending, conv.reload]);
  const changeMode = async (mode: AgentPermissionMode) => {
    if (!sessionId) { setDraftMode(mode); return; }
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
  const running = !!conv.active;
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
      if (!text || running || creating || sendingRef.current || permissionPending || changingMode) return;
      const sentDraft = textArg ?? input;
      if (textArg !== undefined) setInput(textArg);
      sendingRef.current = true;
      setSending(true);
      stickToBottom.current = true;
      if (isDraft) {
        setDraftError(null);
        setCreating(text);
        try {
          const title = text.replace(/\s+/g, " ").slice(0, 80);
          const { sessionId: id } = await client.createSession({ title, ...(permissionModes?.length ? { permissionMode: draftMode } : { profile }), noteId: draft?.noteId });
          await client.sendTurn(id, text, draft?.noteId ? { noteId: draft.noteId } : {});
          void queryClient.invalidateQueries({ queryKey: agentKeys(client).all });
          clearIfUnchanged(sentDraft);
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
      const ok = await conv.send(text, noteId ? { noteId } : {});
      if (ok) clearIfUnchanged(sentDraft);
      sendingRef.current = false;
      setSending(false);
    },
    [input, running, creating, isDraft, client, profile, draft, queryClient, onCreated, conv, setInput, clearIfUnchanged, permissionPending, changingMode, permissionModes, draftMode],
  );

  // Command bar "Ask Claude: …" → send immediately in a fresh draft (once, even
  // under StrictMode's double effect run).
  const autoSent = useRef<string | null>(null);
  useEffect(() => {
    if (isDraft && autoPrompt && autoSent.current !== autoPrompt) {
      autoSent.current = autoPrompt;
      onAutoPromptConsumed?.();
      void submit(autoPrompt);
    }
  }, [autoPrompt, isDraft]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const sessionProfile = conv.session?.profile;
  const noteId = isDraft ? draft?.noteId : (conv.session?.note_id ?? undefined);

  const header = (
    <div
      className="flex flex-shrink-0 items-center gap-2 px-3"
      style={{
        minHeight: compact ? 40 : 52,
        paddingTop: fullScreen ? "env(safe-area-inset-top)" : undefined,
        borderBottom: "1px solid var(--glass-border)",
      }}
    >
      {onBack && (
        <button onClick={onBack} aria-label="Back to sessions" className="interactive flex items-center justify-center rounded-full" style={{ width: 36, height: 36, color: "var(--text-secondary)" }}>
          <ArrowLeft size={19} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className={`truncate ${compact ? "text-xs" : "text-sm"} font-medium`} style={{ color: "var(--text-primary)" }} data-testid="agent-conversation-title">
          {title}
        </div>
        {!compact && (sessionProfile || conv.conn === "reconnecting") && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {sessionProfile && isReadOnlyProfile(sessionProfile) ? (
              <>
                <Lock size={10} /> {PROFILE_LABELS[sessionProfile].label}
              </>
            ) : sessionProfile ? (
              <>
                <PenLine size={10} /> {sessionProfile === "vault-rw" ? "Can edit your vault" : PROFILE_LABELS[sessionProfile].label}
              </>
            ) : null}
            {conv.conn === "reconnecting" && <span style={{ color: "var(--color-warning, var(--text-muted))" }}>· reconnecting…</span>}
          </div>
        )}
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
      className="flex-shrink-0 px-3 pt-2"
      style={{
        borderTop: "1px solid var(--glass-border)",
        paddingBottom: fullScreen ? "calc(env(safe-area-inset-bottom) + 8px)" : 8,
        background: fullScreen ? "var(--bg-surface)" : undefined,
      }}
    >
      {isDraft && !permissionModes?.length && (
        <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <div className="flex flex-wrap rounded-full p-0.5" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }} role="radiogroup" aria-label="Agent permissions">
            {pickable.map((p) => [p, PROFILE_LABELS[p].label, isReadOnlyProfile(p) ? <Lock key="l" size={11} /> : <PenLine key="p" size={11} />] as [AgentProfile, string, ReactNode]).map(([p, label, icon]) => (
              <button
                key={p}
                role="radio"
                aria-checked={profile === p}
                data-testid={`agent-profile-${p}`}
                onClick={() => setProfile(p)}
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
      {isDraft && <AgentBudgetLine />}
      {composerDraft.error && <p role="status" className="mb-2 text-xs" style={{ color: "var(--text-secondary)" }}>{composerDraft.error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={input}
          aria-label="Message the agent"
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          enterKeyHint={mobileComposer ? "enter" : undefined}
          placeholder={running ? "The agent is working…" : isDraft ? "Ask the agent…" : "Reply…"}
          data-testid="agent-input"
          className="min-w-0 flex-1 resize-none rounded-2xl px-3.5 py-2 outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
            fontSize: 16, // no iOS zoom-on-focus
            lineHeight: 1.4,
            minHeight: 40,
            maxHeight: 160,
          }}
        />
        {running ? (
          <button
            onClick={() => void conv.cancel()}
            aria-label="Stop"
            title="Stop"
            data-testid="agent-cancel"
            className="press flex flex-shrink-0 items-center justify-center rounded-full"
            style={{ width: 40, height: 40, background: "var(--color-danger)", color: "#fff" }}
          >
            <Square size={14} fill="#fff" />
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!input.trim() || sending || changingMode || !!permissionPending}
            aria-label="Send"
            data-testid="agent-send"
            className="press flex flex-shrink-0 items-center justify-center rounded-full disabled:opacity-40"
            style={{ width: 40, height: 40, background: "var(--color-accent)", color: "#fff" }}
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        )}
      </div>
    </div>
  );

  const body = (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="agent-messages">
      {empty}
      {conv.loading && conv.state.turns.length === 0 && !isDraft && (
        <div className="flex justify-center py-8">
          <Spinner size={18} />
        </div>
      )}
      {noteId && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="agent-working-document" style={{ color: "var(--text-muted)" }}>
          <span>Working document</span>
          <NoteChip noteId={noteId} label={isDraft ? draft?.noteTitle : undefined} />
        </div>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
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
        className="fixed left-0 right-0 top-0 flex flex-col"
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
    <div className="flex h-full flex-col" data-testid="agent-conversation">
      {header}
      {body}
      {composer}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>You</span>
      <div
        className="max-w-[92%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]"
        style={{ background: "var(--bg-surface)", color: "var(--text-primary)", border: "1px solid var(--glass-border)" }}
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
  const running = isRunning(turn.status);
  const problem = turnProblem(turn);
  const billing = useAgentLimits()?.billing;
  const cost = formatAgentCost(turn.costUsd, billing);
  const dur = fmtDuration(turn.durationMs);
  const hasText = turn.blocks.some((b) => b.text.trim());
  return (
    <div className="flex flex-col gap-2" data-testid="agent-turn" data-status={turn.status}>
      {turn.prompt && <UserBubble text={turn.prompt} />}
      <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        <PrismMark width={25} height={18} decorative />
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
        <div className={`min-w-0 max-w-full [overflow-wrap:anywhere] ${compact ? "text-[13px]" : "text-sm"} leading-relaxed`} style={{ color: "var(--text-primary)" }} data-testid="agent-assistant-message">
          {turn.blocks
            .filter((b) => b.text.trim())
            .map((b, i) => (
              <div key={b.blockId} className={i > 0 ? "mt-2" : undefined}>
                <RichText text={b.text} />
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

/** A note the agent touched (or the session's note): click opens it in a tab. */
function NoteChip({ noteId, op, label }: { noteId: string; op?: string; label?: string }) {
  const deleted = op === "delete";
  const { data: note } = useNote(deleted ? null : noteId);
  const openTab = useUIStore((s) => s.openTab);
  const name = label || note?.path?.split("/").pop() || noteId.slice(0, 10);
  const verb = op === "create" ? "Created" : op === "update" ? "Updated" : op === "delete" ? "Deleted" : null;
  const clickable = !deleted && !!note;
  return (
    <button
      disabled={!clickable}
      onClick={() => note && openTab(note.id, name, inferContentType(note))}
      data-testid="agent-note-chip"
      className="flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs disabled:cursor-default"
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
          onExpand={() => openAgentChat({ sessionId: activeSessionId })}
          compact
        />
      </div>
    </div>
  );
}

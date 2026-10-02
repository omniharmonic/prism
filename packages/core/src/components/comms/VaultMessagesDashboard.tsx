import "./messages.css";
import { messageInitials, messageColor } from "./messageAppearance";
import MessageRenderer from "../renderers/MessageRenderer";
import EmailRenderer from "../renderers/EmailRenderer";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import {
  useState,
  useMemo,
  createContext,
  useContext,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Search,
  MessageSquare,
  Filter,
  ChevronDown,
  ChevronRight,
  Link2,
  User,
  Users,
  PenSquare,
  AlertTriangle,
  Bell,
  Clock,
  Inbox,
  Check,
} from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useIsWeb } from "../../data/Platform";
import { MessageComposer } from "./MessageComposer";
import { threadStatus } from "../../lib/messages/triage";
import { matrixApi } from "../../lib/matrix/client";
import {
  useLiveActions,
  useLiveActionsClient,
} from "../../data/LiveActionsContext";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { Spinner } from "../ui/Spinner";
import type { Note } from "../../lib/types";
import type { RendererProps } from "../renderers/RendererProps";
import { useLivePollMs } from "../../lib/events/channelStatus";

interface LinkData {
  sourceId: string;
  targetId: string;
  relationship: string;
}

type ViewMode = "triage" | "people" | "platforms";
const THREAD_LIMIT = 500;
const EMAIL_LIMIT = 200;

/** Derive platform from metadata or fall back to tags (email notes lack metadata.platform). */
function getPlatform(note: Note): string {
  const meta = (note.metadata || {}) as Record<string, unknown>;
  if (meta.platform) return meta.platform as string;
  if ((note.tags || []).includes("email")) return "email";
  return "matrix";
}

function formatRelativeTime(ts: number | string): string {
  try {
    const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

interface PersonWithThreads {
  person: Note;
  name: string;
  threads: Note[];
  platforms: string[];
  lastMessageAt: number;
  channels: Record<string, string>;
}

const SelectedConversation = createContext<string | null>(null);
export default function VaultMessagesDashboard(_props: RendererProps) {
  const vault = useVaultClient();
  const audience = useAgentChatStore((state) => state.scope);
  const actions = useLiveActionsClient();
  return (
    <ScopedMessagesDashboard
      key={vault.scope?.() ?? actions?.scope?.() ?? audience ?? "local"}
    />
  );
}
function ScopedMessagesDashboard() {
  const vault = useVaultClient();
  const actions = useLiveActionsClient();
  const audience = useAgentChatStore(state => state.scope);
  const scope = vault.scope?.() ?? actions?.scope?.() ?? audience ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("triage");
  const [platformFilter, setPlatformFilter] = useState<string>("all");

  // Existing bounded lists; the UI must disclose when these limits are reached.
  const {
    data: loadedThreads,
    isLoading: threadsLoading,
    isError: threadsError,
    refetch: reloadThreads,
  } = useQuery({
    queryKey: ["vault", "inbox", scope, "notes", { tag: "message-thread" }],
    queryFn: () =>
      vault.listNotes({ tag: "message-thread", limit: THREAD_LIMIT }),
    refetchInterval: useLivePollMs(30_000),
  });

  // Fetch email notes
  const {
    data: loadedEmails,
    isLoading: emailsLoading,
    isError: emailsError,
    refetch: reloadEmails,
  } = useQuery({
    queryKey: ["vault", "inbox", scope, "notes", { tag: "email" }],
    queryFn: () => vault.listNotes({ tag: "email", limit: EMAIL_LIMIT }),
    refetchInterval: useLivePollMs(30_000),
  });

  // Fetch person notes (for People view)
  const {
    data: loadedPeople,
    isError: peopleError,
    refetch: reloadPeople,
  } = useQuery({
    queryKey: [
      "vault",
      "inbox",
      scope,
      "notes",
      { tag: "person", limit: 2000 },
    ],
    queryFn: () => vault.listNotes({ tag: "person", limit: 2000 }),
    refetchInterval: useLivePollMs(60_000),
  });

  const threadNotes = threadsError ? undefined : loadedThreads;
  const emailNotes = emailsError ? undefined : loadedEmails;
  const personNotes = peopleError ? undefined : loadedPeople;
  const limited =
    (threadNotes?.length ?? 0) >= THREAD_LIMIT ||
    (emailNotes?.length ?? 0) >= EMAIL_LIMIT;
  const allMessages = useMemo(
    () => [
      ...new Map(
        [...(threadNotes || []), ...(emailNotes || [])].map((note) => [
          note.id,
          note,
        ]),
      ).values(),
    ],
    [threadNotes, emailNotes],
  );

  // Build person→message link index from the full graph (single API call
  // instead of hundreds of individual getLinks calls that overwhelm the vault).
  const {
    data: loadedGraph,
    isError: graphError,
    refetch: reloadGraph,
  } = useQuery({
    queryKey: ["vault", "inbox", scope, "graph"],
    queryFn: () => vault.getGraph(),
    staleTime: 60_000,
  });
  const graphData = graphError ? undefined : loadedGraph;

  const personLinks = useMemo(() => {
    const linkMap = new Map<string, LinkData[]>();
    if (!graphData?.edges) return linkMap;
    for (const edge of graphData.edges) {
      if (
        edge.relationship !== "messages-with" &&
        edge.relationship !== "email-from"
      )
        continue;
      const link: LinkData = {
        sourceId: edge.source,
        targetId: edge.target,
        relationship: edge.relationship,
      };
      // Index by both endpoints so lookup works regardless of direction
      if (!linkMap.has(edge.source)) linkMap.set(edge.source, []);
      linkMap.get(edge.source)!.push(link);
      if (!linkMap.has(edge.target)) linkMap.set(edge.target, []);
      linkMap.get(edge.target)!.push(link);
    }
    return linkMap;
  }, [graphData]);

  // Build people-with-threads index using graph links (not name matching)
  const peopleWithThreads = useMemo(() => {
    if (!personNotes || !allMessages.length) return [];

    // Index messages by note ID for fast lookup
    const messageById = new Map<string, Note>();
    for (const note of allMessages) {
      messageById.set(note.id, note);
    }

    const result: PersonWithThreads[] = [];
    for (const person of personNotes) {
      const meta = (person.metadata || {}) as Record<string, unknown>;
      const personName =
        (meta.name as string) ||
        (person.path || "").split("/").pop()?.replace(/-/g, " ") ||
        "";
      if (!personName) continue;

      const channels = (meta.channels as Record<string, string>) || {};

      // Get threads via graph links (primary method)
      const links = personLinks.get(person.id) || [];
      const threads: Note[] = [];
      for (const link of links) {
        const threadId =
          link.sourceId === person.id ? link.targetId : link.sourceId;
        const thread = messageById.get(threadId);
        if (thread && !threads.some((item) => item.id === thread.id))
          threads.push(thread);
      }

      if (threads.length === 0) continue;

      // Get platforms and latest message time
      const platforms = new Set<string>();
      let lastMessageAt = 0;
      for (const t of threads) {
        const tm = (t.metadata || {}) as Record<string, unknown>;
        platforms.add(getPlatform(t));
        const ts = (tm.lastMessageAt as number) || 0;
        if (ts > lastMessageAt) lastMessageAt = ts;
      }

      result.push({
        person,
        name: personName,
        threads,
        platforms: Array.from(platforms),
        lastMessageAt,
        channels,
      });
    }

    // Sort by most recent message
    result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return result;
  }, [personNotes, allMessages, personLinks]);

  // Platform groups (for platform view)
  const { platformGroups, platformCounts, totalCount } = useMemo(() => {
    if (!allMessages.length)
      return {
        platformGroups: new Map<string, Note[]>(),
        platformCounts: new Map<string, number>(),
        totalCount: 0,
      };

    const platformCounts = new Map<string, number>();
    for (const note of allMessages) {
      const p = getPlatform(note);
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }

    const q = searchQuery.toLowerCase();
    const filtered = allMessages.filter((note) => {
      const platform = getPlatform(note);
      if (platformFilter !== "all" && platform !== platformFilter) return false;
      if (q) {
        const name = (note.path || "").split("/").pop() || "";
        const content = note.content || "";
        if (
          !name.toLowerCase().includes(q) &&
          !content.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const aTime =
        ((a.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      const bTime =
        ((b.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      return bTime - aTime;
    });

    const groups = new Map<string, Note[]>();
    for (const note of filtered) {
      const p = getPlatform(note);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(note);
    }

    return {
      platformGroups: groups,
      platformCounts,
      totalCount: allMessages.length,
    };
  }, [allMessages, searchQuery, platformFilter]);

  // Filtered people
  const filteredPeople = useMemo(() => {
    if (!searchQuery) return peopleWithThreads;
    const q = searchQuery.toLowerCase();
    return peopleWithThreads.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.platforms.some((pl) => pl.includes(q)) ||
        p.threads.some((t) => (t.content || "").toLowerCase().includes(q)),
    );
  }, [peopleWithThreads, searchQuery]);

  const handleOpenThread = (note: Note) => setSelectedId(note.id);

  const platforms = useMemo(
    () => Array.from(platformCounts.keys()).sort(),
    [platformCounts],
  );

  if (threadsLoading || emailsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <SelectedConversation.Provider value={selectedId}>
      <div
        className={`prism-messages-workspace prism-message-split h-full min-h-0 min-w-0 ${selectedId ? "has-selection" : ""}`}
      >
        <div
          className="prism-messages-list flex min-h-0 min-w-0 flex-col"
          aria-label="Conversation list"
        >
          {/* Header */}
          <div className="prism-messages-heading">
            <div className="min-w-[120px] flex-1">
              <h1
                className="text-lg font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                Messages
              </h1>
              <p
                className="text-xs mt-0.5"
                style={{ color: "var(--text-muted)" }}
              >
                {limited ? "Showing " : ""}
                {totalCount} conversations
                {viewMode === "people" && ` · ${filteredPeople.length} people`}
              </p>
            </div>

            {/* View toggle */}
            <div
              className="prism-message-views flex max-w-full rounded-lg overflow-hidden"
              role="group"
              aria-label="Inbox view"
              style={{ border: "1px solid var(--glass-border)" }}
            >
              <button
                aria-pressed={viewMode === "triage"}
                onClick={() => setViewMode("triage")}
                className="interactive focus-ring flex items-center gap-1 px-3 py-2 text-xs"
                style={{
                  background:
                    viewMode === "triage"
                      ? "var(--surface-selected)"
                      : "transparent",
                  color:
                    viewMode === "triage"
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                }}
              >
                <Inbox size={11} /> Triage
              </button>
              <button
                aria-pressed={viewMode === "people"}
                onClick={() => setViewMode("people")}
                className="interactive focus-ring flex items-center gap-1 px-3 py-2 text-xs"
                style={{
                  background:
                    viewMode === "people"
                      ? "var(--surface-selected)"
                      : "transparent",
                  color:
                    viewMode === "people"
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                }}
              >
                <Users size={11} /> People
              </button>
              <button
                aria-pressed={viewMode === "platforms"}
                onClick={() => setViewMode("platforms")}
                className="interactive focus-ring flex items-center gap-1 px-3 py-2 text-xs"
                style={{
                  background:
                    viewMode === "platforms"
                      ? "var(--surface-selected)"
                      : "transparent",
                  color:
                    viewMode === "platforms"
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                }}
              >
                <MessageSquare size={11} /> Platforms
              </button>
            </div>

            {/* Search */}
            <div
              className="prism-message-search flex min-w-0 items-center gap-2 px-3 py-2"
              style={{
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
              }}
            >
              <Search size={13} style={{ color: "var(--text-muted)" }} />
              <input
                aria-label="Search inbox"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  limited
                    ? "Search loaded conversations…"
                    : viewMode === "people"
                      ? "Search people or messages…"
                      : "Search messages…"
                }
                className="bg-transparent text-base outline-none min-w-0 w-full"
                style={{ color: "var(--text-primary)" }}
              />
            </div>

            {/* Platform filter (platforms view only) */}
            {viewMode === "platforms" && (
              <div className="flex items-center gap-1.5">
                <Filter size={12} style={{ color: "var(--text-muted)" }} />
                <select
                  aria-label="Filter inbox platform"
                  value={platformFilter}
                  onChange={(e) => setPlatformFilter(e.target.value)}
                  className="min-h-11 rounded-lg px-3 text-sm outline-none"
                  style={{
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    color: "var(--text-primary)",
                  }}
                >
                  <option
                    value="all"
                    style={{ background: "var(--bg-elevated)" }}
                  >
                    All platforms
                  </option>
                  {platforms.map((p) => {
                    const config = getPlatformConfig(p);
                    return (
                      <option
                        key={p}
                        value={p}
                        style={{ background: "var(--bg-elevated)" }}
                      >
                        {config.label} ({platformCounts.get(p) || 0})
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </div>

          {/* Content */}
          {limited && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-xs"
              style={{
                borderColor: "var(--glass-border)",
                color: "var(--text-muted)",
              }}
            >
              Older conversations may be outside this loaded set.{" "}
              <button
                className="focus-ring underline"
                onClick={() => useUIStore.getState().openCommandBar()}
              >
                Search all notes
              </button>
            </div>
          )}
          {(threadsError ||
            emailsError ||
            (viewMode === "people" && (peopleError || graphError))) && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              Some conversations or people links couldn't load.{" "}
              <button
                className="focus-ring underline"
                onClick={() =>
                  void Promise.all([
                    reloadThreads(),
                    reloadEmails(),
                    reloadPeople(),
                    reloadGraph(),
                  ])
                }
              >
                Try again
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            {viewMode === "triage" ? (
              <TriageView
                messages={allMessages}
                onOpenThread={handleOpenThread}
                searchQuery={searchQuery}
              />
            ) : viewMode === "people" ? (
              <PeopleView
                people={filteredPeople}
                onOpenThread={handleOpenThread}
              />
            ) : (
              <PlatformView
                groups={platformGroups}
                onOpenThread={handleOpenThread}
                searchQuery={searchQuery}
                platformFilter={platformFilter}
              />
            )}
          </div>
        </div>
        <section
          className="prism-messages-detail flex min-h-0 min-w-0 flex-col"
          aria-label="Selected conversation"
        >
          {selectedId ? (
            <ConversationDetail
              key={selectedId}
              noteId={selectedId}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-[var(--text-muted)]">
              <MessageSquare size={32} strokeWidth={1.4} />
              <h2 className="text-base font-medium text-[var(--text-secondary)]">
                Choose a conversation
              </h2>
              <p className="max-w-xs text-sm leading-relaxed">
                Messages, people, and the context you share — together in one
                place.
              </p>
            </div>
          )}
        </section>
      </div>
    </SelectedConversation.Provider>
  );
}

function ConversationDetail({
  noteId,
  onBack,
}: {
  noteId: string;
  onBack: () => void;
}) {
  const vault = useVaultClient();
  const actions = useLiveActionsClient();
  const scope = vault.scope?.() ?? actions?.scope?.() ?? null;
  const result = useQuery({
    queryKey: ["vault", "message-detail", scope, noteId],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const note = await vault.getNote(noteId, { fresh: true });
      if ((vault.scope?.() ?? actions?.scope?.() ?? null) !== scope)
        throw Error("Workspace changed");
      return note;
    },
  });
  const note = result.data;
  const isEmail = note?.tags?.includes("email");
  return (
    <>
      <div className="prism-message-detail-nav flex shrink-0 items-center justify-between gap-2 border-b border-[var(--glass-border)] px-4">
        <button
          className="focus-ring flex min-h-11 items-center gap-1 text-xs text-[var(--text-secondary)]"
          onClick={onBack}
        >
          <ArrowLeft size={15} /> Back to messages
        </button>
        {note && !result.isError && (
          <button
            className="focus-ring flex min-h-11 items-center gap-1 text-xs text-[var(--text-secondary)]"
            onClick={() =>
              useUIStore
                .getState()
                .openTab(
                  note.id,
                  note.path?.split("/").pop() || "Conversation",
                  isEmail ? "email" : "message-thread",
                )
            }
          >
            <ArrowUpRight size={15} /> Open as page
          </button>
        )}
      </div>
      {result.isPending ? (
        <p role="status" className="p-6 text-sm text-[var(--text-muted)]">
          Opening conversation…
        </p>
      ) : result.isError ? (
        <div role="alert" className="p-6 text-sm text-[var(--text-secondary)]">
          This conversation couldn't be opened. Your messages list is still
          here.{" "}
          <button
            className="min-h-11 underline"
            onClick={() => void result.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        note && (
          <div className="min-h-0 flex-1">
            {isEmail ? (
              <EmailRenderer
                note={note}
                readOnly={!!note._caps && !note._caps.includes("edit")}
              />
            ) : (
              <MessageRenderer
                note={note}
                readOnly={!!note._caps && !note._caps.includes("edit")}
              />
            )}
          </div>
        )
      )}
    </>
  );
}

// ─── Triage View ─────────────────────────────────────────────

// Importance tags written by the `message-triage` skill (skill_scheduler.rs).
// Keep this list in sync with the skill prompt's Step 2 tags — a note carrying
// any of these has been classified and must NOT fall back into "Needs Triage".

const PRIORITY_TIERS = [
  {
    tag: "urgent",
    label: "Urgent",
    icon: AlertTriangle,
    color: "var(--color-danger)",
    bgColor: "var(--bg-surface)",
    borderColor: "rgba(239,68,68,0.4)",
    defaultCollapsed: false,
  },
  {
    tag: "action-required",
    label: "Action Required",
    icon: Bell,
    color: "var(--color-warning)",
    bgColor: "var(--bg-surface)",
    borderColor: "rgba(245,158,11,0.4)",
    defaultCollapsed: false,
  },
  {
    tag: "unclassified",
    label: "Needs Triage",
    icon: Clock,
    color: "var(--text-muted)",
    bgColor: "var(--glass)",
    borderColor: "var(--glass-border)",
    defaultCollapsed: false,
  },
  {
    tag: "informational",
    label: "Informational",
    icon: MessageSquare,
    color: "var(--text-secondary)",
    bgColor: "transparent",
    borderColor: "var(--glass-border)",
    defaultCollapsed: true,
  },
  {
    tag: "low",
    label: "Low Priority",
    icon: Inbox,
    color: "var(--text-muted)",
    bgColor: "transparent",
    borderColor: "var(--glass-border)",
    defaultCollapsed: true,
  },
  {
    tag: "social",
    label: "Social",
    icon: Users,
    color: "var(--text-muted)",
    bgColor: "var(--bg-surface)",
    borderColor: "var(--glass-border)",
    defaultCollapsed: true,
  },
  {
    tag: "triaged",
    label: "Reviewed",
    icon: Check,
    color: "var(--text-muted)",
    bgColor: "var(--bg-surface)",
    borderColor: "var(--glass-border)",
    defaultCollapsed: true,
  },
  {
    tag: "handled",
    label: "Handled",
    icon: Check,
    color: "var(--color-success)",
    bgColor: "transparent",
    borderColor: "rgba(34,197,94,0.3)",
    defaultCollapsed: true,
  },
] as const;

function TriageView({
  messages,
  onOpenThread,
  searchQuery,
}: {
  messages: Note[];
  onOpenThread: (note: Note) => void;
  searchQuery: string;
}) {
  const q = searchQuery.toLowerCase();

  const tiers = useMemo(() => {
    const result: Array<{
      tier: (typeof PRIORITY_TIERS)[number];
      notes: Note[];
    }> = [];

    for (const tier of PRIORITY_TIERS) {
      let notes = messages.filter(
        (note) => threadStatus(note.tags) === tier.tag,
      );

      // Apply search filter
      if (q) {
        notes = notes.filter((n) => {
          const name = (n.path || "").split("/").pop() || "";
          return (
            name.toLowerCase().includes(q) ||
            (n.content || "").toLowerCase().includes(q)
          );
        });
      }

      // Sort by most recent
      notes.sort((a, b) => {
        const aTime =
          ((a.metadata as Record<string, unknown>)?.lastMessageAt as number) ||
          0;
        const bTime =
          ((b.metadata as Record<string, unknown>)?.lastMessageAt as number) ||
          0;
        return bTime - aTime;
      });

      if (notes.length > 0) {
        result.push({ tier, notes });
      }
    }

    return result;
  }, [messages, q]);

  const urgentCount = messages.filter(
    (n) => threadStatus(n.tags) === "urgent",
  ).length;
  const actionCount = messages.filter(
    (n) => threadStatus(n.tags) === "action-required",
  ).length;

  if (messages.length === 0) {
    return (
      <div className="text-center py-12">
        <Inbox
          size={24}
          style={{ color: "var(--text-muted)" }}
          className="mx-auto mb-2"
        />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          No messages to triage.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary banner */}
      {(urgentCount > 0 || actionCount > 0) && (
        <div
          className="flex items-center gap-4 px-6 py-2.5"
          style={{
            background:
              urgentCount > 0
                ? "rgba(239,68,68,0.06)"
                : "rgba(245,158,11,0.06)",
            borderBottom: "1px solid var(--glass-border)",
          }}
        >
          {urgentCount > 0 && (
            <span
              className="flex items-center gap-1.5 text-xs font-medium"
              style={{ color: "var(--color-danger)" }}
            >
              <AlertTriangle size={13} /> {urgentCount} urgent
            </span>
          )}
          {actionCount > 0 && (
            <span
              className="flex items-center gap-1.5 text-xs font-medium"
              style={{ color: "var(--color-warning)" }}
            >
              <Bell size={13} /> {actionCount} need action
            </span>
          )}
        </div>
      )}

      {/* Priority tiers */}
      {tiers.map(({ tier, notes }) => (
        <TriageTier
          key={`${tier.tag}:${!!searchQuery}`}
          forceExpanded={!!searchQuery}
          tier={tier}
          notes={notes}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

function TriageTier({
  tier,
  notes,
  onOpenThread,
  forceExpanded,
}: {
  forceExpanded?: boolean;
  tier: (typeof PRIORITY_TIERS)[number];
  notes: Note[];
  onOpenThread: (note: Note) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    forceExpanded ? false : tier.defaultCollapsed,
  );
  const Icon = tier.icon;
  const selectedId = useContext(SelectedConversation);

  return (
    <div>
      <button
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        className="prism-message-tier w-full flex items-center gap-2 focus-ring hover:bg-[var(--glass-hover)] transition-colors"
      >
        {collapsed ? (
          <ChevronRight size={13} style={{ color: tier.color }} />
        ) : (
          <ChevronDown size={13} style={{ color: tier.color }} />
        )}
        <Icon size={13} style={{ color: tier.color }} />
        <span className="prism-tier-name text-xs">{tier.label}</span>
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded-full"
          style={{ background: tier.borderColor, color: tier.color }}
        >
          {notes.length}
        </span>
      </button>

      {!collapsed &&
        notes.map((note) => {
          const meta = (note.metadata || {}) as Record<string, unknown>;
          const platform = getPlatform(note);
          const config = getPlatformConfig(platform);
          const name =
            (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Thread";
          const lastTs = meta.lastMessageAt as number;
          const participants = (meta.participants as string[]) || [];

          // Get last message preview
          const lines = (note.content || "")
            .split("\n")
            .filter((l) => l.trim() && !l.startsWith("#"));
          const lastLine = lines[lines.length - 1] || "";

          return (
            <button
              key={note.id}
              onClick={() => onOpenThread(note)}
              className="prism-message-row flex items-start gap-3 text-left"
              aria-current={selectedId === note.id ? "true" : undefined}
            >
              <div
                aria-hidden="true"
                className="prism-message-avatar"
                style={
                  { "--avatar-tone": messageColor(note.id) } as CSSProperties
                }
              >
                {messageInitials(name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="text-sm font-medium capitalize truncate"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {name}
                  </span>
                  {lastTs && (
                    <span
                      className="ml-auto text-xs flex-shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {formatRelativeTime(lastTs)}
                    </span>
                  )}
                </div>
                {lastLine && (
                  <div className="prism-message-preview truncate">
                    {lastLine}
                  </div>
                )}
                <span className="prism-message-platform">{config.label}</span>
                {participants.length > 0 && (
                  <div className="flex items-center gap-1 mt-1">
                    <User size={9} style={{ color: "var(--text-muted)" }} />
                    <span
                      className="text-[10px] truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {participants.slice(0, 3).join(", ")}
                      {participants.length > 3
                        ? ` +${participants.length - 3}`
                        : ""}
                    </span>
                  </div>
                )}
              </div>
            </button>
          );
        })}
    </div>
  );
}

// ─── People View ─────────────────────────────────────────────

function PeopleView({
  people,
  onOpenThread,
}: {
  people: PersonWithThreads[];
  onOpenThread: (note: Note) => void;
}) {
  if (people.length === 0) {
    return (
      <div className="text-center py-12">
        <Users
          size={24}
          style={{ color: "var(--text-muted)" }}
          className="mx-auto mb-2"
        />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          No people with messages found.
        </p>
      </div>
    );
  }

  return (
    <div>
      {people.map((p) => (
        <PersonCard key={p.person.id} person={p} onOpenThread={onOpenThread} />
      ))}
    </div>
  );
}

function PersonCard({
  person: p,
  onOpenThread,
}: {
  person: PersonWithThreads;
  onOpenThread: (note: Note) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeThread, setComposeThread] = useState("");
  const liveMatrix = useLiveActions("matrix");
  const scope = useLiveActionsClient()?.scope?.() || null;
  const isWeb = useIsWeb();
  const destinations = p.threads
    .flatMap((thread) => {
      const meta = thread.metadata || {};
      const roomId = meta.matrixRoomId || meta.matrix_room_id;
      return typeof roomId === "string" && roomId.startsWith("!")
        ? [{ thread, roomId }]
        : [];
    })
    .filter(
      (entry, index, all) =>
        all.findIndex((item) => item.roomId === entry.roomId) === index,
    );
  const destination = destinations.find(
    (entry) => entry.thread.id === composeThread,
  );
  const canSend = !!liveMatrix || !isWeb;

  return (
    <div
      style={{
        borderBottom:
          "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)",
      }}
    >
      {/* Person header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-6 py-3 hover:bg-[var(--glass-hover)] transition-colors text-left"
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
          }}
        >
          <User size={15} style={{ color: "var(--text-muted)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-sm font-medium capitalize"
              style={{ color: "var(--text-primary)" }}
            >
              {p.name}
            </span>
            <span
              className="ml-auto text-xs flex-shrink-0"
              style={{ color: "var(--text-muted)" }}
            >
              {p.lastMessageAt ? formatRelativeTime(p.lastMessageAt) : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {/* Platform badges */}
            {p.platforms.map((pl) => {
              const config = getPlatformConfig(pl);
              return (
                <span
                  key={pl}
                  className="text-[9px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: config.color,
                    color: "white",
                    opacity: 0.85,
                  }}
                >
                  {config.label}
                </span>
              );
            })}
            <span
              className="text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              {p.threads.length} thread{p.threads.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        {expanded ? (
          <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
        ) : (
          <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />
        )}
      </button>

      {/* Expanded: show threads + compose */}
      {expanded && (
        <div className="pb-2">
          {/* Thread list */}
          {p.threads.map((thread) => {
            const meta = (thread.metadata || {}) as Record<string, unknown>;
            const platform = getPlatform(thread);
            const config = getPlatformConfig(platform);
            const threadName =
              (thread.path || "").split("/").pop()?.replace(/-/g, " ") ||
              "Thread";
            const lastTs = meta.lastMessageAt as number;
            const lines = (thread.content || "")
              .split("\n")
              .filter((l) => l.trim() && !l.startsWith("#"));
            const lastLine = lines[lines.length - 1] || "";

            return (
              <button
                key={thread.id}
                onClick={() => onOpenThread(thread)}
                className="w-full flex items-start gap-3 px-6 pl-16 py-2 hover:bg-[var(--glass-hover)] transition-colors text-left"
              >
                <span
                  className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                  style={{ background: config.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs capitalize truncate"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {threadName}
                    </span>
                    <span
                      className="text-[9px] px-1 rounded"
                      style={{ color: config.color }}
                    >
                      {config.label}
                    </span>
                    {lastTs && (
                      <span
                        className="ml-auto text-[10px] flex-shrink-0"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {formatRelativeTime(lastTs)}
                      </span>
                    )}
                  </div>
                  {lastLine && (
                    <div
                      className="text-[10px] truncate mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {lastLine}
                    </div>
                  )}
                </div>
              </button>
            );
          })}

          {/* Choose a concrete conversation; a platform or person ID is not a recipient. */}
          <div className="px-4 sm:px-6 sm:pl-16 pt-2">
            {!composing ? (
              <button
                disabled={!destinations.length || !canSend}
                onClick={() => {
                  setComposing(true);
                  setComposeThread(
                    destinations.length === 1 ? destinations[0].thread.id : "",
                  );
                }}
                className="interactive focus-ring flex items-center gap-2 rounded-lg px-3 py-2 text-xs disabled:opacity-40"
              >
                <PenSquare size={14} /> Send message
              </button>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs">
                  Conversation
                  <select
                    aria-label="Message destination"
                    value={composeThread}
                    onChange={(event) => setComposeThread(event.target.value)}
                    className="focus-ring mt-1 w-full rounded-lg border p-2 text-base"
                    style={{
                      background: "var(--bg-surface)",
                      borderColor: "var(--glass-border)",
                    }}
                  >
                    <option value="">Choose a conversation…</option>
                    {destinations.map(({ thread }) => (
                      <option key={thread.id} value={thread.id}>
                        {thread.path || thread.id} ·{" "}
                        {getPlatformConfig(getPlatform(thread)).label}
                      </option>
                    ))}
                  </select>
                </label>
                {destination && (
                  <>
                    <p
                      className="text-xs break-words"
                      style={{ color: "var(--text-muted)" }}
                    >
                      To conversation:{" "}
                      {destination.thread.path || destination.roomId}
                    </p>
                    <MessageComposer
                      draftScope={scope}
                      draftKey={`matrix:${destination.roomId}`}
                      retrySafe={!!liveMatrix}
                      disabled={!canSend}
                      onSend={async (body, options) => {
                        if (liveMatrix) {
                          if (!scope || liveMatrix.scope?.() !== scope)
                            throw new Error(
                              "Workspace changed. Reopen this conversation before sending.",
                            );
                          await liveMatrix.matrixSend(
                            destination.roomId,
                            body,
                            { idempotencyKey: options.requestId },
                          );
                        } else {
                          if (isWeb)
                            throw new Error(
                              "Messaging is unavailable on this connection.",
                            );
                          await matrixApi.sendMessage(destination.roomId, body);
                        }
                        setComposing(false);
                      }}
                    />
                  </>
                )}
                <button
                  onClick={() => setComposing(false)}
                  className="interactive focus-ring rounded-lg px-3 py-2 text-xs"
                >
                  Close composer
                </button>
              </div>
            )}
            {!canSend && (
              <p
                role="status"
                className="py-2 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Messaging is unavailable on this connection.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Platform View (existing) ────────────────────────────────

function PlatformView({
  groups,
  onOpenThread,
  searchQuery,
  platformFilter,
}: {
  groups: Map<string, Note[]>;
  onOpenThread: (note: Note) => void;
  searchQuery: string;
  platformFilter: string;
}) {
  if (groups.size === 0) {
    return (
      <div className="text-center py-12">
        <MessageSquare
          size={24}
          style={{ color: "var(--text-muted)" }}
          className="mx-auto mb-2"
        />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {searchQuery || platformFilter !== "all"
            ? "No conversations match your filters."
            : "No indexed conversations yet."}
        </p>
      </div>
    );
  }

  return (
    <>
      {Array.from(groups.entries()).map(([platform, platformNotes]) => {
        const config = getPlatformConfig(platform);
        return (
          <CollapsibleSection
            key={platform}
            label={config.label}
            color={config.color}
            notes={platformNotes}
            onOpen={onOpenThread}
          />
        );
      })}
    </>
  );
}

function CollapsibleSection({
  label,
  color,
  notes,
  onOpen,
}: {
  label: string;
  color: string;
  notes: Note[];
  onOpen: (note: Note) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-5 py-2 sticky top-0 hover:bg-[var(--glass-hover)] transition-colors"
        style={{
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--glass-border)",
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: color }}
        />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-secondary)" }}
        >
          {label}
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {notes.length}
        </span>
      </button>
      {open &&
        notes.map((note) => (
          <ConversationRow
            key={note.id}
            note={note}
            onClick={() => onOpen(note)}
          />
        ))}
    </div>
  );
}

function ConversationRow({
  note,
  onClick,
}: {
  note: Note;
  onClick: () => void;
}) {
  const selectedId = useContext(SelectedConversation);
  const meta = (note.metadata || {}) as Record<string, unknown>;
  const name =
    (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Unknown";
  const participants = (meta.participants as string[]) || [];
  const lastMessageAt = meta.lastMessageAt as number;
  const messageCount = meta.messageCount as number;
  const timeStr = lastMessageAt ? formatRelativeTime(lastMessageAt) : "";
  const lines = (note.content || "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  const lastLine = lines[lines.length - 1] || "";

  return (
    <button
      onClick={onClick}
      className="prism-message-row flex items-start gap-3 text-left"
      aria-current={selectedId === note.id ? "true" : undefined}
    >
      <div
        aria-hidden="true"
        className="prism-message-avatar"
        style={{ "--avatar-tone": messageColor(note.id) } as CSSProperties}
      >
        {messageInitials(name)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm truncate capitalize"
            style={{ color: "var(--text-primary)" }}
          >
            {name}
          </span>
          {timeStr && (
            <span
              className="ml-auto text-xs flex-shrink-0"
              style={{ color: "var(--text-muted)" }}
            >
              {timeStr}
            </span>
          )}
        </div>
        {lastLine && (
          <div className="prism-message-preview truncate">{lastLine}</div>
        )}
        <div className="flex items-center gap-2 mt-1">
          {participants.length > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              <User size={9} /> {participants.length}
            </span>
          )}
          {messageCount && (
            <span
              className="text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              {messageCount} msgs
            </span>
          )}
          <span
            className="flex items-center gap-0.5 text-[10px]"
            style={{ color: "var(--color-accent)" }}
          >
            <Link2 size={9} /> vault
          </span>
        </div>
      </div>
    </button>
  );
}

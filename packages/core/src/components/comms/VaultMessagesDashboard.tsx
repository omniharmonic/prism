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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Search,
  MessageSquare,
  Filter,
  ChevronDown,
  ChevronRight,
  User,
  Users,
  PenSquare,
  AlertTriangle,
  Bell,
  Clock,
  Inbox,
  Check,
  RefreshCw,
  MailOpen,
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
import { useSwipeActions } from "../../lib/gestures/useSwipeActions";
import { usePullToRefresh } from "../../lib/gestures/usePullToRefresh";
import { usePagesUI } from "../../lib/pages/store";
import { liveActionErrorText } from "../../lib/actions/client";

import { PeopleConversationList, PersonTimeline, SourceBadge, usePeopleConversations, messageWhen } from "./PeopleConversations";
import { ConversationChromeProvider } from "./conversationChrome";
import type { PersonConversationItem } from "../../data/VaultClient";
import type { ContentType } from "../../lib/types";
interface LinkData {
  sourceId: string;
  targetId: string;
  relationship: string;
}

type ViewMode = "triage" | "people" | "platforms";
const THREAD_LIMIT = 500;
const EMAIL_LIMIT = 200;

/** Matches server identity.ts isTombstone/isNonHumanPerson (a98c9af).
 * A merge pointer alone is not a tombstone; document-type people remain human.
 * Filter this view, never the transparent notes API or the underlying graph. */
function isLiveMessagePerson(note: Note): boolean {
  const tags = note.tags ?? [];
  const metadata = note.metadata ?? {};
  return (
    !tags.some(tag => ["merged-stub", "superseded", "non-human", "bot", "organization"].includes(tag))
    && metadata.status !== "merged_into_canonical"
    && metadata.type !== "bot" && metadata.type !== "organization"
  );
}

/** Derive platform from metadata or fall back to tags (email notes lack metadata.platform). */
function getPlatform(note: Note): string {
  const meta = (note.metadata || {}) as Record<string, unknown>;
  if (meta.platform) return meta.platform as string;
  if ((note.tags || []).includes("email")) return "email";
  return "matrix";
}

/** List times read like the mockups: a time today, "Yesterday", else a short date. */
const formatRelativeTime = (ts: number | string): string => {
  const at = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(at) ? messageWhen(at) : "";
};

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
  // People view: the person whose merged timeline fills the detail pane (a thread opened from it sits on top).
  const [selectedPerson, setSelectedPerson] = useState<{ id: string; name: string } | null>(null);
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

  // People are resolved by the server (addresses + handles, no stored link needed). Only a shell
  // without that route (the legacy desktop) still derives them from person notes + graph links.
  const resolvesPeople = !!vault.listPeopleConversations;
  const peoplePage = usePeopleConversations(scope, searchQuery, resolvesPeople && viewMode === "people");

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
    enabled: !resolvesPeople,
  });

  const threadNotes = threadsError ? undefined : loadedThreads;
  const emailNotes = emailsError ? undefined : loadedEmails;
  const personNotes = useMemo(
    () => peopleError ? undefined : loadedPeople?.filter(isLiveMessagePerson),
    [peopleError, loadedPeople],
  );
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
    enabled: !resolvesPeople,
  });
  const graphData = graphError ? undefined : loadedGraph;

  const personLinks = useMemo(() => {
    const linkMap = new Map<string, LinkData[]>();
    if (!graphData?.edges) return linkMap;
    for (const edge of graphData.edges) {
      if (
        edge.relationship !== "messages-with" &&
        edge.relationship !== "email-from" &&
        edge.relationship !== "email-to"
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
  // The timeline belongs to the People view; another view shows its own selection only.
  const person = viewMode === "people" && resolvesPeople ? selectedPerson : null;
  const openTimelineItem = (item: PersonConversationItem) => {
    // A meeting is a page of its own; mail and chats open here, over the timeline.
    if (item.kind === "meeting") useUIStore.getState().openTab(item.id, item.title, "meeting" as ContentType);
    else setSelectedId(item.id);
  };
  // Phone: pull the conversation list down to refetch it (the Refresh button does the same).
  const pull = usePullToRefresh<HTMLDivElement>({
    label: "Messages",
    onRefresh: () => Promise.all([reloadThreads(), reloadEmails(), ...(resolvesPeople ? (viewMode === "people" ? [peoplePage.refetch()] : []) : [reloadPeople(), reloadGraph()])]).then((all) => {
      if (all.some((r) => r.isError)) throw new Error("refresh failed");
    }),
  });

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
        className={`prism-messages-workspace prism-message-split h-full min-h-0 min-w-0 ${selectedId || person ? "has-selection" : ""}`}
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
                {viewMode === "people" && (resolvesPeople ? (peoplePage.data ? ` · ${peoplePage.data.total} people` : "") : ` · ${filteredPeople.length} people`)}
              </p>
            </div>

            <button
              type="button"
              className="focus-ring flex h-11 w-11 flex-none items-center justify-center rounded-lg"
              aria-label="Refresh"
              title="Refresh"
              aria-busy={pull.refreshing || undefined}
              disabled={pull.refreshing}
              onClick={pull.refresh}
              style={{ color: "var(--text-secondary)" }}
            >
              <RefreshCw size={15} />
            </button>

            {/* View toggle: the app's tab look (ui/Tabs) on toggle buttons. */}
            <div className="prism-message-views" role="group" aria-label="Inbox view">
              {([["triage", "Triage", Inbox], ["people", "People", Users], ["platforms", "Platforms", MessageSquare]] as const).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={viewMode === id}
                  onClick={() => setViewMode(id)}
                  className="focus-ring"
                >
                  <Icon size={14} aria-hidden="true" /> {label}
                </button>
              ))}
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
            (viewMode === "people" && !resolvesPeople && (peopleError || graphError))) && (
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
          <div className="flex-1 min-h-0 overflow-auto" style={{ overflowX: "hidden" }} ref={pull.ref} data-testid="messages-scroller">
            {pull.indicator}
            {viewMode === "triage" ? (
              <TriageView
                messages={allMessages}
                onOpenThread={handleOpenThread}
                searchQuery={searchQuery}
              />
            ) : viewMode === "people" && resolvesPeople ? (
              <PeopleConversationList
                page={peoplePage.data}
                loading={peoplePage.isPending}
                failed={peoplePage.isError}
                onRetry={() => void peoplePage.refetch()}
                query={searchQuery}
                selectedId={selectedPerson?.id ?? null}
                onSelect={(person) => {
                  setSelectedId(null);
                  setSelectedPerson({ id: person.id, name: person.name });
                }}
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
              backLabel={person ? `Back to ${person.name}` : "Back to messages"}
              onBack={() => setSelectedId(null)}
            />
          ) : person ? (
            <PersonTimeline
              key={person.id}
              personId={person.id}
              name={person.name}
              scope={scope}
              onBack={() => setSelectedPerson(null)}
              onOpen={openTimelineItem}
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
  backLabel = "Back to messages",
}: {
  noteId: string;
  onBack: () => void;
  backLabel?: string;
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
  // ONE header per conversation: the thread's own header carries Back and Open as page
  // (conversationChrome). Only while there is no thread to show does a bar of our own stand in.
  if (note && !result.isError)
    return (
      <ConversationChromeProvider
        value={{
          onBack,
          backLabel,
          onOpenPage: () =>
            useUIStore
              .getState()
              .openTab(
                note.id,
                note.path?.split("/").pop() || "Conversation",
                isEmail ? "email" : "message-thread",
              ),
        }}
      >
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
      </ConversationChromeProvider>
    );
  return (
    <>
      <div className="prism-conversation-heading">
        <button
          type="button"
          className="prism-conversation-action focus-ring"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
      </div>
      {result.isPending ? (
        <p role="status" className="p-6 text-sm text-[var(--text-muted)]">
          Opening conversation…
        </p>
      ) : (
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

  // Show a real conversation on entry even when every populated tier is
  // normally collapsed. This is an initializer only: refetches must not undo
  // a reader's deliberate collapse choice.
  const initialExpandedTag = tiers.some(({ tier }) => !tier.defaultCollapsed)
    ? undefined
    : tiers[0]?.tier.tag;

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
          defaultExpanded={tier.tag === initialExpandedTag}
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
  defaultExpanded,
}: {
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  tier: (typeof PRIORITY_TIERS)[number];
  notes: Note[];
  onOpenThread: (note: Note) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => !(forceExpanded || defaultExpanded || !tier.defaultCollapsed),
  );
  const Icon = tier.icon;

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
        notes.map((note) => (
          <TriageRow key={note.id} note={note} onOpen={() => onOpenThread(note)} />
        ))}
    </div>
  );
}

/**
 * One list row for every view: avatar, name, a one-line preview, the time, and where the
 * conversation lives. An unread email reads heavier and carries a dot (never colour alone).
 */
function ThreadRow({ note, onOpen }: { note: Note; onOpen: () => void }) {
  const selectedId = useContext(SelectedConversation);
  const swipe = useEmailRowActions(note);
  const meta = (note.metadata || {}) as Record<string, unknown>;
  const name = (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Thread";
  const lastTs = meta.lastMessageAt as number;
  const participants = Array.isArray(meta.participants) ? meta.participants.length : 0;
  const unread = meta.isUnread === true && !markedRead.has(note.id);
  const preview = lastPreview(note.content || "");
  return (
    <div style={{ position: "relative" }}>
      <button
        ref={swipe.ref}
        onClick={onOpen}
        className="prism-message-row prism-swipe-row flex items-start gap-3 text-left"
        style={{ position: "relative" }}
        aria-current={selectedId === note.id ? "true" : undefined}
        data-unread={unread || undefined}
      >
        {swipe.hint}
        <div
          aria-hidden="true"
          className="prism-message-avatar"
          style={{ "--avatar-tone": messageColor(note.id) } as CSSProperties}
        >
          {messageInitials(name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="prism-row-name truncate capitalize">{name}</span>
            {unread && <span className="prism-unread-dot" role="img" aria-label="Unread" />}
            {lastTs ? <span className="prism-row-time ml-auto shrink-0">{formatRelativeTime(lastTs)}</span> : null}
          </div>
          {preview && <div className="prism-message-preview truncate">{preview}</div>}
          <div className="prism-person-sources">
            <SourceBadge platform={getPlatform(note)} />
            {participants > 2 && <span className="prism-row-count">{participants} people</span>}
          </div>
        </div>
      </button>
      {swipe.markRead && <MarkReadButton name={name} onClick={swipe.markRead} />}
    </div>
  );
}

/** The last line of a saved conversation, without the transcript's `[date time]` stamp. Linear. */
function lastPreview(content: string): string {
  let end = content.length;
  while (end > 0) {
    const start = content.lastIndexOf("\n", end - 1) + 1;
    const line = content.slice(start, end).trim();
    if (line && !line.startsWith("#")) {
      const close = line.startsWith("[") ? line.indexOf("] ") : -1;
      return (close > 0 && close <= 20 ? line.slice(close + 2) : line).slice(0, 200);
    }
    end = start - 1;
  }
  return "";
}

function TriageRow({ note, onOpen }: { note: Note; onOpen: () => void }) {
  return <ThreadRow note={note} onOpen={onOpen} />;
}

/** Emails marked read from the list in this session: read at once, before the next mail ingest updates the note. */
const markedRead = new Set<string>();

/**
 * Mark-as-read for an unread EMAIL row — a swipe right on a phone and a small button on the row
 * (the same action; a gesture is never the only way) — only where the live email actions are on
 * for this viewer. ARCHIVE is deliberately not a swipe: it moves the message in the real mailbox
 * and cannot be undone from here; it stays a button in the opened email.
 */
function useEmailRowActions(note: Note) {
  const live = useLiveActions("email");
  const queryClient = useQueryClient();
  const unread = !!live && (note.tags ?? []).includes("email")
    && (note.metadata as Record<string, unknown> | null | undefined)?.isUnread === true && !markedRead.has(note.id);
  const markRead = unread ? () => {
    void live!.emailMarkRead({ noteId: note.id }, true).then(
      () => {
        markedRead.add(note.id);
        usePagesUI.getState().showToast({ message: "Marked read" });
        // The lists this row lives in: updated in place now, re-read in the background.
        queryClient.setQueriesData<unknown>({ queryKey: ["vault", "inbox"] }, (old: unknown) =>
          Array.isArray(old) ? old.map((n: Note) => (n?.id === note.id ? { ...n, metadata: { ...(n.metadata ?? {}), isUnread: false } } : n)) : old);
        void queryClient.invalidateQueries({ queryKey: ["vault", "inbox"] });
      },
      (e) => usePagesUI.getState().showToast({ message: liveActionErrorText(e), tone: "error" }),
    );
  } : null;
  const swipe = useSwipeActions<HTMLButtonElement>({
    disabled: !markRead,
    right: markRead ? { label: "Mark as read", tone: "accent", run: markRead } : null,
  });
  return { ...swipe, markRead };
}

/** The row's own "Mark as read" control (keyboard, mouse, screen readers). */
function MarkReadButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" className="focus-ring" aria-label={`Mark ${name} as read`} title="Mark as read" onClick={onClick}
      style={{ position: "absolute", right: 14, bottom: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, color: "var(--text-secondary)" }}>
      <MailOpen size={15} aria-hidden="true" />
    </button>
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
  return <ThreadRow note={note} onOpen={onClick} />;
}

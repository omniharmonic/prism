import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, MessageSquare, Filter, ChevronDown, ChevronRight, Link2, User, Users, Send, PenSquare, AlertTriangle, Bell, Clock, Inbox, Check } from "lucide-react";
import { vaultApi } from "../../lib/parachute/client";
import { matrixApi } from "../../lib/matrix/client";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { Spinner } from "../ui/Spinner";
import type { Note } from "../../lib/types";
import type { RendererProps } from "../renderers/RendererProps";

interface LinkData {
  sourceId: string;
  targetId: string;
  relationship: string;
}

type ViewMode = "triage" | "people" | "platforms";

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

export default function VaultMessagesDashboard(_props: RendererProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("triage");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const openTab = useUIStore((s) => s.openTab);

  // Fetch all message-thread notes
  const { data: threadNotes, isLoading: threadsLoading } = useQuery({
    queryKey: ["vault", "notes", { tag: "message-thread" }],
    queryFn: () => vaultApi.listNotes({ tag: "message-thread", limit: 500 }),
    refetchInterval: 30_000,
  });

  // Fetch email notes
  const { data: emailNotes } = useQuery({
    queryKey: ["vault", "notes", { tag: "email" }],
    queryFn: () => vaultApi.listNotes({ tag: "email", limit: 200 }),
    refetchInterval: 30_000,
  });

  // Fetch person notes (for People view)
  const { data: personNotes } = useQuery({
    queryKey: ["vault", "notes", { tag: "person", limit: 2000 }],
    queryFn: () => vaultApi.listNotes({ tag: "person", limit: 2000 }),
    refetchInterval: 60_000,
  });

  const allMessages = useMemo(() => [...(threadNotes || []), ...(emailNotes || [])], [threadNotes, emailNotes]);

  // Fetch links for all person notes (messages-with relationships)
  // We batch this by fetching from the graph API
  const [personLinks, setPersonLinks] = useState<Map<string, LinkData[]>>(new Map());

  useEffect(() => {
    if (!personNotes || personNotes.length === 0) return;
    // Fetch links for people who have messages-with connections
    // Use a sampling approach: fetch links for people with vault/people/ paths
    const fetchLinks = async () => {
      const linkMap = new Map<string, LinkData[]>();
      // Only fetch for people with auto-created paths (they have links from sync)
      const candidates = personNotes.filter((n) => (n.path || "").startsWith("vault/people/")).slice(0, 500);
      // Batch fetch using Promise.all in chunks
      const chunkSize = 20;
      for (let i = 0; i < candidates.length; i += chunkSize) {
        const chunk = candidates.slice(i, i + chunkSize);
        const results = await Promise.all(
          chunk.map((n) => vaultApi.getLinks(n.id, "messages-with").then((links) => ({ id: n.id, links })).catch(() => ({ id: n.id, links: [] as LinkData[] })))
        );
        for (const { id, links } of results) {
          if (links.length > 0) linkMap.set(id, links);
        }
      }
      // Also check pre-existing people
      const preExisting = personNotes.filter((n) => !(n.path || "").startsWith("vault/people/"));
      for (const n of preExisting) {
        try {
          const links = await vaultApi.getLinks(n.id, "messages-with");
          if (links.length > 0) linkMap.set(n.id, links);
        } catch {}
      }
      setPersonLinks(linkMap);
    };
    fetchLinks();
  }, [personNotes]);

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
      const personName = (meta.name as string) || (person.path || "").split("/").pop()?.replace(/-/g, " ") || "";
      if (!personName) continue;

      const channels = (meta.channels as Record<string, string>) || {};

      // Get threads via graph links (primary method)
      const links = personLinks.get(person.id) || [];
      const threads: Note[] = [];
      for (const link of links) {
        const threadId = link.sourceId === person.id ? link.targetId : link.sourceId;
        const thread = messageById.get(threadId);
        if (thread) threads.push(thread);
      }

      if (threads.length === 0) continue;

      // Get platforms and latest message time
      const platforms = new Set<string>();
      let lastMessageAt = 0;
      for (const t of threads) {
        const tm = (t.metadata || {}) as Record<string, unknown>;
        platforms.add((tm.platform as string) || "matrix");
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
    if (!allMessages.length) return { platformGroups: new Map<string, Note[]>(), platformCounts: new Map<string, number>(), totalCount: 0 };

    const platformCounts = new Map<string, number>();
    for (const note of allMessages) {
      const p = ((note.metadata || {}) as Record<string, unknown>).platform as string || "matrix";
      platformCounts.set(p, (platformCounts.get(p) || 0) + 1);
    }

    const q = searchQuery.toLowerCase();
    const filtered = allMessages.filter((note) => {
      const meta = (note.metadata || {}) as Record<string, unknown>;
      const platform = (meta.platform as string) || "matrix";
      if (platformFilter !== "all" && platform !== platformFilter) return false;
      if (q) {
        const name = (note.path || "").split("/").pop() || "";
        const content = note.content || "";
        if (!name.toLowerCase().includes(q) && !content.toLowerCase().includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const aTime = ((a.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      const bTime = ((b.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
      return bTime - aTime;
    });

    const groups = new Map<string, Note[]>();
    for (const note of filtered) {
      const p = ((note.metadata || {}) as Record<string, unknown>).platform as string || "matrix";
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(note);
    }

    return { platformGroups: groups, platformCounts, totalCount: allMessages.length };
  }, [allMessages, searchQuery, platformFilter]);

  // Filtered people
  const filteredPeople = useMemo(() => {
    if (!searchQuery) return peopleWithThreads;
    const q = searchQuery.toLowerCase();
    return peopleWithThreads.filter((p) =>
      p.name.toLowerCase().includes(q)
      || p.platforms.some((pl) => pl.includes(q))
      || p.threads.some((t) => (t.content || "").toLowerCase().includes(q))
    );
  }, [peopleWithThreads, searchQuery]);

  const handleOpenThread = (note: Note) => {
    const name = (note.path || "").split("/").pop()?.replace(/-/g, " ") || note.id;
    openTab(note.id, name, "message-thread");
  };

  const platforms = useMemo(() => Array.from(platformCounts.keys()).sort(), [platformCounts]);

  if (threadsLoading) {
    return <div className="flex items-center justify-center h-full"><Spinner size={24} /></div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-3" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <div className="flex-1">
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Messages</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {totalCount} conversations
            {viewMode === "people" && ` · ${filteredPeople.length} people`}
          </p>
        </div>

        {/* View toggle */}
        <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
          <button onClick={() => setViewMode("triage")}
            className="flex items-center gap-1 px-2.5 py-1 text-xs"
            style={{ background: viewMode === "triage" ? "var(--color-accent)" : "transparent", color: viewMode === "triage" ? "white" : "var(--text-secondary)" }}>
            <Inbox size={11} /> Triage
          </button>
          <button onClick={() => setViewMode("people")}
            className="flex items-center gap-1 px-2.5 py-1 text-xs"
            style={{ background: viewMode === "people" ? "var(--color-accent)" : "transparent", color: viewMode === "people" ? "white" : "var(--text-secondary)" }}>
            <Users size={11} /> People
          </button>
          <button onClick={() => setViewMode("platforms")}
            className="flex items-center gap-1 px-2.5 py-1 text-xs"
            style={{ background: viewMode === "platforms" ? "var(--color-accent)" : "transparent", color: viewMode === "platforms" ? "white" : "var(--text-secondary)" }}>
            <MessageSquare size={11} /> Platforms
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg max-w-xs"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
          <Search size={13} style={{ color: "var(--text-muted)" }} />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={viewMode === "people" ? "Search people or messages..." : "Search messages..."}
            className="bg-transparent text-xs outline-none w-40"
            style={{ color: "var(--text-primary)" }} />
        </div>

        {/* Platform filter (platforms view only) */}
        {viewMode === "platforms" && (
          <div className="flex items-center gap-1.5">
            <Filter size={12} style={{ color: "var(--text-muted)" }} />
            <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}
              className="h-7 rounded-md px-2 text-xs outline-none"
              style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
              <option value="all" style={{ background: "var(--bg-elevated)" }}>All platforms</option>
              {platforms.map((p) => {
                const config = getPlatformConfig(p);
                return <option key={p} value={p} style={{ background: "var(--bg-elevated)" }}>{config.label} ({platformCounts.get(p) || 0})</option>;
              })}
            </select>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {viewMode === "triage" ? (
          <TriageView messages={allMessages} onOpenThread={handleOpenThread} searchQuery={searchQuery} />
        ) : viewMode === "people" ? (
          <PeopleView people={filteredPeople} onOpenThread={handleOpenThread} />
        ) : (
          <PlatformView groups={platformGroups} onOpenThread={handleOpenThread} searchQuery={searchQuery} platformFilter={platformFilter} />
        )}
      </div>
    </div>
  );
}

// ─── Triage View ─────────────────────────────────────────────

const PRIORITY_TIERS = [
  { tag: "urgent", label: "Urgent", icon: AlertTriangle, color: "var(--color-danger)", bgColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)", defaultCollapsed: false },
  { tag: "action-required", label: "Action Required", icon: Bell, color: "var(--color-warning)", bgColor: "rgba(245,158,11,0.08)", borderColor: "rgba(245,158,11,0.3)", defaultCollapsed: false },
  { tag: "unclassified", label: "Needs Triage", icon: Clock, color: "var(--text-muted)", bgColor: "var(--glass)", borderColor: "var(--glass-border)", defaultCollapsed: false },
  { tag: "informational", label: "Informational", icon: MessageSquare, color: "var(--text-secondary)", bgColor: "transparent", borderColor: "var(--glass-border)", defaultCollapsed: true },
  { tag: "handled", label: "Handled", icon: Check, color: "var(--color-success)", bgColor: "transparent", borderColor: "rgba(34,197,94,0.3)", defaultCollapsed: true },
] as const;

function TriageView({ messages, onOpenThread, searchQuery }: { messages: Note[]; onOpenThread: (note: Note) => void; searchQuery: string }) {
  const q = searchQuery.toLowerCase();

  const tiers = useMemo(() => {
    const result: Array<{ tier: typeof PRIORITY_TIERS[number]; notes: Note[] }> = [];

    for (const tier of PRIORITY_TIERS) {
      let notes: Note[];
      if (tier.tag === "unclassified") {
        notes = messages.filter((n) => {
          const tags = n.tags || [];
          return !tags.includes("urgent") && !tags.includes("action-required") && !tags.includes("informational") && !tags.includes("social") && !tags.includes("handled");
        });
      } else {
        notes = messages.filter((n) => (n.tags || []).includes(tier.tag));
      }

      // Apply search filter
      if (q) {
        notes = notes.filter((n) => {
          const name = (n.path || "").split("/").pop() || "";
          return name.toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q);
        });
      }

      // Sort by most recent
      notes.sort((a, b) => {
        const aTime = ((a.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
        const bTime = ((b.metadata as Record<string, unknown>)?.lastMessageAt as number) || 0;
        return bTime - aTime;
      });

      if (notes.length > 0) {
        result.push({ tier, notes });
      }
    }

    return result;
  }, [messages, q]);

  const urgentCount = messages.filter((n) => (n.tags || []).includes("urgent")).length;
  const actionCount = messages.filter((n) => (n.tags || []).includes("action-required")).length;

  if (messages.length === 0) {
    return (
      <div className="text-center py-12">
        <Inbox size={24} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No messages to triage.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary banner */}
      {(urgentCount > 0 || actionCount > 0) && (
        <div className="flex items-center gap-4 px-6 py-2.5" style={{ background: urgentCount > 0 ? "rgba(239,68,68,0.06)" : "rgba(245,158,11,0.06)", borderBottom: "1px solid var(--glass-border)" }}>
          {urgentCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--color-danger)" }}>
              <AlertTriangle size={13} /> {urgentCount} urgent
            </span>
          )}
          {actionCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--color-warning)" }}>
              <Bell size={13} /> {actionCount} need action
            </span>
          )}
        </div>
      )}

      {/* Priority tiers */}
      {tiers.map(({ tier, notes }) => (
        <TriageTier key={tier.tag} tier={tier} notes={notes} onOpenThread={onOpenThread} />
      ))}
    </div>
  );
}

function TriageTier({ tier, notes, onOpenThread }: {
  tier: typeof PRIORITY_TIERS[number];
  notes: Note[];
  onOpenThread: (note: Note) => void;
}) {
  const [collapsed, setCollapsed] = useState(tier.defaultCollapsed);
  const Icon = tier.icon;

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-5 py-2.5 sticky top-0 hover:bg-[var(--glass-hover)] transition-colors"
        style={{ background: tier.bgColor, borderBottom: `1px solid ${tier.borderColor}` }}
      >
        {collapsed ? <ChevronRight size={13} style={{ color: tier.color }} /> : <ChevronDown size={13} style={{ color: tier.color }} />}
        <Icon size={13} style={{ color: tier.color }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: tier.color }}>
          {tier.label}
        </span>
        <span className="text-xs font-medium px-1.5 py-0.5 rounded-full" style={{ background: tier.borderColor, color: tier.color }}>
          {notes.length}
        </span>
      </button>

      {!collapsed && notes.map((note) => {
        const meta = (note.metadata || {}) as Record<string, unknown>;
        const platform = (meta.platform as string) || "matrix";
        const config = getPlatformConfig(platform);
        const name = (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Thread";
        const lastTs = meta.lastMessageAt as number;
        const participants = (meta.participants as string[]) || [];

        // Get last message preview
        const lines = (note.content || "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        const lastLine = lines[lines.length - 1] || "";

        return (
          <button
            key={note.id}
            onClick={() => onOpenThread(note)}
            className="w-full flex items-start gap-3 px-6 py-3 hover:bg-[var(--glass-hover)] transition-colors text-left"
            style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)", borderLeft: `3px solid ${tier.color}` }}
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ background: config.color, opacity: 0.15 }}>
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: config.color }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize truncate" style={{ color: "var(--text-primary)" }}>
                  {name}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ background: config.color, color: "white" }}>
                  {config.label}
                </span>
                {lastTs && (
                  <span className="ml-auto text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                    {formatRelativeTime(lastTs)}
                  </span>
                )}
              </div>
              {lastLine && (
                <div className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>{lastLine}</div>
              )}
              {participants.length > 0 && (
                <div className="flex items-center gap-1 mt-1">
                  <User size={9} style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] truncate" style={{ color: "var(--text-muted)" }}>
                    {participants.slice(0, 3).join(", ")}{participants.length > 3 ? ` +${participants.length - 3}` : ""}
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

function PeopleView({ people, onOpenThread }: { people: PersonWithThreads[]; onOpenThread: (note: Note) => void }) {
  if (people.length === 0) {
    return (
      <div className="text-center py-12">
        <Users size={24} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No people with messages found.</p>
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

function PersonCard({ person: p, onOpenThread }: { person: PersonWithThreads; onOpenThread: (note: Note) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeChannel, setComposeChannel] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!composeBody.trim() || !composeChannel) return;
    setSending(true);
    try {
      // The channel value is the Matrix room ID or user ID
      // Find the matching thread to get the room ID
      const matchThread = p.threads.find((t) => {
        const meta = (t.metadata || {}) as Record<string, unknown>;
        return (meta.platform as string) === composeChannel || (meta.matrixRoomId as string) === p.channels[composeChannel];
      });
      const roomId = matchThread
        ? ((matchThread.metadata || {}) as Record<string, unknown>).matrixRoomId as string
        : p.channels[composeChannel];

      if (roomId) {
        await matrixApi.sendMessage(roomId, composeBody.trim());
        setComposeBody("");
        setComposing(false);
      }
    } catch (e) {
      console.error("Send failed:", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }}>
      {/* Person header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-6 py-3 hover:bg-[var(--glass-hover)] transition-colors text-left"
      >
        <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
          <User size={15} style={{ color: "var(--text-muted)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium capitalize" style={{ color: "var(--text-primary)" }}>
              {p.name}
            </span>
            <span className="ml-auto text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
              {p.lastMessageAt ? formatRelativeTime(p.lastMessageAt) : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {/* Platform badges */}
            {p.platforms.map((pl) => {
              const config = getPlatformConfig(pl);
              return (
                <span key={pl} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: config.color, color: "white", opacity: 0.85 }}>
                  {config.label}
                </span>
              );
            })}
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {p.threads.length} thread{p.threads.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        {expanded ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
      </button>

      {/* Expanded: show threads + compose */}
      {expanded && (
        <div className="pb-2">
          {/* Thread list */}
          {p.threads.map((thread) => {
            const meta = (thread.metadata || {}) as Record<string, unknown>;
            const platform = (meta.platform as string) || "matrix";
            const config = getPlatformConfig(platform);
            const threadName = (thread.path || "").split("/").pop()?.replace(/-/g, " ") || "Thread";
            const lastTs = meta.lastMessageAt as number;
            const lines = (thread.content || "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
            const lastLine = lines[lines.length - 1] || "";

            return (
              <button
                key={thread.id}
                onClick={() => onOpenThread(thread)}
                className="w-full flex items-start gap-3 px-6 pl-16 py-2 hover:bg-[var(--glass-hover)] transition-colors text-left"
              >
                <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: config.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs capitalize truncate" style={{ color: "var(--text-primary)" }}>{threadName}</span>
                    <span className="text-[9px] px-1 rounded" style={{ color: config.color }}>{config.label}</span>
                    {lastTs && <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>{formatRelativeTime(lastTs)}</span>}
                  </div>
                  {lastLine && <div className="text-[10px] truncate mt-0.5" style={{ color: "var(--text-muted)" }}>{lastLine}</div>}
                </div>
              </button>
            );
          })}

          {/* Quick compose */}
          <div className="px-6 pl-16 pt-2">
            {!composing ? (
              <button
                onClick={() => { setComposing(true); setComposeChannel(p.platforms[0] || ""); }}
                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--color-accent)" }}
              >
                <PenSquare size={10} /> Send message
              </button>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>via</span>
                  <select value={composeChannel} onChange={(e) => setComposeChannel(e.target.value)}
                    className="rounded px-1.5 py-0.5 text-[10px] outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    {p.platforms.map((pl) => (
                      <option key={pl} value={pl}>{getPlatformConfig(pl).label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder={`Message ${p.name}...`}
                    className="flex-1 rounded px-2 py-1.5 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                    autoFocus
                  />
                  <button onClick={handleSend} disabled={!composeBody.trim() || sending}
                    className="p-1.5 rounded transition-colors disabled:opacity-30"
                    style={{ background: "var(--color-accent)", color: "white" }}>
                    <Send size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Platform View (existing) ────────────────────────────────

function PlatformView({ groups, onOpenThread, searchQuery, platformFilter }: {
  groups: Map<string, Note[]>; onOpenThread: (note: Note) => void; searchQuery: string; platformFilter: string;
}) {
  if (groups.size === 0) {
    return (
      <div className="text-center py-12">
        <MessageSquare size={24} style={{ color: "var(--text-muted)" }} className="mx-auto mb-2" />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {searchQuery || platformFilter !== "all" ? "No conversations match your filters." : "No indexed conversations yet."}
        </p>
      </div>
    );
  }

  return (
    <>
      {Array.from(groups.entries()).map(([platform, platformNotes]) => {
        const config = getPlatformConfig(platform);
        return (
          <CollapsibleSection key={platform} label={config.label} color={config.color} notes={platformNotes} onOpen={onOpenThread} />
        );
      })}
    </>
  );
}

function CollapsibleSection({ label, color, notes, onOpen }: {
  label: string; color: string; notes: Note[]; onOpen: (note: Note) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-5 py-2 sticky top-0 hover:bg-[var(--glass-hover)] transition-colors"
        style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--glass-border)" }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>{label}</span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{notes.length}</span>
      </button>
      {open && notes.map((note) => (
        <ConversationRow key={note.id} note={note} onClick={() => onOpen(note)} />
      ))}
    </div>
  );
}

function ConversationRow({ note, onClick }: { note: Note; onClick: () => void }) {
  const meta = (note.metadata || {}) as Record<string, unknown>;
  const name = (note.path || "").split("/").pop()?.replace(/-/g, " ") || "Unknown";
  const participants = (meta.participants as string[]) || [];
  const lastMessageAt = meta.lastMessageAt as number;
  const messageCount = meta.messageCount as number;
  const timeStr = lastMessageAt ? formatRelativeTime(lastMessageAt) : "";
  const lines = (note.content || "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const lastLine = lines[lines.length - 1] || "";

  return (
    <button onClick={onClick}
      className="w-full flex items-start gap-3 px-6 py-2.5 hover:bg-[var(--glass-hover)] transition-colors text-left"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--glass-border) 50%, transparent)" }}>
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
        <MessageSquare size={13} style={{ color: "var(--text-muted)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate capitalize" style={{ color: "var(--text-primary)" }}>{name}</span>
          {timeStr && <span className="ml-auto text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>{timeStr}</span>}
        </div>
        {lastLine && <div className="text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>{lastLine}</div>}
        <div className="flex items-center gap-2 mt-1">
          {participants.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <User size={9} /> {participants.length}
            </span>
          )}
          {messageCount && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{messageCount} msgs</span>}
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "var(--color-accent)" }}>
            <Link2 size={9} /> vault
          </span>
        </div>
      </div>
    </button>
  );
}


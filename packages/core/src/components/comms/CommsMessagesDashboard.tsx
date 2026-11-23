/**
 * Messages over the Comms API (D19 stages 1–2: Prism's look, Comms' behaviour). The list is
 * `/api/comms/threads` — real conversation names, previews and avatars, keyset pages — with the
 * Comms filters: folders, triage statuses (several at once), networks, unread and one person.
 * A conversation opens in the detail pane: through its vault note when it has one (the status
 * control, Omni and the reply box stay where they were), else read-only from Comms. A person's
 * contact page lists every chat with them (`/api/comms/people/:id`).
 *
 * VaultMessagesDashboard decides whether this view is used (owner + Comms on + primary vault) and
 * hands in the note-backed pieces it already owns, so nothing here imports it back.
 */
import "./messages.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BellOff, Inbox, Mail, MessageSquare, Pin, RefreshCw, Search, UserRound, Users, X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { usePullToRefresh } from "../../lib/gestures/usePullToRefresh";
import { useUIStore } from "../../app/stores/ui";
import { NEEDS_ATTENTION_LABEL, THREAD_STATUS_LABELS, THREAD_STATUS_ORDER, THREAD_STATUS_TONE } from "../../lib/messages/triage";
import type { CommsFolder, CommsNetwork, CommsPerson, CommsStatus, CommsThread } from "../../lib/comms/types";
import type { ContentType } from "../../lib/types";
import type { PersonConversationItem } from "../../data/VaultClient";
import { Spinner } from "../ui/Spinner";
import { ConversationBack, ConversationChromeProvider } from "./conversationChrome";
import { CommsAvatar, CommsTranscript } from "./CommsTranscript";
import { PeopleConversationList, PersonTimeline, SourceBadge, messageWhen, platformLabel, usePeopleConversations } from "./PeopleConversations";
import { StatusChip } from "./StatusChip";

const PAGE = 50;
export const FOLDERS: { id: CommsFolder; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "unknown", label: "Unknown" },
  { id: "low", label: "Low priority" },
  { id: "spam", label: "Spam" },
  { id: "archived", label: "Archived" },
];

export interface CommsFilters {
  folder: CommsFolder;
  statuses: CommsStatus[];
  attention: boolean;
  networks: CommsNetwork[];
  unread: boolean;
  person: { id: string; name: string } | null;
}
/** Opens on Needs attention (Prism owner decision 2026-10-08), "All" one tap away. */
export const DEFAULT_FILTERS: CommsFilters = { folder: "inbox", statuses: [], attention: true, networks: [], unread: false, person: null };
/** A filter reset that shows everything (person page "Show in Messages", Clear filters). */
const SHOW_ALL: CommsFilters = { ...DEFAULT_FILTERS, attention: false };

/** Open a vault note conversation (MessageRenderer / EmailRenderer with the thread chrome). */
export type RenderNoteConversation = (args: { noteId: string; backLabel: string; onBack: () => void; thread?: CommsThread; onOpenContact?: (personId: string, name: string) => void }) => ReactNode;

type Detail =
  | { kind: "thread"; thread: CommsThread; from?: Detail }
  | { kind: "note"; noteId: string; thread?: CommsThread; from?: Detail }
  | { kind: "contact"; personId: string; name: string; from?: Detail };

const backLabelOf = (from?: Detail) => (from?.kind === "contact" ? `Back to ${from.name}` : "Back to messages");
const at = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};
const unreadOf = (t: CommsThread) => t.unread.count > 0;

export function CommsMessagesDashboard({
  scope,
  renderNoteConversation,
  renderEmailList,
}: {
  scope: string | null;
  renderNoteConversation: RenderNoteConversation;
  /** The email notes list (vault), which Comms does not carry yet. */
  renderEmailList: (args: { query: string; selectedId: string | null; onOpen: (noteId: string) => void }) => ReactNode;
}) {
  const vault = useVaultClient();
  const comms = vault.comms!;
  const [view, setView] = useState<"chats" | "people" | "email">("chats");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const [filters, setFilters] = useState<CommsFilters>(DEFAULT_FILTERS);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);

  const listQuery = useInfiniteQuery({
    queryKey: ["comms", "threads", scope, filters, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      comms.listThreads({
        // A person's chats span every folder (the server's rule); otherwise the chosen folder.
        ...(filters.person ? {} : { folder: filters.folder }),
        statuses: filters.statuses, attention: filters.attention, networks: filters.networks, unread: filters.unread,
        person: filters.person?.id, q, cursor: pageParam, limit: PAGE,
      }),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: useLivePollMs(30_000),
  });
  const countsQuery = useQuery({
    queryKey: ["comms", "status-counts", scope, filters.folder],
    queryFn: () => comms.statusCounts(filters.folder),
    retry: false,
    refetchInterval: useLivePollMs(30_000),
  });
  const peoplePage = usePeopleConversations(scope, search, view === "people");
  const threads = useMemo(() => listQuery.data?.pages.flatMap((p) => p.threads) ?? [], [listQuery.data]);
  // Networks to offer: those in the loaded rows plus any already chosen (a chosen one never vanishes).
  const networks = useMemo(() => [...new Set([...threads.flatMap((t) => t.networks), ...filters.networks])].sort(), [threads, filters.networks]);

  const pull = usePullToRefresh<HTMLDivElement>({
    label: "Messages",
    onRefresh: () => Promise.all([listQuery.refetch(), countsQuery.refetch()]).then((all) => {
      if (all.some((r) => r.isError)) throw new Error("refresh failed");
    }),
  });

  const openThread = (thread: CommsThread, from?: Detail) =>
    setDetail(thread.noteId ? { kind: "note", noteId: thread.noteId, thread, from } : { kind: "thread", thread, from });
  const openContact = (personId: string, name: string, from?: Detail) => setDetail({ kind: "contact", personId, name, from });
  const selectedThreadId = detail?.kind === "thread" ? detail.thread.id : null;
  const selectedNoteId = detail?.kind === "note" ? detail.noteId : null;
  const timelinePerson = view === "people" ? person : null;
  const set = (patch: Partial<CommsFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const counts = countsQuery.data?.counts ?? {};
  const anyStatus = filters.attention || filters.statuses.length > 0;
  const loaded = threads.length;

  return (
    <div className={`prism-messages-workspace prism-message-split h-full min-h-0 min-w-0 ${detail || timelinePerson ? "has-selection" : ""}`} data-source="comms">
      <div className="prism-messages-list flex min-h-0 min-w-0 flex-col" aria-label="Conversation list">
        <div className="prism-messages-heading">
          <div className="min-w-[120px] flex-1">
            <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Messages</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {view === "chats"
                ? `${loaded}${listQuery.hasNextPage ? "+" : ""} conversation${loaded === 1 ? "" : "s"}`
                : view === "people" && peoplePage.data ? `${peoplePage.data.total} people` : " "}
            </p>
          </div>
          <button type="button" className="focus-ring flex size-control flex-none items-center justify-center rounded-lg" aria-label="Refresh" title="Refresh" aria-busy={pull.refreshing || undefined} disabled={pull.refreshing} onClick={pull.refresh} style={{ color: "var(--text-secondary)" }}>
            <RefreshCw size={15} />
          </button>
          <div className="prism-message-views" role="group" aria-label="Inbox view">
            {([["chats", "Chats", MessageSquare], ["people", "People", Users], ["email", "Email", Mail]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} className="focus-ring">
                <Icon size={14} aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
          <div className="prism-message-search flex min-w-0 items-center gap-2 px-3 py-2">
            <Search size={13} style={{ color: "var(--text-muted)" }} />
            <input
              aria-label="Search inbox"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={view === "chats" ? "Search conversations…" : view === "people" ? "Search people…" : "Search email…"}
              className="bg-transparent text-base outline-none min-w-0 w-full"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
        </div>

        {view === "chats" && (
          <>
            <div className="prism-tabs prism-comms-folders" role="group" aria-label="Folders">
              {FOLDERS.map((f) => (
                <button key={f.id} type="button" className="prism-tab focus-ring" aria-pressed={!filters.person && filters.folder === f.id} onClick={() => set({ folder: f.id, person: null })}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="prism-triage-filters" role="group" aria-label="Filter by category">
              <button type="button" className="prism-triage-chip focus-ring" aria-pressed={!anyStatus} onClick={() => set({ statuses: [], attention: false })}>
                All
              </button>
              <button type="button" className="prism-triage-chip focus-ring" data-tone="danger" aria-pressed={filters.attention} onClick={() => set({ attention: !filters.attention })}>
                <span className="prism-status-dot" aria-hidden="true" />
                {NEEDS_ATTENTION_LABEL} <span className="prism-triage-count">{countsQuery.data?.attention ?? 0}</span>
              </button>
              {THREAD_STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0 || filters.statuses.includes(s)).map((s) => (
                <button key={s} type="button" className="prism-triage-chip focus-ring" data-tone={THREAD_STATUS_TONE[s]} aria-pressed={filters.statuses.includes(s)} onClick={() => set({ statuses: toggle(filters.statuses, s) })}>
                  <span className="prism-status-dot" aria-hidden="true" />
                  {THREAD_STATUS_LABELS[s]} <span className="prism-triage-count">{counts[s] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="prism-triage-filters prism-comms-network-filters" role="group" aria-label="Filter by network">
              <button type="button" className="prism-triage-chip focus-ring" aria-pressed={filters.unread} onClick={() => set({ unread: !filters.unread })}>
                Unread
              </button>
              {networks.map((n) => {
                const { label, color } = platformLabel(n);
                return (
                  <button key={n} type="button" className="prism-triage-chip focus-ring" aria-pressed={filters.networks.includes(n)} onClick={() => set({ networks: toggle(filters.networks, n) })}>
                    <span className="prism-status-dot" aria-hidden="true" style={{ background: color }} />
                    {label}
                  </button>
                );
              })}
              {filters.person && (
                <button type="button" className="prism-triage-chip focus-ring" aria-pressed="true" aria-label={`Showing conversations with ${filters.person.name}. Remove this filter`} onClick={() => set({ person: null })}>
                  <UserRound size={12} aria-hidden="true" /> With {filters.person.name} <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </>
        )}

        <div className="flex-1 min-h-0 overflow-auto" style={{ overflowX: "hidden" }} ref={pull.ref} data-testid="messages-scroller">
          {pull.indicator}
          {view === "chats" ? (
            listQuery.isPending ? (
              <div className="flex justify-center py-10"><Spinner size={20} /></div>
            ) : listQuery.isError && !threads.length ? (
              <div role="alert" className="prism-triage-hint">
                <p>Conversations couldn’t be loaded from the server.</p>
                <button type="button" className="prism-triage-show-all focus-ring" onClick={() => void listQuery.refetch()}>Try again</button>
              </div>
            ) : threads.length === 0 ? (
              <div className="prism-triage-hint">
                <p role="status">
                  {filters.attention && !filters.statuses.length && !filters.networks.length && !filters.unread && !filters.person
                    ? q ? "Nothing that needs your attention matches this search." : "Nothing needs your attention right now."
                    : q || anyStatus || filters.networks.length || filters.unread || filters.person
                      ? "No conversations match these filters."
                      : `Nothing in ${FOLDERS.find((f) => f.id === filters.folder)?.label ?? "this folder"}.`}
                </p>
                {(anyStatus || filters.networks.length > 0 || filters.unread || filters.person) && (
                  <button type="button" className="prism-triage-show-all focus-ring" onClick={() => setFilters({ ...SHOW_ALL, folder: filters.folder })}>Show all</button>
                )}
              </div>
            ) : (
              <>
                {threads.map((t) => (
                  <CommsThreadRow key={t.id} thread={t} selected={t.id === selectedThreadId || (!!t.noteId && t.noteId === selectedNoteId)} onOpen={() => openThread(t)} />
                ))}
                {listQuery.hasNextPage && (
                  <button type="button" className="prism-earlier-messages block mx-auto my-3 text-xs" disabled={listQuery.isFetchingNextPage} onClick={() => void listQuery.fetchNextPage()}>
                    {listQuery.isFetchingNextPage ? "Loading…" : "Load more conversations"}
                  </button>
                )}
                {listQuery.isError && <p role="alert" className="prism-triage-hint">The list couldn’t be refreshed. Showing what was loaded.</p>}
              </>
            )
          ) : view === "people" ? (
            <PeopleConversationList
              page={peoplePage.data}
              loading={peoplePage.isPending}
              failed={peoplePage.isError}
              onRetry={() => void peoplePage.refetch()}
              query={search}
              selectedId={person?.id ?? null}
              onSelect={(p) => { setDetail(null); setPerson({ id: p.id, name: p.name }); }}
            />
          ) : (
            renderEmailList({ query: search, selectedId: selectedNoteId, onOpen: (noteId) => setDetail({ kind: "note", noteId }) })
          )}
        </div>
      </div>

      <section className="prism-messages-detail flex min-h-0 min-w-0 flex-col" aria-label="Selected conversation">
        {detail?.kind === "note" ? (
          renderNoteConversation({
            noteId: detail.noteId,
            backLabel: backLabelOf(detail.from) === "Back to messages" && timelinePerson ? `Back to ${timelinePerson.name}` : backLabelOf(detail.from),
            onBack: () => setDetail(detail.from ?? null),
            // The row it was opened from, kept even when a filter or search drops it from the list
            // (otherwise the conversation would remount and lose its place).
            thread: threads.find((t) => t.noteId === detail.noteId) ?? detail.thread,
            onOpenContact: (id, name) => openContact(id, name, detail),
          })
        ) : detail?.kind === "thread" ? (
          <CommsConversation
            key={detail.thread.id}
            thread={detail.thread}
            scope={scope}
            backLabel={backLabelOf(detail.from)}
            onBack={() => setDetail(detail.from ?? null)}
            onOpenContact={(id, name) => openContact(id, name, detail)}
          />
        ) : detail?.kind === "contact" ? (
          <CommsContactPage
            key={detail.personId}
            personId={detail.personId}
            fallbackName={detail.name}
            scope={scope}
            backLabel={backLabelOf(detail.from) === "Back to messages" && detail.from ? "Back to conversation" : backLabelOf(detail.from)}
            onBack={() => setDetail(detail.from ?? null)}
            onOpenThread={(t) => openThread(t, detail)}
            onFilter={(p) => { setView("chats"); setFilters({ ...SHOW_ALL, person: p }); }}
          />
        ) : timelinePerson ? (
          <PersonTimeline
            key={timelinePerson.id}
            personId={timelinePerson.id}
            name={timelinePerson.name}
            scope={scope}
            onBack={() => setPerson(null)}
            onOpen={(item: PersonConversationItem) => {
              if (item.kind === "meeting") useUIStore.getState().openTab(item.id, item.title, "meeting" as ContentType);
              else setDetail({ kind: "note", noteId: item.id });
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-[var(--text-muted)]">
            <MessageSquare size={32} strokeWidth={1.4} />
            <h2 className="text-base font-medium text-[var(--text-secondary)]">Choose a conversation</h2>
            <p className="max-w-xs text-sm leading-relaxed">Messages, people, and the context you share — together in one place.</p>
          </div>
        )}
      </section>
    </div>
  );
}

/** One list row: avatar, name, unread, time, one-line preview, status and where it lives. */
export function CommsThreadRow({ thread: t, selected, onOpen }: { thread: CommsThread; selected: boolean; onOpen: () => void }) {
  const unread = unreadOf(t);
  const when = at(t.lastActivityAt);
  const preview = t.lastMessage ? `${t.lastMessage.isSelf ? "You: " : ""}${t.lastMessage.text}` : "";
  return (
    <button type="button" onClick={onOpen} className="prism-message-row flex items-start gap-3 text-left" aria-current={selected ? "true" : undefined} data-unread={unread || undefined} data-thread-id={t.id}>
      <CommsAvatar avatar={t.avatar} name={t.title} identity={t.id} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="prism-row-name truncate">{t.title}</span>
          {t.pinned && <Pin size={11} className="shrink-0" aria-label="Pinned" />}
          {t.muted && <BellOff size={11} className="shrink-0" aria-label="Muted" />}
          {unread && <span className="prism-unread-dot" role="img" aria-label="Unread" />}
          {when ? <span className="prism-row-time ml-auto shrink-0">{messageWhen(when)}</span> : null}
        </div>
        {preview && <div className="prism-message-preview truncate">{preview}</div>}
        <div className="prism-person-sources">
          <StatusChip status={t.status} />
          {t.networks.map((n) => <SourceBadge key={n} platform={n} />)}
          {t.kind === "group" && <span className="prism-row-count">Group</span>}
        </div>
      </div>
    </button>
  );
}

/** A Comms conversation with no vault note behind it (e.g. iMessage): header + transcript, read-only. */
function CommsConversation({ thread, scope, backLabel, onBack, onOpenContact }: { thread: CommsThread; scope: string | null; backLabel: string; onBack: () => void; onOpenContact: (personId: string, name: string) => void }) {
  return (
    <ConversationChromeProvider value={{ onBack, backLabel }}>
      <div className="prism-conversation flex flex-col h-full min-h-0">
        <CommsConversationHeader thread={thread} onOpenContact={onOpenContact} />
        <CommsTranscript thread={thread} scope={scope} onOpenPerson={onOpenContact} />
        <p className="prism-comms-note" role="status">Replying to this conversation is available in the Comms app.</p>
      </div>
    </ConversationChromeProvider>
  );
}

export function CommsConversationHeader({ thread, onOpenContact, children }: { thread: CommsThread; onOpenContact?: (personId: string, name: string) => void; children?: ReactNode }) {
  const personId = thread.kind === "dm" ? thread.personId : undefined;
  return (
    <header className="prism-conversation-heading">
      <ConversationBack />
      <CommsAvatar avatar={thread.avatar} name={thread.title} identity={thread.id} size={36} />
      <div className="prism-conversation-title">
        <h2>{thread.title}</h2>
        <div className="prism-conversation-meta">
          {thread.networks.map((n) => <SourceBadge key={n} platform={n} />)}
          {thread.kind === "group" && <span className="prism-conversation-state">Group</span>}
          {personId && onOpenContact && (
            <button type="button" className="prism-thread-view-toggle focus-ring" onClick={() => onOpenContact(personId, thread.title)}>
              Contact
            </button>
          )}
          {children}
        </div>
      </div>
    </header>
  );
}

/** A person: their contact details and every chat with them (Comms `GET /people/:id`). */
function CommsContactPage({ personId, fallbackName, scope, backLabel, onBack, onOpenThread, onFilter }: {
  personId: string; fallbackName: string; scope: string | null; backLabel: string; onBack: () => void;
  onOpenThread: (t: CommsThread) => void; onFilter: (p: { id: string; name: string }) => void;
}) {
  const vault = useVaultClient();
  const query = useQuery({ queryKey: ["comms", "person", scope, personId], queryFn: () => vault.comms!.getPerson(personId), retry: false });
  const p: CommsPerson | undefined = query.data;
  const name = p?.name || fallbackName;
  return (
    <ConversationChromeProvider value={{ onBack, backLabel }}>
      <div className="prism-conversation flex flex-col h-full min-h-0">
        <header className="prism-conversation-heading">
          <ConversationBack />
          <CommsAvatar avatar={p?.avatar} name={name} identity={personId} size={36} />
          <div className="prism-conversation-title">
            <h2>{name}</h2>
            <div className="prism-conversation-meta"><span className="prism-conversation-state">Contact</span></div>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto prism-comms-contact">
          {query.isPending ? (
            <p role="status" className="prism-comms-note">Loading contact…</p>
          ) : query.isError || !p ? (
            <div role="alert" className="prism-comms-note">
              This contact couldn’t be loaded.{" "}
              <button type="button" className="underline focus-ring" onClick={() => void query.refetch()}>Try again</button>
            </div>
          ) : (
            <>
              <dl className="prism-comms-contact-facts">
                {p.phones.map((x) => <Fact key={`p${x.value}`} label={x.label ? `Phone · ${x.label}` : "Phone"} value={x.value} />)}
                {p.emails.map((x) => <Fact key={`e${x.value}`} label="Email" value={x.value} />)}
                {p.handles.filter((h) => h.kind !== "phone").map((h) => <Fact key={`h${h.network}${h.value}`} label={platformLabel(h.network).label} value={h.value} />)}
                {!p.phones.length && !p.emails.length && !p.handles.length && <p className="prism-comms-note">No phone, email or handle on file.</p>}
              </dl>
              <div className="prism-comms-contact-actions">
                <button type="button" className="prism-people-action prism-comms-action focus-ring" onClick={() => useUIStore.getState().openTab(`people:${p.id}`, name, "people" as ContentType)}>
                  <UserRound size={14} aria-hidden="true" /> Open person page
                </button>
                <button type="button" className="prism-people-action prism-comms-action focus-ring" onClick={() => onFilter({ id: p.id, name })}>
                  <Inbox size={14} aria-hidden="true" /> Show in Messages
                </button>
              </div>
              <h3 className="prism-comms-section">Shared chats <span className="prism-triage-count">{p.threads.length}</span></h3>
              {p.threads.length ? (
                p.threads.map((t) => <CommsThreadRow key={t.id} thread={t} selected={false} onOpen={() => onOpenThread(t)} />)
              ) : (
                <p className="prism-comms-note">No chats with {name} yet.</p>
              )}
            </>
          )}
        </div>
      </div>
    </ConversationChromeProvider>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="prism-comms-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

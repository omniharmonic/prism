/**
 * Messages → People, over the server's read-time resolution
 * (`GET /api/people/conversations`, `GET /api/people/:id/conversations`).
 *
 * A person's conversations are found by the addresses and handles on their
 * person page — no stored link is needed and a name alone never matches. The
 * list shows who has conversations (most recent first); selecting someone shows
 * ONE timeline across email, every chat network and meetings, each item badged
 * with where it came from and opening the real thread.
 *
 * Nothing here is ever a silent empty list: a person without an address or
 * handle on file is told so, with the way to add one.
 */
import { Fragment, type CSSProperties } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, Mail, MessageSquare, UserRound, Users } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import type { PeopleConversationsPage, PersonConversationItem, PersonConversationRow } from "../../data/VaultClient";
import { useUIStore } from "../../app/stores/ui";
import { getPlatformConfig } from "../../lib/matrix/bridge-map";
import { formatDate as fmtDate, formatRelativeDate, formatTime as fmtTime, relativeDay } from "../../lib/datetime/format";
import type { ContentType } from "../../lib/types";
import { Spinner } from "../ui/Spinner";
import { messageColor, messageInitials } from "./messageAppearance";

/** Where a conversation came from: a coloured dot + a name in ordinary text colour (never colour alone). */
export function platformLabel(platform: string): { label: string; color: string } {
  if (platform === "meeting") return { label: "Meeting", color: "var(--text-muted)" };
  const config = getPlatformConfig(platform);
  return { label: config.label, color: config.color };
}
export function SourceBadge({ platform }: { platform: string }) {
  const { label, color } = platformLabel(platform);
  return (
    <span className="prism-source-badge" data-platform={platform}>
      <span aria-hidden="true" className="prism-source-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

/** List time, as the mockups have it: a time today, "Yesterday", else a short date. */
export function messageWhen(at: number): string {
  if (!at) return "";
  return relativeDay(at) === "Today" ? fmtTime(at, { hour: "numeric", minute: "2-digit" }) : formatRelativeDate(at);
}
const dayHeading = (at: number): string =>
  at ? fmtDate(at, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "Date unavailable";
const dayKey = (at: number): string => (at ? new Date(at).toDateString() : "unknown");
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const openPerson = (id: string, name: string) => useUIStore.getState().openTab(`people:${id}`, name, "people" as ContentType);
const openPeople = () => useUIStore.getState().openTab("people", "People", "people" as ContentType);

export function usePeopleConversations(scope: string | null, query: string, enabled: boolean) {
  const vault = useVaultClient();
  const q = query.trim();
  return useQuery<PeopleConversationsPage>({
    queryKey: ["vault", "inbox", scope, "people-conversations", q],
    queryFn: () => vault.listPeopleConversations!(q),
    enabled: enabled && !!vault.listPeopleConversations,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function PeopleConversationList({
  page, loading, failed, onRetry, query, selectedId, onSelect,
}: {
  page: PeopleConversationsPage | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  query: string;
  selectedId: string | null;
  onSelect: (person: PersonConversationRow) => void;
}) {
  if (failed)
    return (
      <div role="alert" className="prism-people-note">
        <p>People couldn’t be loaded. Your conversations are still in the other views.</p>
        <button type="button" className="prism-people-action focus-ring" onClick={onRetry}>Try again</button>
      </div>
    );
  if (loading || !page)
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Loading people">
        <Spinner size={20} />
      </div>
    );
  if (!page.people.length) {
    const q = query.trim();
    return (
      <div className="prism-people-note" data-testid="people-empty">
        <Users size={22} aria-hidden="true" />
        {q ? (
          <p>No person matches “{q}”.</p>
        ) : (
          <>
            <h2>No conversations are matched to a person yet</h2>
            <p>
              Prism finds someone’s email, chats and meetings by the addresses and handles on their person page — never by name alone.
              {page.withoutIdentity > 0 && ` ${plural(page.withoutIdentity, "person")} ${page.withoutIdentity === 1 ? "has" : "have"} no email or handle on file.`}
            </p>
            <button type="button" className="prism-people-action focus-ring" onClick={openPeople}>Open People to add one</button>
          </>
        )}
      </div>
    );
  }
  return (
    <>
    <ul className="prism-people-list" aria-label="People with conversations">
      {page.people.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className="prism-message-row prism-person-row flex items-center gap-3 text-left"
            aria-current={selectedId === p.id ? "true" : undefined}
            data-person-id={p.id}
            data-unread={p.unread > 0 || undefined}
            onClick={() => onSelect(p)}
          >
            <span aria-hidden="true" className="prism-message-avatar" style={{ "--avatar-tone": messageColor(p.id) } as CSSProperties}>
              {messageInitials(p.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="prism-row-name truncate">{p.name}</span>
                {p.unread > 0 && <span className="prism-unread-dot" role="img" aria-label={`${p.unread} unread`} />}
                <span className="prism-row-time ml-auto shrink-0">{messageWhen(p.lastMessageAt)}</span>
              </span>
              <span className="prism-person-sources">
                {p.count > 0 ? (
                  <>
                    {p.platforms.map((platform) => <SourceBadge key={platform} platform={platform} />)}
                    <span className="prism-row-count">{plural(p.count, "conversation")}</span>
                  </>
                ) : (
                  <span className="prism-row-count">{p.hasIdentity ? "No conversations found" : "No email or handle on file"}</span>
                )}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
    {(page.truncated || page.limited) && (
      <p className="prism-people-footnote" role="note">
        {page.truncated ? "Showing the most recent people. Search to find someone else." : "Older conversations may not be counted."}
      </p>
    )}
    </>
  );
}

const kindIcon = { email: Mail, chat: MessageSquare, meeting: CalendarDays };

export function PersonTimeline({
  personId, name, scope, onBack, onOpen,
}: {
  personId: string;
  name: string;
  scope: string | null;
  onBack: () => void;
  onOpen: (item: PersonConversationItem) => void;
}) {
  const vault = useVaultClient();
  const result = useQuery({
    queryKey: ["vault", "inbox", scope, "person-conversations", personId],
    queryFn: () => vault.getPersonConversations!(personId),
    staleTime: 30_000,
    retry: false,
  });
  const person = result.data?.person;
  const items = result.data?.items ?? [];
  const shown = person?.name ?? name;
  return (
    <div className="prism-conversation flex h-full min-h-0 flex-col" data-testid="person-timeline">
      <header className="prism-conversation-heading">
        <button type="button" className="prism-conversation-action focus-ring" aria-label="Back to people" title="Back to people" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div aria-hidden="true" className="prism-message-avatar" style={{ "--avatar-tone": messageColor(personId) } as CSSProperties}>
          {messageInitials(shown)}
        </div>
        <div className="prism-conversation-title">
          <h2>{shown}</h2>
          <div className="prism-conversation-meta">
            {person ? (
              person.count > 0 ? (
                <>
                  <span>{plural(person.count, "conversation")}</span>
                  {person.platforms.map((platform) => <SourceBadge key={platform} platform={platform} />)}
                </>
              ) : (
                <span>No conversations</span>
              )
            ) : (
              <span>{result.isError ? "Unavailable" : "Loading…"}</span>
            )}
          </div>
        </div>
        <button type="button" className="prism-conversation-action focus-ring" aria-label="Open person page" title="Open person page" onClick={() => openPerson(person?.id ?? personId, shown)}>
          <UserRound size={18} aria-hidden="true" />
        </button>
      </header>
      {result.isPending ? (
        <p role="status" className="p-6 text-sm text-[var(--text-muted)]">Gathering conversations…</p>
      ) : result.isError || !person ? (
        <div role="alert" className="prism-people-note">
          <p>This person’s conversations couldn’t be loaded.</p>
          <button type="button" className="prism-people-action focus-ring" onClick={() => void result.refetch()}>Try again</button>
        </div>
      ) : !items.length ? (
        <div className="prism-people-note" data-testid="person-unlinked">
          <UserRound size={22} aria-hidden="true" />
          {person.hasIdentity ? (
            <>
              <h3>No conversations found for {person.name}</h3>
              <p>None of your mail, chats or meetings carries an address or handle from this person’s page. If they write from another address, add it there.</p>
              <button type="button" className="prism-people-action focus-ring" onClick={() => openPerson(person.id, person.name)}>Open person page</button>
            </>
          ) : (
            <>
              <h3>{person.name} has no email or handle on file</h3>
              <p>Prism matches conversations by email address or chat handle — never by name alone, so two people with the same name are never mixed up.</p>
              <button type="button" className="prism-people-action prism-people-primary focus-ring" onClick={() => openPerson(person.id, person.name)}>Add an email or handle</button>
            </>
          )}
        </div>
      ) : (
        <div className="prism-thread-content prism-person-timeline min-h-0 flex-1 overflow-auto" role="region" aria-label={`Conversations with ${person.name}`} tabIndex={0}>
          <div className="prism-timeline">
            {items.map((item, index) => {
              const Icon = kindIcon[item.kind] ?? MessageSquare;
              const newDay = index === 0 || dayKey(items[index - 1]!.at) !== dayKey(item.at);
              return (
                <Fragment key={item.id}>
                  {newDay && (
                    <div role="separator" aria-label={dayHeading(item.at)} className="prism-day-separator">
                      <span>{dayHeading(item.at)}</span>
                    </div>
                  )}
                    <button type="button" className="prism-timeline-item focus-ring" data-kind={item.kind} data-platform={item.platform} data-unread={item.unread || undefined} onClick={() => onOpen(item)}>
                      <span className="prism-timeline-icon" aria-hidden="true"><Icon size={15} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="prism-row-name block truncate">{item.title}</span>
                        <span className="prism-person-sources">
                          <SourceBadge platform={item.platform} />
                          {item.members !== undefined && item.members > 2 && <span className="prism-row-count">Group · {item.members}</span>}
                          {item.unread && <span className="prism-row-count">Unread</span>}
                        </span>
                      </span>
                      <time className="prism-row-time shrink-0" dateTime={item.at ? new Date(item.at).toISOString() : undefined}>
                        {item.at ? fmtTime(item.at, { hour: "numeric", minute: "2-digit" }) : ""}
                      </time>
                    </button>
                </Fragment>
              );
            })}
          </div>
          {(result.data?.next != null || result.data?.limited) && (
            <p className="prism-people-footnote" role="note">
              {result.data?.next != null ? "Showing the 100 most recent conversations." : "Older conversations may be missing."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

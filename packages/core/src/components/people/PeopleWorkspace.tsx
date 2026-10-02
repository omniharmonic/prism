import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Search,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  FileText,
  Mail,
  MessageSquare,
  Users,
} from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { RendererProps } from "../renderers/RendererProps";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";
import "./people-workspace.css";
import type { PersonSummary } from "../../data/VaultClient";

const control =
  "focus-ring min-h-11 rounded-lg border border-[var(--glass-border)] px-3 text-sm hover:bg-[var(--glass-hover)] disabled:opacity-50";
const labels = {
  conversations: "Conversations",
  meetings: "Meetings",
  tasks: "Tasks",
  notes: "Notes",
};
type Category = keyof typeof labels;
function Initials({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toLocaleUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`prism-person-avatar${large ? " is-large" : ""}`}
    >
      {initials || "?"}
    </span>
  );
}
function Identity({ person }: { person: PersonSummary }) {
  return (
    <div className="prism-person-identity">
      <Initials name={person.name} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{person.name}</span>
        <span className="block truncate text-xs text-[var(--text-secondary)]">
          {person.role ||
            person.identities[0]?.value ||
            person.path ||
            "Person note"}
        </span>
      </span>
    </div>
  );
}
const recordIcons = {
  conversations: MessageSquare,
  meetings: CalendarDays,
  tasks: CheckSquare,
  notes: FileText,
};
export default function PeopleWorkspace(props: RendererProps) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  return (
    <PeopleView
      key={JSON.stringify([scope, props.note.id])}
      id={props.note.id.startsWith("people:") ? props.note.id.slice(7) : null}
      scope={scope}
    />
  );
}
function PeopleView({
  id: initialId,
  scope,
}: {
  id: string | null;
  scope: string | null;
}) {
  const client = useVaultClient();
  const openTab = useUIStore((s) => s.openTab);
  const [id, setId] = useState(initialId);
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const profileHeading = useRef<HTMLHeadingElement | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const current = () =>
    (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  const directory = useInfiniteQuery({
    queryKey: ["vault", "people", scope, query],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!current()) throw Error("Workspace changed");
      const page = await client.listPeople!(query, pageParam);
      if (!current()) throw Error("Workspace changed");
      return page;
    },
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: !!client.listPeople,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const profile = useInfiniteQuery({
    queryKey: ["vault", "person", scope, id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!current()) throw Error("Workspace changed");
      const page = await client.getPerson!(id!, pageParam);
      if (!current()) throw Error("Workspace changed");
      return page;
    },
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: !!id && !!client.getPerson,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const directoryReady = !directory.isFetching || directory.isFetchingNextPage;
  const profileReady =
    (!profile.isFetching || profile.isFetchingNextPage) &&
    !profile.isError &&
    current();
  const person = profileReady ? profile.data?.pages[0]?.person : undefined;
  const people =
    directoryReady && !directory.isError && current() && query === search.trim()
      ? [
          ...new Map(
            directory.data?.pages
              .flatMap((p) => p.people)
              .map((p) => [p.id, p]),
          ).values(),
        ]
      : [];
  const records = profileReady
    ? [
        ...new Map(
          profile.data?.pages.flatMap((p) => p.related).map((p) => [p.id, p]),
        ).values(),
      ]
    : [];
  function selectPerson(personId: string, target: HTMLButtonElement) {
    target.focus({ preventScroll: true });
    returnTarget.current = target;
    setError("");
    setCategory("all");
    setId(personId);
  }
  function back() {
    setId(null);
    setError("");
    requestAnimationFrame(() =>
      returnTarget.current?.focus({ preventScroll: true }),
    );
  }
  useEffect(() => {
    if (person) profileHeading.current?.focus({ preventScroll: true });
  }, [person?.id]);
  async function openNote(noteId: string) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      const note = await client.getNote(noteId);
      if (current())
        openTab(
          note.id,
          (typeof note.metadata?.title === "string" && note.metadata.title) ||
            note.path?.split("/").pop() ||
            "Untitled",
          inferContentType(note),
        );
    } catch {
      if (current())
        setError(
          "This note is unavailable or your access has changed. Refresh to check it again.",
        );
    } finally {
      if (current()) setOpening(false);
    }
  }
  if (!client.listPeople || !client.getPerson)
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">People</h1>
        <p className="mt-3 text-sm">
          People requires a connected Prism Server. Your person notes remain
          available in Files.
        </p>
      </div>
    );
  return (
    <section aria-label="People workspace" className="prism-people-workspace">
      <div className={`prism-people-layout${id ? " has-selection" : ""}`}>
        <aside className="prism-people-directory" aria-label="People directory">
          <header>
            <h1>People</h1>
            <p>Conversations and work, connected.</p>
          </header>
          <label className="prism-people-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Find people</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a person…"
            />
          </label>
          <div className="prism-people-list">
            {(!directoryReady || query !== search.trim()) && (
              <p role="status" className="prism-people-empty">
                Loading people…
              </p>
            )}
            {directory.isError && (
              <div role="alert" className="prism-people-empty">
                People could not be loaded.
                <button
                  className={control}
                  onClick={() => void directory.refetch()}
                >
                  Try again
                </button>
              </div>
            )}
            {people.map((p) => (
              <button
                key={p.id}
                aria-pressed={id === p.id}
                className="focus-ring prism-people-row"
                onClick={(e) => selectPerson(p.id, e.currentTarget)}
              >
                <Identity person={p} />
              </button>
            ))}
            {directoryReady &&
              !directory.isError &&
              query === search.trim() &&
              !people.length && (
                <div className="prism-people-empty">
                  <Users size={24} aria-hidden="true" />
                  <h2>
                    {query ? "No matching people" : "Your people start here"}
                  </h2>
                  <p>
                    {query
                      ? "Try another name or account identifier."
                      : "Notes tagged person appear here."}
                  </p>
                </div>
              )}
            {directoryReady && !directory.isError && directory.hasNextPage && (
              <button
                className={control + " mt-4"}
                disabled={directory.isFetchingNextPage}
                onClick={() => void directory.fetchNextPage()}
              >
                {directory.isFetchingNextPage ? "Loading…" : "Load more people"}
              </button>
            )}
          </div>
          <p className="prism-people-identity-note">
            <Users size={16} aria-hidden="true" />
            <span>
              Accounts identify people.
              <br />
              <span>
                Matching names alone never combine people. Unmatched
                participants stay unlinked.
              </span>
            </span>
          </p>
        </aside>
        <div className="prism-people-profile">
          {!id ? (
            <div className="prism-people-welcome">
              <Users size={32} aria-hidden="true" />
              <h2>People, in context</h2>
              <p>
                Select a person to explore their linked conversations, meetings,
                and work.
              </p>
            </div>
          ) : (
            <>
              <button className="focus-ring prism-people-back" onClick={back}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back to People
              </button>
              {profile.isFetching && !profile.isFetchingNextPage && (
                <p role="status" className="prism-people-empty">
                  Loading person…
                </p>
              )}
              {profile.isError && (
                <div role="alert" className="prism-people-empty">
                  This person is unavailable or could not be loaded.
                  <button
                    className={control}
                    onClick={() => void profile.refetch()}
                  >
                    Try again
                  </button>
                </div>
              )}
              {error && (
                <p
                  role="alert"
                  className="mb-4 text-sm text-[var(--color-error)]"
                >
                  {error}
                </p>
              )}
              {person && (
                <>
                  <header className="prism-person-heading">
                    <Initials name={person.name} large />
                    <div className="min-w-0">
                      <h2 tabIndex={-1} ref={profileHeading}>
                        {person.name}
                      </h2>
                      <p>{person.role || "Person note"}</p>
                    </div>
                  </header>
                  <details open className="prism-person-properties">
                    <summary className="focus-ring">Properties</summary>
                    <div className="prism-person-property">
                      <span>Linked identities</span>
                      <dl>
                        {person.identities.length ? (
                          person.identities.map((identity) => (
                            <div key={`${identity.kind}:${identity.value}`}>
                              <dt>
                                {identity.kind === "email" ? (
                                  <Mail size={16} aria-hidden="true" />
                                ) : (
                                  <MessageSquare size={16} aria-hidden="true" />
                                )}
                                <span>{identity.kind}</span>
                              </dt>
                              <dd>{identity.value}</dd>
                            </div>
                          ))
                        ) : (
                          <p>No linked accounts on this person note.</p>
                        )}
                      </dl>
                    </div>
                    <div className="prism-person-property">
                      <span>Person note</span>
                      <button
                        disabled={opening}
                        className="focus-ring prism-people-link"
                        onClick={() => void openNote(person.id)}
                      >
                        <FileText size={16} aria-hidden="true" />
                        Open person note
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                    {person.canManageIdentities &&
                      person.updatedAt &&
                      client.changePersonIdentity && (
                        <IdentityControls
                          key={person.id}
                          person={person}
                          scope={scope}
                        />
                      )}
                  </details>
                  <nav
                    aria-label="Related records"
                    className="prism-person-categories"
                  >
                    {(
                      ["all", ...Object.keys(labels)] as Array<Category | "all">
                    ).map((value) => (
                      <button
                        key={value}
                        aria-pressed={category === value}
                        className="focus-ring"
                        onClick={() => setCategory(value)}
                      >
                        {value === "all" ? "All records" : labels[value]}
                      </button>
                    ))}
                  </nav>
                  <div className="prism-person-records">
                    {records
                      .filter(
                        (r) => category === "all" || r.category === category,
                      )
                      .map((record) => {
                        const Icon = recordIcons[record.category];
                        return (
                          <button
                            disabled={opening}
                            key={record.id}
                            className="focus-ring prism-person-record"
                            onClick={() => void openNote(record.id)}
                          >
                            <span className="prism-person-record-icon">
                              <Icon size={20} aria-hidden="true" />
                            </span>
                            <span className="min-w-0">
                              <span className="prism-person-record-title">
                                {record.title}
                              </span>
                              <span className="prism-person-record-meta">
                                {labels[record.category]}
                                {record.relationships.length
                                  ? ` · ${record.relationships.map((value) => value.replace(/[_-]+/g, " ")).join(", ")}`
                                  : ""}
                              </span>
                              {record.path && (
                                <span className="prism-person-record-path">
                                  {record.path}
                                </span>
                              )}
                            </span>
                            <ChevronRight size={17} aria-hidden="true" />
                          </button>
                        );
                      })}
                    {!records.some(
                      (r) => category === "all" || r.category === category,
                    ) && (
                      <p className="prism-people-empty">
                        No linked {category === "all" ? "records" : category} in
                        the loaded records. Link notes to this person to connect
                        them here.
                      </p>
                    )}
                  </div>
                  {profile.hasNextPage && (
                    <button
                      className={control + " mt-5"}
                      disabled={profile.isFetchingNextPage}
                      onClick={() => void profile.fetchNextPage()}
                    >
                      {profile.isFetchingNextPage
                        ? "Loading…"
                        : "Load more records"}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function IdentityControls({
  person,
  scope,
}: {
  person: PersonSummary;
  scope: string | null;
}) {
  const client = useVaultClient();
  const queries = useQueryClient();
  const draft = useScopedDraft("people", scope, `identity:${person.id}`);
  let fields: { kind: "email" | "matrix"; value: string } = {
    kind: "email",
    value: "",
  };
  try {
    const saved = JSON.parse(draft.text);
    if (
      (saved.kind === "email" || saved.kind === "matrix") &&
      typeof saved.value === "string"
    )
      fields = saved;
  } catch {
    /* new draft */
  }
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const current = () =>
    (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  const saveDraft = (next: typeof fields) =>
    draft.setText(JSON.stringify(next));
  async function change(
    kind: "email" | "matrix",
    value: string,
    action: "add" | "remove",
  ) {
    if (lock.current || !current() || !person.updatedAt) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const submittedDraft = draft.text;
    try {
      await client.changePersonIdentity!(person.id, {
        kind,
        value,
        action,
        ifUpdatedAt: person.updatedAt,
      });
      if (!current()) return;
      if (action === "add") draft.clearIfUnchanged(submittedDraft);
      await queries.invalidateQueries({
        queryKey: ["vault", "person", scope, person.id],
      });
      await queries.invalidateQueries({ queryKey: ["vault", "people", scope] });
    } catch (e) {
      if (current())
        setError(
          e instanceof Error
            ? e.message
            : "Couldn't update this account. Reload the profile to check it.",
        );
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <details className="mt-5 border-t border-[var(--glass-border)] pt-4">
      <summary className="focus-ring min-h-11 cursor-pointer py-2 text-sm font-medium">
        Manage accounts
      </summary>
      <p className="mb-4 text-xs text-[var(--text-secondary)]">
        An exact email or Matrix account identifies this person during future
        imports. Changes are recorded on their note. Existing conversations are
        not reassigned.
      </p>
      {draft.error && (
        <p role="status" className="mb-3 text-sm">
          {draft.error}
        </p>
      )}
      {error && (
        <div role="alert" className="mb-3 text-sm">
          {error}{" "}
          <button
            type="button"
            className={control + " mt-2"}
            disabled={busy}
            onClick={() =>
              void queries.invalidateQueries({
                queryKey: ["vault", "person", scope, person.id],
              })
            }
          >
            Reload profile
          </button>
        </div>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void change(fields.kind, fields.value, "add");
          }}
          className="flex flex-wrap gap-2"
        >
          <select
            aria-label="Account type"
            value={fields.kind}
            onChange={(e) =>
              saveDraft({
                ...fields,
                kind: e.target.value as "email" | "matrix",
              })
            }
            className={control}
          >
            <option value="email">Email</option>
            <option value="matrix">Matrix</option>
          </select>
          <input
            aria-label="Account identifier"
            required
            value={fields.value}
            onChange={(e) => saveDraft({ ...fields, value: e.target.value })}
            placeholder={
              fields.kind === "email" ? "name@example.com" : "@name:server.org"
            }
            className={control + " min-w-0 flex-1 bg-[var(--bg-surface)]"}
          />
          <button
            type="submit"
            disabled={!fields.value.trim()}
            className={control}
          >
            {busy ? "Saving…" : "Add account"}
          </button>
        </form>
        {person.identities
          .filter((i) => i.kind === "email" || i.kind === "matrix")
          .map((i) => (
            <div
              className="flex min-w-0 items-center justify-between gap-3 text-xs"
              key={`${i.kind}:${i.value}`}
            >
              <span className="break-all">{i.value}</span>
              <button
                type="button"
                className={control + " shrink-0"}
                aria-label={`Remove account ${i.value}`}
                onClick={() =>
                  void change(i.kind as "email" | "matrix", i.value, "remove")
                }
              >
                Remove
              </button>
            </div>
          ))}
      </fieldset>
    </details>
  );
}

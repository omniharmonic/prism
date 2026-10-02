import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Search,
  UserRound,
  Users,
} from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { ContentType } from "../../lib/types";
import type { RendererProps } from "../renderers/RendererProps";
import { useScopedDraft } from "../../lib/drafts/useScopedDraft";
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
function Identity({ person }: { person: PersonSummary }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--glass-hover)]">
        <UserRound size={20} />
      </span>
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
  id,
  scope,
}: {
  id: string | null;
  scope: string | null;
}) {
  const client = useVaultClient();
  const openTab = useUIStore((s) => s.openTab);
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
    enabled: !id && !!client.listPeople,
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
  const data = id ? profile : directory;
  const refreshing = data.isFetching && !data.isFetchingNextPage;
  const ready = !refreshing && !data.isError && current();
  const person = ready ? profile.data?.pages[0]?.person : undefined;
  const people =
    ready && query === search.trim()
      ? [
          ...new Map(
            directory.data?.pages
              .flatMap((p) => p.people)
              .map((p) => [p.id, p]),
          ).values(),
        ]
      : [];
  const records = ready
    ? [
        ...new Map(
          profile.data?.pages.flatMap((p) => p.related).map((p) => [p.id, p]),
        ).values(),
      ]
    : [];
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
    <section
      aria-label="People workspace"
      className="mx-auto min-h-full max-w-5xl px-5 py-6 pb-28 text-[var(--text-primary)] sm:px-8"
    >
      <header className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">
            Workspace / People
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {id ? (person?.name ?? "Person") : "People"}
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--text-secondary)]">
            {id
              ? "Conversations and work connected to this person’s canonical note."
              : "One place for the people behind your conversations, meetings, and ideas."}
          </p>
        </div>
        {id && (
          <button
            className={control}
            onClick={() => openTab("people", "People", "people" as ContentType)}
          >
            <ArrowLeft size={15} className="mr-2 inline" />
            All people
          </button>
        )}
      </header>
      {!id && (
        <label className="mb-5 flex min-h-12 items-center gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-surface)] px-4">
          <Search size={17} />
          <span className="sr-only">Find people</span>
          <input
            className="min-w-0 flex-1 bg-transparent py-3 text-base outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a name, email, or account…"
          />
        </label>
      )}
      {(refreshing || (!id && query !== search.trim())) && (
        <p role="status" className="py-6 text-sm text-[var(--text-secondary)]">
          Loading people…
        </p>
      )}
      {data.isError && (
        <div
          role="alert"
          className="rounded-xl border border-[var(--glass-border)] p-5 text-sm"
        >
          {id
            ? "This person is unavailable or could not be loaded."
            : "People could not be loaded."}
          <button
            className={control + " ml-3"}
            onClick={() => void data.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-[var(--color-error)]">
          {error}
        </p>
      )}
      {!id && ready && (
        <div className="grid gap-3 sm:grid-cols-2">
          {people.map((p) => (
            <button
              key={p.id}
              className="focus-ring min-w-0 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-surface)] p-4 text-left hover:bg-[var(--glass-hover)]"
              onClick={() =>
                openTab(`people:${p.id}`, p.name, "people" as ContentType)
              }
            >
              <Identity person={p} />
            </button>
          ))}
          {!people.length && (
            <div className="col-span-full rounded-xl border border-dashed border-[var(--glass-border)] px-6 py-12 text-center">
              <Users
                className="mx-auto mb-3 text-[var(--text-muted)]"
                size={26}
              />
              <h2 className="font-medium">
                {query ? "No matching people" : "Your people start here"}
              </h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {query
                  ? "Try another name or account identifier."
                  : "Notes tagged person appear here. Linked conversations and meetings stay connected to those notes."}
              </p>
            </div>
          )}
        </div>
      )}
      {person && (
        <>
          <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-surface)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Identity person={person} />
              <button
                disabled={opening}
                className={control}
                onClick={() => void openNote(person.id)}
              >
                Open person note{" "}
                <ArrowUpRight size={15} className="ml-2 inline" />
              </button>
            </div>
            {person.identities.length > 0 && (
              <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                {person.identities.map((identity) => (
                  <div
                    key={`${identity.kind}:${identity.value}`}
                    className="min-w-0"
                  >
                    <dt className="text-xs capitalize text-[var(--text-secondary)]">
                      {identity.kind}
                    </dt>
                    <dd className="mt-1 break-all">{identity.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-4 text-xs text-[var(--text-secondary)]">
              Accounts are stored on this person note. Matching names alone
              never combine people.
            </p>
            {person.canManageIdentities &&
              person.updatedAt &&
              client.changePersonIdentity && (
                <IdentityControls person={person} scope={scope} />
              )}
          </div>
          <nav
            aria-label="Related records"
            className="mb-4 flex flex-wrap gap-2"
          >
            {(["all", ...Object.keys(labels)] as Array<Category | "all">).map(
              (value) => (
                <button
                  key={value}
                  aria-pressed={category === value}
                  className={control}
                  style={{
                    background:
                      category === value ? "var(--glass-active)" : undefined,
                  }}
                  onClick={() => setCategory(value)}
                >
                  {value === "all" ? "All records" : labels[value]}
                </button>
              ),
            )}
          </nav>
          <div className="divide-y divide-[var(--glass-border)] rounded-xl border border-[var(--glass-border)]">
            {records
              .filter((r) => category === "all" || r.category === category)
              .map((record) => (
                <button
                  disabled={opening}
                  key={record.id}
                  className="focus-ring flex min-h-20 w-full min-w-0 items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[var(--glass-hover)]"
                  onClick={() => void openNote(record.id)}
                >
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium">
                      {record.title}
                    </span>
                    <span className="mt-1 block break-words text-xs text-[var(--text-secondary)]">
                      {labels[record.category]} ·{" "}
                      {record.relationships
                        .map((value) => value.replace(/[_-]+/g, " "))
                        .join(", ")}
                    </span>
                  </span>
                  <ArrowUpRight className="shrink-0" size={16} />
                </button>
              ))}
            {!records.some(
              (r) => category === "all" || r.category === category,
            ) && (
              <p className="p-7 text-center text-sm text-[var(--text-secondary)]">
                No linked {category === "all" ? "records" : category} in the
                loaded records. Link notes to this person to connect them here.
              </p>
            )}
          </div>
        </>
      )}
      {ready && data.hasNextPage && (
        <button
          className={control + " mt-5"}
          disabled={data.isFetchingNextPage}
          onClick={() => void data.fetchNextPage()}
        >
          {data.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
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

/** Fictional People fixture. No transport, network, or real account mutations. */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  VaultClientProvider,
  useAgentChatStore,
  useUIStore,
  type VaultClient,
  type Note,
} from "@prism/core";
import type {
  PersonSummary,
  PersonPage,
} from "../../../packages/core/src/data/VaultClient";
import PeopleWorkspace from "../../../packages/core/src/components/people/PeopleWorkspace";
const params = new URLSearchParams(location.search);
document.documentElement.className = params.has("dark") ? "dark" : "light";
let scope = "fictional-people-owner";
useAgentChatStore.getState().bindScope(scope);
const people: PersonSummary[] = [
  {
    id: "morgan",
    name: "Morgan Lee",
    role: "Research partner",
    path: "People/Morgan Lee",
    updatedAt: "2026-10-01",
    canManageIdentities: !params.has("readonly"),
    identities: [
      { kind: "email", value: "morgan@example.test" },
      { kind: "matrix", value: "@morgan_research:example.test" },
    ],
  },
  {
    id: "alex-design",
    name: "Alex Rivera",
    role: "Product designer",
    path: "People/Alex design",
    updatedAt: "2026-10-01",
    canManageIdentities: false,
    identities: [{ kind: "email", value: "design@example.test" }],
  },
  {
    id: "alex-engineer",
    name: "Alex Rivera",
    role: "Engineering partner",
    path: "People/Alex engineering",
    updatedAt: "2026-10-01",
    canManageIdentities: false,
    identities: [{ kind: "email", value: "engineering@example.test" }],
  },
  {
    id: "long",
    name: "A very long canonical person name without an inferred alias or merged account",
    role: "Research and documentation collaborator",
    path: "People/Long name",
    updatedAt: "2026-10-01",
    canManageIdentities: false,
    identities: [
      {
        kind: "email",
        value: "a-very-long-exact-account-identifier-preserved@example.test",
      },
    ],
  },
];
if (params.has("many"))
  people.push(
    ...Array.from({ length: 24 }, (_, i) => ({
      ...people[1]!,
      id: `extra-${i}`,
      name: `Fictional person ${i + 1}`,
      role: "Research participant",
    })),
  );
const related: PersonPage["related"] = [
  {
    id: "conversation",
    title: "Project discussion",
    category: "conversations",
    path: "Conversations/Project discussion",
    relationships: ["participant"],
  },
  {
    id: "email",
    title: "Research follow-up",
    category: "conversations",
    path: "Messages/Research follow-up",
    relationships: ["email_from"],
  },
  {
    id: "meeting",
    title: "Research review",
    category: "meetings",
    path: "Calendar/Research review",
    relationships: ["attendee"],
  },
  {
    id: "task",
    title: "Gather the research notes",
    category: "tasks",
    path: "Tasks/Gather research notes",
    relationships: ["assigned_to"],
  },
  {
    id: "note",
    title: "Shared observations",
    category: "notes",
    path: "Research/Shared observations",
    relationships: ["mentions"],
  },
];
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
let release: (() => void) | null = null;
const controls = {
  denyProfile: false,
  denyNote: false,
  hold: false,
  writes: [] as unknown[],
  reads: [] as string[],
  release() {
    release?.();
    release = null;
  },
  async refresh() {
    await queries.invalidateQueries({ queryKey: ["vault", "person"] });
  },
  switchScope() {
    scope = "fictional-other-viewer";
    useAgentChatStore.getState().bindScope(scope);
  },
};
Object.assign(window, { prismPeople: controls });
const unsupported = async (): Promise<never> => {
  throw Error("Unexpected operation in People fixture");
};
const client: VaultClient = {
  scope: () => scope,
  listPeople: async (query) => ({
    people:
      scope === "fictional-people-owner"
        ? people.filter((p) =>
            JSON.stringify(p)
              .toLowerCase()
              .includes((query || "").toLowerCase()),
          )
        : [],
    next: null,
  }),
  getPerson: async (id) => {
    controls.reads.push(id);
    if (controls.hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (controls.denyProfile) throw Error("Access denied");
    return {
      person: structuredClone(people.find((p) => p.id === id)!),
      related: structuredClone(related),
      next: null,
    };
  },
  getNote: async (id) => {
    controls.reads.push(`note:${id}`);
    if (controls.denyNote) throw Error("Access denied");
    return {
      id,
      path: `Notes/${id}`,
      content: "Fictional note",
      metadata: { title: `Opened ${id}` },
      tags: [],
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
    };
  },
  changePersonIdentity: async (id, change) => {
    controls.writes.push({ id, ...change });
    throw Error("Fixture revision changed; reload profile before retrying.");
  },
  listNotes: unsupported,
  listTree: unsupported,
  createNote: unsupported,
  updateNote: unsupported,
  deleteNote: unsupported,
  search: unsupported,
  getTags: unsupported,
  addTags: unsupported,
  removeTags: unsupported,
  getStats: unsupported,
  getLinks: unsupported,
  createLink: unsupported,
  deleteLink: unsupported,
  getGraph: unsupported,
  getVaultInfo: unsupported,
  updateVaultDescription: unsupported,
};
const note: Note = {
  id: params.has("deep") ? "people:morgan" : "people",
  content: "",
  path: null,
  tags: [],
  metadata: {},
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
function Fixture() {
  const tabs = useUIStore((s) => s.openTabs);
  return (
    <QueryClientProvider client={queries}>
      <VaultClientProvider client={client}>
        <main style={{ minHeight: "100dvh", background: "var(--bg-base)" }}>
          <PeopleWorkspace note={note} />
          <output aria-label="Opened notes">
            {tabs.map((tab) => tab.noteId).join(",")}
          </output>
        </main>
      </VaultClientProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);

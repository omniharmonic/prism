import { useInfiniteQuery } from "@tanstack/react-query";
import { useVaultClient } from "../data/VaultClientContext";
import { PROJECT_SECTIONS, type ProjectNote, type ProjectSection } from "../lib/projects/related";

export function ProjectSections({ project, onNavigate }: { project: ProjectNote; onNavigate?: (target: string) => void }) {
  const client = useVaultClient();
  return <aside aria-label="Project activity" style={{ maxWidth: "var(--content-measure)", margin: "32px auto", padding: "0 16px", fontFamily: "var(--font-sans)" }}>
    {PROJECT_SECTIONS.map(kind => <Section key={kind} project={project} kind={kind} onNavigate={onNavigate} client={client} />)}
  </aside>;
}
function Section({ project, kind, onNavigate, client }: { project: ProjectNote; kind: ProjectSection; onNavigate?: (target: string) => void; client: ReturnType<typeof useVaultClient> }) {
  const query = useInfiniteQuery({
    queryKey: ["vault", "project-related", client.scope?.() ?? "", project.id, kind],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      if (!client.getProjectRelated) throw new Error("Project sections unavailable");
      return client.getProjectRelated(project.id, kind, pageParam);
    },
    getNextPageParam: page => page.next ?? undefined,
    staleTime: 10_000,
  });
  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  return <section aria-label={kind} style={{ borderTop: "1px solid var(--border-subtle)", padding: "16px 0" }}>
    <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px", textTransform: "capitalize" }}>{kind} {query.data && <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>({query.data.pages[0]!.total})</span>}</h2>
    {query.isPending ? <p role="status">Loading…</p> : query.isError ? <div role="alert"><p>Couldn’t load {kind}.</p><button onClick={() => void query.refetch()}>Try again</button></div> : !items.length ? <p style={{ color: "var(--text-secondary)" }}>No {kind} linked to this project yet.</p> : <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{items.map(item => <li key={item.id}><button onClick={() => onNavigate?.(item.path ?? item.id)} style={{ width: "100%", minHeight: 44, textAlign: "left", display: "flex", gap: 12, alignItems: "center", padding: "8px 0", background: "transparent", border: 0, color: "var(--text-primary)" }}><span style={{ flex: 1 }}>{item.title}</span>{item.date && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{item.date.slice(0, 10)}</span>}{item.status && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{item.status}</span>}</button></li>)}</ul>}
    {query.hasNextPage && <button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} style={{ minHeight: 44 }}>{query.isFetchingNextPage ? "Loading…" : "Show more"}</button>}
  </section>;
}

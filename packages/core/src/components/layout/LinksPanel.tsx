import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, FileText, Link } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useVaultClient } from "../../data/VaultClientContext";
import { isAccessUnavailable, VaultRequestError, type VaultLink } from "../../data/VaultClient";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";
import "./context-panels.css";

const PAGE_SIZE = 20;
type Resolution = { note?: Note; state: "ready" | "unavailable" | "failed" };
type Row = Resolution & { link: VaultLink; id: string };
const title = (note: Note) => (typeof note.metadata?.title === "string" && note.metadata.title.trim()) || note.path?.split("/").pop() || "Untitled note";

export function LinksPanel({ noteId }: { noteId: string }) {
  const client = useVaultClient();
  const audience = useAgentChatStore(state => state.scope);
  const scope = client.scope?.() ?? audience;
  return <ScopedLinks key={JSON.stringify([scope, noteId])} noteId={noteId} scope={scope} />;
}

function ScopedLinks({ noteId, scope }: { noteId: string; scope: string | null }) {
  const client = useVaultClient();
  const alive = useRef(false);
  const lock = useRef(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  const supported = typeof client.getLinks === "function";
  const links = useQuery({
    queryKey: ["vault", "links", scope, noteId],
    enabled: !!noteId && supported,
    queryFn: async () => {
      const source = await client.getNote(noteId, { fresh: true });
      if (!current()) throw Error("Workspace changed");
      if (source.id !== noteId) throw new VaultRequestError(404, "Source unavailable");
      const result = await client.getLinks(noteId);
      if (!current()) throw Error("Workspace changed");
      return result.filter(link => link.sourceId === noteId || link.targetId === noteId);
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  const visibleLinks = !links.isFetching && !links.isError ? links.data ?? [] : [];
  const resolved = useInfiniteQuery({
    queryKey: ["vault", "linked-notes", scope, noteId, visibleLinks.map(link => [link.sourceId, link.targetId, link.relationship])],
    enabled: supported && visibleLinks.length > 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const batch = visibleLinks.slice(pageParam, pageParam + PAGE_SIZE);
      const ids = [...new Set(batch.map(link => link.sourceId === noteId ? link.targetId : link.sourceId))];
      const notes = new Map<string, Resolution>(await Promise.all(ids.map(async (id): Promise<[string, Resolution]> => {
        try {
          const note = await client.getNote(id, { fresh: true });
          if (note.id !== id) throw new VaultRequestError(404, "Linked note unavailable");
          return [id, { note, state: "ready" }];
        } catch (error) {
          return [id, { state: isAccessUnavailable(error) ? "unavailable" : "failed" }];
        }
      })));
      if (!current()) throw Error("Workspace changed");
      return batch.map(link => {
        const id = link.sourceId === noteId ? link.targetId : link.sourceId;
        return { link, id, ...notes.get(id)! } satisfies Row;
      });
    },
    getNextPageParam: (_last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.length, 0);
      return count < visibleLinks.length ? count : undefined;
    },
    retry: false, staleTime: 0, gcTime: 0,
  });
  const rows = !resolved.isRefetching && !resolved.isError ? resolved.data?.pages.flat() ?? [] : [];
  async function open(id: string) {
    if (lock.current || !current()) return;
    lock.current = true; setOpening(id); setOpenError("");
    try {
      const note = await client.getNote(id, { fresh: true });
      if (!current()) return;
      if (note.id !== id) throw new VaultRequestError(404, "Linked note unavailable");
      useUIStore.getState().openTab(note.id, title(note), inferContentType(note));
    } catch {
      if (current()) {
        setBlocked(previous => new Set(previous).add(id));
        setOpenError("This note could not be opened. It may be unavailable or your access may have changed.");
      }
    } finally {
      lock.current = false;
      if (current()) setOpening(null);
    }
  }
  function retry() { setBlocked(new Set()); setOpenError(""); void links.refetch(); }

  return <section className="prism-context-links" aria-label="Related context">
    <header><Link size={17} aria-hidden="true"/><div><h2>Related context</h2><p>Connections to and from this page</p></div></header>
    {!supported ? <p className="prism-context-state">This connection does not provide note links.</p>
      : links.isFetching ? <p role="status" className="prism-context-state">Loading connections…</p>
      : links.isError ? <div role="alert" className="prism-context-state"><p>{isAccessUnavailable(links.error) ? "This page is unavailable or your access changed." : "Connections could not be loaded."}</p><button type="button" onClick={retry}>Try again</button></div>
      : !visibleLinks.length ? <div className="prism-context-state"><p>No connections yet.</p><p>Link to another page with [[wikilinks]], or connect note cards on a canvas.</p></div>
      : <>
        <p className="prism-context-count">{visibleLinks.length} connection{visibleLinks.length === 1 ? "" : "s"}</p>
        {openError && <div role="alert" className="prism-context-state"><p>{openError}</p><button type="button" onClick={retry}>Reload connections</button></div>}
        {(resolved.isPending || resolved.isRefetching) && <p role="status" className="prism-context-state">Loading linked notes…</p>}
        {resolved.isError && <div role="alert" className="prism-context-state"><p>Linked notes could not be loaded.</p><button type="button" onClick={() => void resolved.refetch()}>Try linked notes again</button></div>}
        {(["incoming", "outgoing"] as const).map(direction => {
          const group = rows.filter(row => direction === "outgoing" ? row.link.sourceId === noteId : row.link.sourceId !== noteId);
          if (!group.length) return null;
          return <section key={direction} aria-label={direction === "incoming" ? "Links to this page" : "Links from this page"}>
            <h3>{direction === "incoming" ? <ArrowDownLeft size={14} aria-hidden="true"/> : <ArrowUpRight size={14} aria-hidden="true"/>}{direction === "incoming" ? "Links to this page" : "Links from this page"}</h3>
            <ul>{group.map((row, index) => {
              const note = row.state === "ready" && !blocked.has(row.id) ? row.note : undefined;
              return <li key={JSON.stringify([row.link.sourceId, row.link.targetId, row.link.relationship, index])}>
                {note ? <button type="button" className="prism-context-link" disabled={!!opening} onClick={() => void open(row.id)} aria-label={`Open ${title(note)}`}>
                  <FileText className="prism-context-note-icon" size={18} aria-hidden="true"/>
                  <span className="prism-context-link-copy"><strong>{title(note)}</strong><span>{note.path || "Note"}</span><span className="prism-context-relationship">{row.link.relationship || "related"}</span></span>
                  {opening === row.id ? <span>Opening…</span> : <ChevronRight size={15} aria-hidden="true"/>}
                </button> : <div className="prism-context-unavailable"><FileText size={17} aria-hidden="true"/><span>{row.state === "failed" ? "Linked note could not be loaded" : "Unavailable linked note"}</span></div>}
              </li>;
            })}</ul>
          </section>;
        })}
        {rows.some(row => row.state !== "ready") && <button type="button" className="prism-context-more" onClick={retry}>Retry unavailable notes</button>}
        {resolved.hasNextPage && <button type="button" className="prism-context-more" disabled={resolved.isFetchingNextPage} onClick={() => void resolved.fetchNextPage()}>{resolved.isFetchingNextPage ? "Loading more…" : `Load more connections (${visibleLinks.length - rows.length} remaining)`}</button>}
      </>}
  </section>;
}

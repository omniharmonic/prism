import type { Note } from "../../lib/types";
import { findMatches, queryTerms, searchMatches, type Range, type SearchMatches } from "../../lib/search/match";
import { searchPreview } from "./searchPresentation";

/** NP-SR-03: matched terms in bold; plain text only (never note markup). */
export function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s < at || e > text.length) return;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark key={i} className="prism-search-mark">{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

type Hit = Note & { _matches?: SearchMatches; _snippet?: string };

/** Title + snippet with match ranges: the server's offsets when present, else computed here. */
export function resultHighlights(note: Hit, title: string, query: string): { title: Range[]; snippet: string; snippetRanges: Range[] } {
  const terms = queryTerms(query);
  const server = note._matches;
  if (server && typeof server.snippet === "string") {
    return { title: findMatches(title, terms), snippet: server.snippet, snippetRanges: Array.isArray(server.snippetMatches) ? server.snippetMatches : findMatches(server.snippet, terms) };
  }
  if (!note._snippet && note.content) {
    const local = searchMatches({ ...note, content: note.content }, terms);
    return { title: findMatches(title, terms), snippet: local.snippet, snippetRanges: local.snippetMatches };
  }
  const snippet = searchPreview(note, 220);
  return { title: findMatches(title, terms), snippet, snippetRanges: findMatches(snippet, terms) };
}

/** Shared by interactive navigation, single-note linking and the server batch job. */
import { decodeHTML } from "entities";
import { containerTitle } from "./pages/containerTitle";
export interface LinkableNote {
  id: string;
  path: string | null;
  metadata?: Record<string, unknown> | null;
  displayTitle?: string | null;
}
export type LinkResolution<T> = { kind: "match"; note: T } | { kind: "ambiguous"; notes: T[] } | { kind: "none" };
const fold = (s: string) => s.trim().normalize("NFC").toLowerCase();
const strip = (s: string) => s.replace(/^vault\//, "");
export function noteAliases(note: LinkableNote): string[] {
  const raw = note.metadata?.aliases ?? note.metadata?.alias;
  return (Array.isArray(raw) ? raw : [raw]).filter((s): s is string => typeof s === "string" && !!s.trim());
}
/** What `[[Title]]` resolves by. Kept exactly as it was: changing it would make links resolve differently. */
function linkKeyTitle(note: LinkableNote): string {
  return (typeof note.metadata?.title === "string" ? note.metadata.title : note.displayTitle) || note.path?.split("/").pop() || note.id;
}
/** The name a note is SHOWN by (tabs, link chips, mention menus). A container-named note
 *  (`<folder>/PROJECT`) is named by its title / name / folder — see `pages/containerTitle.ts`. */
export function noteLinkTitle(note: LinkableNote): string {
  return (typeof note.metadata?.title === "string" ? note.metadata.title : note.displayTitle) || containerTitle(note.path, note.metadata) || note.path?.split("/").pop() || note.id;
}
export function parseWikilinks(content: string): { links: string[]; balanced: boolean } {
  // TipTap stores HTML; resolve its visible text, not tag attributes or encoded
  // entities. Plain Markdown keeps literal entity-looking text unchanged.
  const source = /<(?:p|div|h[1-6]|ul|ol|blockquote|table)(?:\s|>)/i.test(content)
    ? decodeHTML(content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr)>/gi, "\n").replace(/<[^>]+>/g, ""))
    : content;
  const links: string[] = [];
  const matches = [...source.matchAll(/\[\[([^\[\]]*?)\]\]/g)];
  for (const match of matches) {
    const target = match[1]!.split("|")[0]!.trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return { links, balanced: source.split("[[").length - 1 === matches.length };
}
export interface WikilinkIndex<T> { ids: Map<string,T[]>; paths: Map<string,T[]>; stripped: Map<string,T[]>; aliases: Map<string,T[]>; titles: Map<string,T[]> }
export function buildWikilinkIndex<T extends LinkableNote>(notes: T[]): WikilinkIndex<T> {
  const index: WikilinkIndex<T> = {ids:new Map(),paths:new Map(),stripped:new Map(),aliases:new Map(),titles:new Map()};
  const add = (map: Map<string,T[]>, key: string, note: T) => {
    if (!key) return;
    const existing = map.get(key) ?? [];
    if (!existing.some(n=>n.id===note.id)) existing.push(note);
    map.set(key,existing);
  };
  for (const note of notes) {
    add(index.ids,note.id,note);
    if (note.path) {
      add(index.paths,note.path,note);
      add(index.stripped,strip(note.path),note);
      add(index.titles,fold(note.path.split("/").pop()!),note);
    }
    for (const alias of noteAliases(note)) add(index.aliases,fold(alias),note);
    add(index.titles,fold(linkKeyTitle(note)),note);
  }
  return index;
}
export function resolveWikilink<T extends LinkableNote>(target: string, index: WikilinkIndex<T>, excludeId?: string): LinkResolution<T> {
  const value = target.trim();
  if (!value) return {kind:"none"};
  for (const entries of [index.ids.get(value), index.paths.get(value), index.stripped.get(strip(value)), index.aliases.get(fold(value)), index.titles.get(fold(value))]) {
    const notes = (entries ?? []).filter(note=>note.id!==excludeId).sort((a,b)=>(a.path??a.id).localeCompare(b.path??b.id)||a.id.localeCompare(b.id));
    if (notes.length===1) return {kind:"match",note:notes[0]!};
    if (notes.length>1) return {kind:"ambiguous",notes};
  }
  return {kind:"none"};
}

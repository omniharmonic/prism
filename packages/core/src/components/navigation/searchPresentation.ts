import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";

/** Render saved HTML as inert text; never insert note markup into the result list. */
export function searchPreview(note: Note & { _snippet?: string }, max = 220): string {
  const source = note._snippet || note.content || "";
  const template = document.createElement("template");
  template.innerHTML = source.replace(/<\/(?:p|h[1-6]|li|div|tr)>/gi, "$& ");
  template.content.querySelectorAll("script,style,noscript").forEach(element => element.remove());
  const text = (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export const searchModeLabel = (mode?: "ranked" | "blended" | "keyword" | "fallback") =>
  mode === "fallback" ? "Keyword search · Ranked search is unavailable" : mode === "blended" ? "Ranked search · with keyword matches" : mode === "ranked" ? "Ranked search" : "Keyword search";

/** Messages are existing email/thread notes, not a separate remote inbox search. */
export function searchResultGroup(note: Note): "messages" | "notes" {
  const type = inferContentType(note);
  return type === "email" || type === "message-thread" ? "messages" : "notes";
}

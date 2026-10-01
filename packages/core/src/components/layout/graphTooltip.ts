/** force-graph interprets string labels as HTML. Escape text at that boundary;
 * document names and relationship types never supply tooltip markup. */
export function graphTooltip(text: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, character => entities[character]!);
}

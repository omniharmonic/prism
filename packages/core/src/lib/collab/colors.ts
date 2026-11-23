/**
 * Authorship colours of live collaboration — ONE table for the web client (carets, a
 * person's suggestion marks, comment avatars) and the server (suggest-only commands, the
 * Prism MCP's collab tools). Pure: no imports.
 *
 * NP-CO-10: a person's colour and an agent's colour never coincide.
 *  - `CARET_COLORS` is the HUMAN palette (unchanged: a person keeps the colour they had).
 *  - `AGENT_COLOR` is reserved — it is not in that palette: every mark and comment an agent
 *    writes carries it, whoever the agent acts for. Colour is never the only cue: the author
 *    reads "<name> (agent)" and an agent's marks are drawn dashed (collab.css).
 */
export const CARET_COLORS: readonly string[] = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];
export const AGENT_COLOR = "#64748b";

/** A STABLE colour per identity (the same person is the same colour across sessions and
 *  clients), derived from their account / name — not from join order. */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length]!;
}

/** Whether an author label is an agent's ("<name> (agent)", written by the server). */
export function isAgentAuthor(name: unknown): boolean {
  return typeof name === "string" && name.endsWith("(agent)");
}

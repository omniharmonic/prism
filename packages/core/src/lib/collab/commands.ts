/** Bounded human collaboration commands; never an arbitrary document/Yjs update. */
export interface HumanCollabCommand {
  requestId: string;
  createdAt: number;
  revision: string;
  kind: "suggest" | "comment" | "reply" | "resolve" | "delete-comment";
  from?: number;
  to?: number;
  quote?: string;
  text?: string;
  threadId?: string;
  resolved?: boolean;
}
export interface HumanCollabResult { suggestionId?: string; threadId?: string }
export type HumanCollabSend = (command: HumanCollabCommand) => Promise<HumanCollabResult>;
/** Stable JSON across browser/server object insertion order. */
export function canonicalCollabState(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCollabState).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonicalCollabState(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function humanCollabRevision(doc: unknown, comments: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCollabState({ doc, comments }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

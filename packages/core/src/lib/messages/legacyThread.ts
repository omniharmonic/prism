import type { MatrixMessage } from "../matrix/types";

// Ingest's legacy transcript contract is UTC. The sender can contain colons
// (Matrix IDs); only colon + space separates sender from body.
const HEADER = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+(.+?): (.*)$/;
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

/** Loss-aware reader, not an identity resolver. Never invent source event IDs. */
export function parseLegacyThread(content: string | null | undefined): { messages: MatrixMessage[]; preamble: string } {
  const messages: MatrixMessage[] = [];
  const preamble: string[] = [];
  for (const line of (content ?? "").split("\n")) {
    const match = HEADER.exec(line);
    if (!match) {
      if (messages.length) messages[messages.length - 1].body += `\n${line}`;
      else preamble.push(line);
      continue;
    }
    const [, stamp, sender, body] = match;
    const parsed = Date.parse(`${stamp.replace(" ", "T")}:00Z`);
    const valid = Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 16).replace("T", " ") === stamp;
    messages.push({
      event_id: "", sender, sender_name: sender, body, msg_type: "m.text",
      timestamp: valid ? parsed : 0, is_outgoing: false, media_url: null, media_info: null,
      source: "legacy", timestamp_label: stamp + " UTC",
    });
  }
  const occurrences = new Map<string, number>();
  for (const message of messages) {
    const key = fingerprint(`${message.timestamp_label}\n${message.sender}\n${message.body}`);
    const count = occurrences.get(key) ?? 0;
    occurrences.set(key, count + 1);
    message.event_id = `legacy:${key}:${count}`;
  }
  return { messages, preamble: preamble.join("\n").trim() };
}

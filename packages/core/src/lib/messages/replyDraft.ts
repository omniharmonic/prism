/** What the reply prompt asks for: the message itself between these tags, any remarks outside. */
export const REPLY_DRAFT_INSTRUCTION =
  "Put the reply itself, exactly as it should be sent and nothing else, between <reply> and </reply>. Anything you want to tell me about it goes outside those tags.";

export type ReplyDraft = { draft: string; note: string };

/**
 * Separate the message to send from what the agent said about it. The first `<reply>` up to the
 * last `</reply>` is the draft; the text around it is the note. An answer without a complete,
 * non-empty block is all draft, as before the tags existed.
 */
export function extractReplyDraft(text: string): ReplyDraft {
  const lower = text.toLowerCase();
  const open = lower.indexOf("<reply>");
  const close = lower.lastIndexOf("</reply>");
  const draft = open === -1 || close < open ? "" : text.slice(open + 7, close).trim();
  if (!draft) return { draft: text.trim(), note: "" };
  const note = [text.slice(0, open), text.slice(close + 8)].map((part) => part.trim()).filter(Boolean).join("\n\n");
  return { draft, note };
}

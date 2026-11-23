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

/**
 * Sessions the message views start on a person's behalf ("Draft with agent", "Summarize") are
 * named with these. They are tools of the message they belong to, reopened from there — not
 * conversations someone had with the agent — so the conversation history keeps them out of the
 * way unless asked.
 */
export const REPLY_SESSION_TITLE = "Reply draft";
export const SUMMARY_SESSION_TITLE = "Conversation summary";
export const isHelperSession = (title: string | null | undefined): boolean =>
  !!title && (title.startsWith(`${REPLY_SESSION_TITLE}: `) || title.startsWith(`${SUMMARY_SESSION_TITLE}: `));

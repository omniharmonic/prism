/**
 * One header per conversation. Inside the Messages split view the thread's own
 * header carries "back" and "open as page" — there is no second bar stacked above
 * it. A renderer opened as an ordinary page has no chrome and renders neither.
 */
import { createContext, useContext } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

export interface ConversationChrome {
  onBack: () => void;
  /** What "back" returns to ("Back to messages", "Back to Morgan"). */
  backLabel: string;
  onOpenPage?: () => void;
}
const Chrome = createContext<ConversationChrome | null>(null);
export const ConversationChromeProvider = Chrome.Provider;

export function ConversationBack() {
  const chrome = useContext(Chrome);
  if (!chrome) return null;
  return (
    <button type="button" className="prism-conversation-action focus-ring" aria-label={chrome.backLabel} title={chrome.backLabel} onClick={chrome.onBack}>
      <ArrowLeft size={18} aria-hidden="true" />
    </button>
  );
}

export function ConversationOpenPage() {
  const chrome = useContext(Chrome);
  if (!chrome?.onOpenPage) return null;
  return (
    <button type="button" className="prism-conversation-action focus-ring" aria-label="Open as page" title="Open as page" onClick={chrome.onOpenPage}>
      <ArrowUpRight size={18} aria-hidden="true" />
    </button>
  );
}

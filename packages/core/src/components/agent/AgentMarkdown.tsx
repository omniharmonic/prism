import { useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import "./AgentMarkdown.css";

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
// An isolated parser: do not change Markdown behavior in publishing or notes.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => `<span>[Image: ${escape(text || "attachment")}]</span>`,
    checkbox: ({ checked }) => checked ? "☑ " : "☐ ",
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      // Chat output cannot navigate to executable schemes or invoke app actions.
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return text;
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escape(title)}"` : ""}>${text}</a>`;
    },
  },
});

/** Render streaming Markdown without executing HTML or fetching remote images. */
export function AgentMarkdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdown.parse(text, { async: false }) as string, {
    ALLOWED_TAGS: ["p", "br", "span", "strong", "em", "del", "blockquote", "pre", "code", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  }), [text]);
  return <div className="agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

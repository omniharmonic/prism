export interface EmailMessage { from: string; date: string; body: string; details: string[] }

/** Read the two existing ingestion formats without splitting ordinary `---` in prose. */
export function parseEmailContent(content: string, fallbackFrom: string, fallbackDate: string, source?: string): EmailMessage[] {
  const fallback = (): EmailMessage[] => [{ from: fallbackFrom, date: fallbackDate, body: content, details: [] }];
  if (!content) return fallback();
  const text = content.replace(/\r\n/g, "\n");
  const chunks = source === "proton-bridge" ? [text] : text.split(/\n---[ \t]*\n\s*(?=\*\*From:\*\*[^\n]*\n\*\*Date:\*\*)/);
  return chunks.map((chunk, index) => {
    const lines = chunk.split("\n");
    let cursor = 0;
    if (index === 0 && lines[cursor]?.startsWith("# ")) cursor++;
    while (!lines[cursor]?.trim() && cursor < lines.length) cursor++;
    let from = "", date = "";
    const details: string[] = [];
    while (cursor < lines.length) {
      const match = lines[cursor].match(/^\*\*(From|To|Cc|Date|Attachments):\*\*\s*(.*)$/);
      if (!match) break;
      if (match[1] === "From") from = match[2].trim();
      else if (match[1] === "Date") date = match[2].trim();
      else details.push(`${match[1]}: ${match[2].trim()}`);
      cursor++;
    }
    if (!from || !date) return { from: fallbackFrom, date: fallbackDate, body: chunk, details: [] };
    while (!lines[cursor]?.trim() && cursor < lines.length) cursor++;
    if (source === "proton-bridge") {
      // Only this importer guarantees a header/body separator. Everything after
      // it, including Markdown headings and rules, is message content.
      if (lines[cursor]?.trim() !== "---") return { from: fallbackFrom, date: fallbackDate, body: chunk, details: [] };
      cursor++;
    }
    let body = lines.slice(cursor).join("\n").trim();
    if (source !== "proton-bridge" && index === chunks.length - 1) body = body.replace(/\n\n---\s*$/, "");
    return { from, date, body, details };
  });
}

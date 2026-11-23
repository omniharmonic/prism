export interface EmailBodyParts {
  visible: string;
  folded: string;
  kind: "quoted history" | "quoted text" | "signature" | null;
}

/** A reversible display split only. Ambiguous bodies are never shortened. */
export function splitEmailQuote(body: string): EmailBodyParts {
  const unchanged = (): EmailBodyParts => ({
    visible: body,
    folded: "",
    kind: null,
  });
  // Do not interpret markers inside a possible code example.
  if (/^\s*(```|~~~)/m.test(body)) return unchanged();
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]!.trim()) end--;
  if (end < 0) return unchanged();
  let start = end;
  if (/^\s*>/.test(lines[end]!)) {
    while (
      start >= 0 &&
      (!lines[start]!.trim() || /^[ \t]*>/.test(lines[start]!))
    )
      start--;
    const history =
      start >= 0 && /^On [^\r\n]{5,180} wrote:\s*$/.test(lines[start]!);
    if (history) start--;
    start++;
    const visible = lines.slice(0, start).join("");
    if (visible.trim())
      return {
        visible,
        folded: lines.slice(start).join(""),
        kind: history ? "quoted history" : "quoted text",
      };
  }
  let signature = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^-- \r?\n$/.test(lines[i]!)) {
      signature = i;
      break;
    }
  }
  if (signature > 0 && end > signature && end - signature <= 12) {
    const visible = lines.slice(0, signature).join("");
    if (visible.trim())
      return {
        visible,
        folded: lines.slice(signature).join(""),
        kind: "signature",
      };
  }
  return unchanged();
}

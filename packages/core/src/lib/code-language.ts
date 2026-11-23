/** Map a note path/metadata to a CodeMirror language id (shared with CodeRenderer's map). */
export function detectCodeLanguage(path: string | null, metadata: Record<string, unknown> | null): string {
  if (metadata?.["language"] && typeof metadata["language"] === "string") return metadata["language"];
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase();
  const EXT_MAP: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", css: "css", scss: "scss",
    html: "html", htm: "html", json: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", md: "markdown", sql: "sql", sh: "shell", bash: "shell",
    xml: "xml", swift: "swift",
  };
  return EXT_MAP[ext || ""] || "plaintext";
}

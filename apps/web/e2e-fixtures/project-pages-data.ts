/** ~53,000 characters of ordinary project Markdown (the size of the largest real project page). Fictional. */
export function largeMarkdown(): string {
  const parts: string[] = ["# Front Range Commons", "", "**Status:** active — with [[Ada Park]].", ""];
  for (let i = 1; parts.join("\n").length < 53_000; i++) {
    parts.push(
      `## Section ${i}`, "",
      `Paragraph ${i} of the plan has **bold text**, *emphasis*, \`code\`, a [link](https://example.test/${i}) and a wikilink to [[Meeting ${i}]]. `.repeat(3), "",
      `- [ ] Task ${i}.1 for [[Ada Park]]`, `- [x] Task ${i}.2 done`, "",
      "| Field | Value |", "| --- | --- |", `| Row ${i} | **${i * 3}** |`, "",
    );
  }
  return parts.join("\n");
}

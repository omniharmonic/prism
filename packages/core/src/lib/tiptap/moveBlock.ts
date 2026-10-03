import { DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { VaultClient } from "../../data/VaultClient";
import { sliceToMarkdown } from "./markdownClipboard";

/** The stored HTML of some blocks (what the editor itself would save). */
export function blocksToHtml(schema: Schema, nodes: PMNode[]): string {
  const holder = document.createElement("div");
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(Fragment.fromArray(nodes)));
  return holder.innerHTML;
}

/** Copy blocks: rich text for editors, Markdown for everything else. */
export async function copyBlocks(schema: Schema, nodes: PMNode[]): Promise<boolean> {
  const html = blocksToHtml(schema, nodes);
  const text = sliceToMarkdown(new Slice(Fragment.fromArray(nodes), 0, 0));
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * "Move to" another page (NP-ED-02): append the blocks' HTML to the target page
 * with the ordinary note write — compare-and-set on the revision just read, so a
 * concurrent edit of the target is never overwritten (the caller keeps the block
 * and reports the failure). The gateway decides whether the user may edit the
 * target; a target whose body is Markdown keeps it (HTML blocks are valid there).
 */
export async function appendBlocksToPage(client: VaultClient, targetId: string, html: string): Promise<void> {
  const target = await client.getNote(targetId);
  if (target.id !== targetId) throw new Error("That page is not available.");
  const body = target.content ?? "";
  const next = body.trim() ? `${body.replace(/\s+$/, "")}${body.trimStart().startsWith("<") ? "" : "\n\n"}${html}` : html;
  await client.updateNote(targetId, { content: next, ifUpdatedAt: target.updatedAt ?? undefined });
}

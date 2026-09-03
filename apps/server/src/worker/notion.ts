/**
 * Notion ↔ vault sync (Phase 3), server-side. Pure-HTTP port of the desktop's
 * per-page notion adapter (notion.rs) — Bearer api_key + Notion-Version, no CLI,
 * fully portable. Credential = a Notion integration token in the secret store
 * (kind "notion"). Push = replace the page's blocks with the note's content;
 * pull = read the page's blocks back to markdown. Block support matches the
 * desktop (headings 1-3, bullets, paragraph; code/quote/to_do/divider on pull).
 *
 * The block↔markdown conversion is pure + unit-tested. The live round-trip needs
 * a VALID token (scripts/verify-notion-sync.ts) — the currently-stored token is
 * invalid, so that must be refreshed before live verification.
 */
type FetchLike = typeof fetch;
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

// ── block ⇄ markdown (pure, unit-tested) ─────────────────────────────────────

const rt = (content: string) => [{ type: "text", text: { content } }];

export function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("# ")) blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: rt(t.slice(2)) } });
    else if (t.startsWith("## ")) blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t.slice(3)) } });
    else if (t.startsWith("### ")) blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: rt(t.slice(4)) } });
    else if (t.startsWith("- ") || t.startsWith("* ")) blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(t.slice(2)) } });
    else blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } });
  }
  return blocks;
}

function extractText(block: any, type: string): string {
  const rich = block?.[type]?.rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((r: any) => r?.plain_text ?? r?.text?.content ?? "").join("");
}

export function blocksToMarkdown(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const type = b?.type ?? "";
    const text = extractText(b, type);
    switch (type) {
      case "heading_1": lines.push(`# ${text}`); break;
      case "heading_2": lines.push(`## ${text}`); break;
      case "heading_3": lines.push(`### ${text}`); break;
      case "paragraph": lines.push(text); break;
      case "bulleted_list_item": lines.push(`- ${text}`); break;
      case "numbered_list_item": lines.push(`1. ${text}`); break;
      case "to_do": lines.push(`${b.to_do?.checked ? "- [x]" : "- [ ]"} ${text}`); break;
      case "code": lines.push(`\`\`\`${b.code?.language ?? ""}`, text, "```"); break;
      case "quote": lines.push(`> ${text}`); break;
      case "divider": lines.push("---"); break;
      default: if (text) lines.push(text);
    }
  }
  return lines.join("\n");
}

// ── client ───────────────────────────────────────────────────────────────────

export class NotionClient {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Notion-Version": VERSION, "Content-Type": "application/json" };
  }
  private async req(path: string, init?: RequestInit): Promise<any> {
    const r = await this.fetchImpl(`${API}${path}`, { ...init, headers: { ...this.headers(), ...(init?.headers as Record<string, string>) } });
    if (!r.ok) throw new Error(`notion ${init?.method ?? "GET"} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  }

  async whoami(): Promise<string> {
    return (await this.req("/users/me")).name ?? "bot";
  }
  /** All child blocks of a page (cursor-paginated). */
  async getPageBlocks(pageId: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    do {
      const q = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
      const page = await this.req(`/blocks/${pageId}/children${q}`);
      all.push(...(page.results ?? []));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return all;
  }
  async deleteBlock(blockId: string): Promise<void> {
    await this.req(`/blocks/${blockId}`, { method: "DELETE" });
  }
  /** Append children in chunks of 100 (Notion's limit). */
  async appendBlocks(pageId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
    for (let i = 0; i < blocks.length; i += 100) {
      await this.req(`/blocks/${pageId}/children`, { method: "PATCH", body: JSON.stringify({ children: blocks.slice(i, i + 100) }) });
    }
  }
  async createPage(parentPageId: string, title: string, blocks: Array<Record<string, unknown>>): Promise<string> {
    const res = await this.req(`/pages`, {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: parentPageId },
        properties: { title: { title: rt(title) } },
        children: blocks.slice(0, 100),
      }),
    });
    const id = res.id as string;
    if (blocks.length > 100) await this.appendBlocks(id, blocks.slice(100));
    return id;
  }
  async lastEdited(pageId: string): Promise<string | null> {
    return (await this.req(`/pages/${pageId}`)).last_edited_time ?? null;
  }
}

// ── sync ops ──────────────────────────────────────────────────────────────────

/** Replace a page's content with the note's markdown (delete-all then append). */
export async function pushNotionPage(client: NotionClient, pageId: string, markdown: string): Promise<void> {
  const existing = await client.getPageBlocks(pageId);
  for (const b of existing) await client.deleteBlock(b.id);
  await client.appendBlocks(pageId, markdownToBlocks(markdown));
}

/** Create a new Notion page under a parent, seeded with the note's content. */
export async function createNotionPage(client: NotionClient, parentPageId: string, title: string, markdown: string): Promise<string> {
  return client.createPage(parentPageId, title, markdownToBlocks(markdown));
}

/** Pull a page's blocks back to markdown. */
export async function pullNotionPage(client: NotionClient, pageId: string): Promise<string> {
  return blocksToMarkdown(await client.getPageBlocks(pageId));
}

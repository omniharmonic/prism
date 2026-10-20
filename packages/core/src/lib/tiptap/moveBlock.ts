import { DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { VaultClient } from "../../data/VaultClient";
import { serverFetch } from "../transport/serverFetch";
import { isDesktop } from "../platform";
import { sliceToMarkdown } from "./markdownClipboard";
import { copyText } from "../clipboard";

/** The stored HTML of some blocks (what the editor itself would save). */
export function blocksToHtml(schema: Schema, nodes: PMNode[]): string {
  const holder = document.createElement("div");
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(Fragment.fromArray(nodes)));
  return holder.innerHTML;
}

/**
 * Copy blocks: rich text for editors, Markdown for everything else. Resolves false when the
 * clipboard refused — say so. Call it synchronously in the click / key handler: the write starts
 * before this function's first `await` (see lib/clipboard.ts for why that matters).
 */
export async function copyBlocks(schema: Schema, nodes: PMNode[]): Promise<boolean> {
  const html = blocksToHtml(schema, nodes);
  const text = sliceToMarkdown(new Slice(Fragment.fromArray(nodes), 0, 0));
  // Two flavours in ONE clipboard item is more than `copyText` does, so this write lives here
  // (allowed by apps/web/scripts/check-clipboard.mjs). Refused or unavailable: Markdown alone.
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      return true;
    } catch {
      /* fall through to plain text */
    }
  }
  return copyText(text);
}

/** "Move to" needs the Prism Server (the legacy desktop talks to the vault directly and has no such route). */
export const canMoveBlocksToPage = (): boolean => !isDesktop;

/** A fresh idempotency key for one "Move to" invocation. */
export function newMoveRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return (c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
}

export class MoveBlocksError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/**
 * "Move to" another page (NP-ED-02): `POST /api/notes/:id/blocks/append`. The
 * SERVER appends — through the live document when that page is open (its unsaved
 * typing survives), else with compare-and-set, converting to Markdown for a
 * Markdown page. It goes through `serverFetch`, never the VaultClient (whose
 * writes may be queued in the offline outbox): this resolves ONLY on a confirmed
 * 200, so the caller removes the source block knowing the target has it. The
 * same `requestId` is safe to send again (it appends once).
 */
export async function appendBlocksToPage(targetId: string, html: string, requestId: string): Promise<{ live: boolean }> {
  let res: Response;
  try {
    res = await serverFetch(`/api/notes/${encodeURIComponent(targetId)}/blocks/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, requestId }),
    });
  } catch {
    throw new MoveBlocksError(0, "offline");
  }
  let body: { ok?: boolean; live?: boolean; error?: string } | null = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status !== 200 || body?.ok !== true) throw new MoveBlocksError(res.status, body?.error ?? `http_${res.status}`);
  return { live: !!body.live };
}

const HAS_ATTACHMENT = /\/api\/attachments\/a_[A-Za-z0-9_-]{22}/;

/**
 * Files in the moved blocks still belong to the page they came from: readable
 * only by people who can view THAT page. Give the target its own copies (the
 * attachment copy route). Returns a sentence for the confirmation when that could
 * not be done (the target is open live, a quota, no route) — never throws.
 */
export async function carryAttachments(client: VaultClient | null, targetId: string, html: string): Promise<string | null> {
  if (!HAS_ATTACHMENT.test(html)) return null;
  const limitation = "Its files still belong to the original page: people who can’t open that page won’t see them.";
  if (!client?.copyAttachments) return limitation;
  try {
    for (let round = 0; round < 4; round++) {
      const r = await client.copyAttachments(targetId);
      if (r.failed > 0) return "Some files could not be copied to that page.";
      if (!r.more) return null;
    }
    return limitation;
  } catch {
    return limitation;
  }
}

export function moveFailureText(e: unknown, title: string): string {
  const code = e instanceof MoveBlocksError ? e.code : "";
  const status = e instanceof MoveBlocksError ? e.status : 0;
  if (status === 0) return `You’re offline — nothing was moved. The block is still here.`;
  if (status === 403 || status === 404) return `You can’t add to ${title}. The block is still here.`;
  if (code === "locked") return `${title} is locked. The block is still here.`;
  if (status === 413) return `${title} is full. The block is still here.`;
  return `Couldn’t move to ${title}. The block is still here.`;
}

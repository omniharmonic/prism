/**
 * Sharing tools (Architecture v2 WP6.4): `prism_note_access`, `prism_share`.
 *
 * These reach the acl router's SCOPED-SHARE routes through `ctx.dispatchShare`
 * (see dispatch.ts for why that is an exact /acl allowlist rather than /api
 * wrappers): the router's own gate (admin, or the `share` cap on the addressed
 * note/tag) and its anti-escalation (`denyEscalation`: subset rule, existing
 * accounts only for non-admins) run unchanged.
 *
 * MCP is STRICTER than the web app in one respect: nobody — not even the owner —
 * can invite a new person through it. Sharing is to people who already have an
 * account; a stranger's address is refused BEFORE any grant is written (the acl
 * handler would otherwise create a placeholder user + invite for an admin).
 * Capability-link URLs (signed bearer tokens) and invite URLs are never returned.
 */
import * as z from "zod/v4";
import { hasAccount } from "../db";
import { CAPS, LEVELS, grantCaps } from "../permissions";
import { roleFloor } from "../roles";
import type { McpPrincipal } from "./auth";
import { jsonOrToolError } from "./dispatch";
import { ToolError } from "./errors";
import { defineTool, type PrismTool } from "./tools";

const enc = encodeURIComponent;

/** Early gate: admins, or anyone holding `share` somewhere. The acl router re-checks per resource. */
function canShareAnywhere(p: McpPrincipal): boolean {
  if (p.actor.kind !== "user") return false;
  if (roleFloor(p.actor.role)) return true;
  return p.actor.grants.some((g) => new Set(grantCaps(g)).has("share"));
}

export const noteAccessTool = defineTool({
  name: "prism_note_access",
  scope: "read",
  title: "Who has access to a note",
  description:
    "Show who can access one note: people with a direct grant (email + level), tag grants that reach it, its visibility and " +
    "creator, and the number of share links (their URLs are never returned). Needs the `share` capability on the note (or admin).",
  inputSchema: z.object({ id: z.string().min(1).max(200) }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: canShareAnywhere,
  async handler({ id }, ctx) {
    const r = await jsonOrToolError<Record<string, any>>(await ctx.dispatchShare(`/acl/notes/${enc(id)}`));
    return {
      note: r.note,
      people: r.people ?? [],
      tagAccess: r.tagAccess ?? [],
      links: { count: Array.isArray(r.links) ? r.links.length : 0 }, // never the signed URLs
    };
  },
});

export const shareTool = defineTool({
  name: "prism_share",
  scope: "write",
  title: "Share a note or tag with a person",
  description:
    "Give an EXISTING Prism account access to one note (`id`) or everything under a tag (`tag`) — exactly one of the two — at a " +
    "`level` (view < comment < suggest < edit < own) or an explicit `caps` list. You need the `share` capability there, and you " +
    "can only hand out capabilities you hold yourself. New people cannot be invited through MCP: an email with no account is " +
    "refused. This notifies no one but immediately widens who can read/change the content — be deliberate.",
  inputSchema: z.object({
    id: z.string().min(1).max(200).optional().describe("Note id (exclusive with tag)"),
    tag: z.string().min(1).max(200).optional().describe("Tag/folder (exclusive with id)"),
    email: z.string().min(3).max(320),
    level: z.enum(LEVELS as unknown as [string, ...string[]]).optional(),
    caps: z.array(z.enum(CAPS as unknown as [string, ...string[]])).min(1).optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  access: canShareAnywhere,
  async handler(a, ctx) {
    if (Boolean(a.id) === Boolean(a.tag)) throw new ToolError("invalid_request", "give exactly one of `id` or `tag`");
    if (!a.level && !a.caps) throw new ToolError("invalid_request", "give a `level` or a `caps` list");
    const email = a.email.trim().toLowerCase();
    if (!/^.+@.+\..+$/.test(email)) throw new ToolError("invalid_request", "that is not an email address");
    if (!hasAccount(email)) {
      throw new ToolError("invalid_request", "that person has no Prism account — inviting new people is not available through MCP (ask a workspace admin)");
    }
    const path = a.id ? `/acl/notes/${enc(a.id)}/people` : `/acl/tags/${enc(a.tag!)}/people`;
    const res = await ctx.dispatchShare(path, { method: "PUT", body: JSON.stringify({ email, level: a.level, caps: a.caps }) });
    if (res.status === 403) {
      const b = (await res.json().catch(() => ({}))) as { reason?: string };
      throw new ToolError("forbidden", b.reason ?? "you may not share this");
    }
    const r = await jsonOrToolError<Record<string, any>>(res);
    return { ok: true, email: r.email, level: r.level, caps: r.caps ?? null, target: a.id ? { note: a.id } : { tag: a.tag } };
  },
});

export const SHARING_TOOLS = [noteAccessTool, shareTool] as unknown as PrismTool[];

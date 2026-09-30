/**
 * Shared EARLY (cosmetic) access gates for MCP tools: "does any grant/role give
 * this cap somewhere?" — used to hide tools a principal could never use. The
 * per-note decision is always the gateway's (or, for Yjs paths, `collabAccess`).
 */
import { grantCaps, type Cap } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import type { McpPrincipal } from "./auth";

export function hasCapAnywhere(p: McpPrincipal, ...wanted: Cap[]): boolean {
  if (roleFloor(p.actor.role)) return true; // owner/admin: every cap on every note
  for (const g of p.actor.grants) {
    const caps = new Set(grantCaps(g));
    if (wanted.some((c) => caps.has(c))) return true;
  }
  return false;
}
export const canView = (p: McpPrincipal) => hasCapAnywhere(p, "view");
export const isAdmin = (p: McpPrincipal) => roleAtLeast(p.actor.role, "admin");

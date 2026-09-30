/**
 * `prism_whoami` — the one WP6.1 tool, proving the path end-to-end: who the MCP
 * caller is to Prism, which vault it is bound to, and what it may do there.
 * No secrets: credential ids and expiries only, never token material.
 *
 * The caps summary is computed with the SAME permission code as the gateway:
 * `effectiveCaps(actor.grants, note, roleFloor(role), subject)`. "everywhere" is
 * that function evaluated on a tagless probe note — i.e. exactly the caps that
 * hold on EVERY (non-private) note in the vault: the role floor plus whole-vault
 * grants. Per-grant caps come from `grantCaps`, the gateway's own expansion.
 */
import * as z from "zod/v4";
import { resolveVaultEntry } from "../db";
import { effectiveCaps, grantCaps, CAPS, type Cap } from "../permissions";
import { roleFloor } from "../roles";
import { defineTool } from "./tools";

const MAX_GRANTS = 200;
const ordered = (caps: Iterable<Cap>): Cap[] => {
  const set = new Set(caps);
  return CAPS.filter((c) => set.has(c));
};

export const whoamiTool = defineTool({
  name: "prism_whoami",
  scope: "read",
  title: "Who am I (Prism)",
  description:
    "Describe the Prism account this MCP connection acts as: account email and workspace role, the vault it is bound to, " +
    "how it authenticated, whether it is read-only, and a summary of its capabilities (caps that apply everywhere in the " +
    "vault, plus each explicit grant). Takes no arguments.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: () => true, // every authenticated principal may ask who it is
  async handler(_args, { principal }) {
    const { actor } = principal;
    const entry = resolveVaultEntry(actor.vaultId);
    const everywhere = effectiveCaps(actor.grants, { id: "\u0000whoami-probe", tags: [] }, roleFloor(actor.role), actor.email);
    const grants = actor.grants.slice(0, MAX_GRANTS).map((g) => ({
      resourceType: g.resource_type,
      resource: g.resource,
      caps: ordered(grantCaps(g)),
      expiresAt: g.expires_at ?? null,
    }));
    return {
      kind: actor.kind,
      email: actor.email,
      role: actor.role,
      vault: { id: entry.id, label: entry.label },
      auth: {
        via: principal.via,
        credentialId: principal.credentialId,
        expiresAt: principal.expiresAt,
        vaultBound: principal.vaultBound,
      },
      readOnly: principal.readOnly,
      caps: {
        everywhere: ordered(everywhere),
        grants,
        grantCount: actor.grants.length,
        truncated: actor.grants.length > MAX_GRANTS,
      },
    };
  },
});

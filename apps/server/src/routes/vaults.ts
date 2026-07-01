/**
 * Vault switcher listing (multi-tenancy Phase 1.5). Returns the workspaces the
 * ACTOR belongs to — never their tokens or upstream URLs. The server owner
 * (OWNER_EMAIL) manages the whole registry, so they see every vault; any other
 * signed-in user sees only the vaults they're a MEMBER of (memberships row) or
 * hold a direct grant in (a guest invited to one workspace sees exactly one).
 * Anon/capability-link actors are denied so the registry can't be enumerated.
 *
 * Mounted under /api BEFORE the gateway `api` group (like /api/p), so the owner
 * short-circuit inside `api` never proxies /api/vaults to the vault (which has
 * no such route).
 */
import { Hono } from "hono";
import { getVaultRegistry, membershipsForUser, vaultIdsWithGrantsForUser } from "../db";
import { resolveActor } from "../auth/actor";
import { workspaceRole } from "../roles";
import { config } from "../config";

export const vaults = new Hono();

vaults.get("/vaults", (c) => {
  const actor = resolveActor(c);
  // Only a signed-in user has a stable identity to scope workspaces to; a bare
  // capability link is bound to one resource, not a workspace membership set.
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  const email = actor.email;
  const isServerOwner = email === config.ownerEmail;

  // The workspaces this user belongs to: membership rows ∪ direct-grant vaults
  // (∪ the primary bootstrap for the server owner, who owns it without a row).
  const mine = new Set<string>();
  for (const m of membershipsForUser(email)) mine.add(m.vault_id);
  for (const vid of vaultIdsWithGrantsForUser(email)) mine.add(vid);
  if (isServerOwner) mine.add("primary");

  const registry = getVaultRegistry();
  // The server owner manages the whole registry (env + owner-added); everyone
  // else is filtered to the vaults they belong to. NEVER include token or url.
  const visible = isServerOwner ? registry : registry.filter((v) => mine.has(v.id));
  const activeId = actor.vaultId;

  return c.json(
    visible.map((v) => ({
      id: v.id,
      label: v.label,
      vault: v.vault,
      active: v.id === activeId,
      // The server owner has full token-free passthrough to every registry vault,
      // so surface "owner" (their real reach) rather than the literal membership
      // role — the switcher gates admin UI on this, and passthrough IS admin.
      role: isServerOwner ? "owner" : workspaceRole(email, v.id),
    })),
  );
});

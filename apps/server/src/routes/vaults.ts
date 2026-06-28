/**
 * Owner-only vault registry listing (multi-vault Phase 1). Powers the web
 * VaultsPanel / owner switcher: it returns the vaults this server can bind to,
 * never their tokens or upstream URLs. A non-owner (capability link, anon, or a
 * signed-in non-owner) is denied so the registry can't be enumerated.
 *
 * Mounted under /api BEFORE the gateway `api` group (like /api/p), so the owner
 * short-circuit inside `api` never proxies /api/vaults to the vault (which has
 * no such route).
 */
import { Hono } from "hono";
import { vaultRegistry } from "../config";
import { resolveActor } from "../auth/actor";

export const vaults = new Hono();

vaults.get("/vaults", (c) => {
  if (!resolveActor(c).isOwner) return c.json({ error: "forbidden" }, 403);
  // active = the primary/default (first registry entry), which every non-owner
  // route and the legacy vault client bind to. NEVER include token or url.
  return c.json(
    vaultRegistry.map((v, i) => ({
      id: v.id,
      label: v.label,
      vault: v.vault,
      active: i === 0,
    })),
  );
});

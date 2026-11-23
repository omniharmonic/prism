import type { Context } from "hono";
import { config } from "../config";
import { resolveActor, type Actor } from "../auth/actor";
import { resolveVaultEntry } from "../db";
import { consumeRateLimit } from "../middleware/ratelimit";

export type UserActor = Extract<Actor, { kind: "user" }>;
export type CommsGuard = { ok: true; actor: UserActor; vaultId: string } | { ok: false; res: Response };

/**
 * Every /api/comms/* handler starts here: flag, owner, primary vault, no-store,
 * and a 600/min per-owner rate limit. `limit` swaps the bucket: the media proxy
 * uses its own (`comms-media`, 3000/min) so a thumbnail grid never spends the
 * JSON API's budget.
 */
export function requireCommsOwner(c: Context, limit: { bucket: string; perMinute: number } = { bucket: "comms", perMinute: 600 }): CommsGuard {
  c.header("Cache-Control", "private, no-store");
  if (!config.commsEnabled) return { ok: false, res: c.json({ error: "comms_disabled" }, 404) };
  const actor = resolveActor(c);
  if (actor.kind !== "user" || actor.email !== config.ownerEmail) return { ok: false, res: c.json({ error: "forbidden" }, 403) };
  const primary = resolveVaultEntry(undefined);
  const asked = c.req.header("X-Prism-Vault");
  if (actor.vaultId !== primary.id || (asked && asked !== primary.id))
    return { ok: false, res: c.json({ error: "source_vault_unavailable" }, 409) };
  const limited = consumeRateLimit(`${limit.bucket}:${actor.email}`, limit.perMinute, 60_000);
  if (limited) {
    c.header("Retry-After", String(limited));
    return { ok: false, res: c.json({ error: "rate_limited" }, 429) };
  }
  return { ok: true, actor, vaultId: primary.id };
}

/**
 * Workspace roles — the management tier that sits ABOVE the per-note `Level`
 * ladder (permissions.ts). A role answers "what may this person do to the
 * WORKSPACE" (manage members, publish, federate, settings) and supplies a FLOOR
 * on their per-note effective level; grants then raise individual notes/tags
 * above that floor.
 *
 * Phase 1 backs this with a real per-vault `memberships` table
 * (`workspaceRole(email, vaultId)`), reconciled with the hub's `user_vaults`. The
 * env `OWNER_EMAIL` remains the bootstrap owner of the primary vault even with no
 * membership row, so an upgraded single-vault deploy is unchanged.
 */
import type { Level } from "./permissions";
import { config } from "./config";
import { getMembershipRole } from "./db";

export type Role = "owner" | "admin" | "member" | "guest";

/** Ordered weakest → strongest. */
export const ROLES: readonly Role[] = ["guest", "member", "admin", "owner"] as const;

const isRole = (s: string | null): s is Role => s != null && (ROLES as readonly string[]).includes(s);

/**
 * The authoritative workspace role for (email, vault). The env OWNER_EMAIL is the
 * SERVER owner — the operator who runs this box and creates/links every vault on
 * it — so they are `owner` of EVERY vault (not just primary), and can never be
 * demoted by a stray membership row. For everyone else a membership row wins; a
 * signed-in user with no membership in this vault is a guest (sees only what
 * explicit grants allow — authentication never implies authorization).
 *
 * This is the distinction the multi-vault ("workspaces") model needs: OWNER_EMAIL
 * administers all workspaces on their server, while a per-vault `owner`/`admin`
 * membership is a DELEGATED workspace owner scoped to that one vault.
 */
export function workspaceRole(email: string, vaultId: string): Role {
  if (email && email === config.ownerEmail) return "owner";
  const row = getMembershipRole(email, vaultId);
  if (isRole(row)) return row;
  return "guest";
}

export const roleRank = (r: Role): number => ROLES.indexOf(r);

/** Does `have` meet or exceed `need`? (null = no role = below everything.) */
export const roleAtLeast = (have: Role | null, need: Role): boolean =>
  have != null && roleRank(have) >= roleRank(need);

/**
 * The per-note level FLOOR a role confers. owner/admin manage the whole
 * workspace → "own" on every note (this is what replaces the `isOwner → "own"`
 * short-circuit). member/guest get no floor — they are scoped purely by their
 * grants. (A member's broad access, when wanted, is an explicit `vault` grant —
 * Phase 2 — not a role floor.)
 */
export const roleFloor = (r: Role | null): Level | null =>
  r === "owner" || r === "admin" ? "own" : null;

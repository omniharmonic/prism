/**
 * Workspace roles — the management tier that sits ABOVE the per-note `Level`
 * ladder (permissions.ts). A role answers "what may this person do to the
 * WORKSPACE" (manage members, publish, federate, settings) and supplies a FLOOR
 * on their per-note effective level; grants then raise individual notes/tags
 * above that floor.
 *
 * Phase 0: a role is derived purely from `OWNER_EMAIL` (owner) — so behavior is
 * byte-identical to the previous `isOwner` boolean, but every call site now
 * speaks `role`. Phase 1 backs this with a real per-vault `memberships` table
 * (`workspaceRole(email, vaultId)`), reconciled with the hub's `user_vaults`.
 */
import type { Level } from "./permissions";

export type Role = "owner" | "admin" | "member" | "guest";

/** Ordered weakest → strongest. */
export const ROLES: readonly Role[] = ["guest", "member", "admin", "owner"] as const;

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

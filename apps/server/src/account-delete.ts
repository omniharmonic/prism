/**
 * Account deletion (App Store rule 5.1.1(v); contract: docs/account-deletion.md).
 *
 * A signed-in account deletes ITSELF. What happens, in order:
 *
 *  1. Its PRIVATE pages (`prism_visibility: private` + `prism_creator` = the account) in every
 *     vault it belongs to are moved to the Trash through the trash route's own write + ledger
 *     (`trashPageOfDeletedAccount`) and handed to the SERVER OWNER, still private — so the
 *     server owner can restore or purge them inside the normal trash retention, and nobody
 *     else can see them. If any vault cannot be read or written, NOTHING of the account is
 *     deleted (the caller answers 503; a retry continues — a page already handed over is no
 *     longer the account's and is not looked at again).
 *  2. Its devices are revoked through `revokeDevice` (PATs minted through a device, its APNs
 *     row and the hub MCP tokens recorded with it go too), and its legacy hub MCP tokens are
 *     revoked at the hub.
 *  3. One SQLite transaction removes every row that IS the account or belongs only to it
 *     (`deleteAccountRows`). Rows that record what it did for OTHERS stay: grants it made,
 *     notifications it caused in someone's Inbox (their author becomes "Someone"), decided
 *     access requests (the decider is forgotten), comments and edits in shared pages (writer
 *     stamps resolve to nothing once the user row is gone).
 *
 * Counts only leave this module — never an email, a title or an id of a page.
 */
import { db, getVaultRegistry, listLiveDeviceTokens } from "./db";
import { config, type VaultEntry } from "./config";
import { revokeDevice } from "./auth/device";
import { revokeVaultToken } from "./mcp-token";
import { notifyAccessChanged } from "./access-events";
import { vaultClient, type Note } from "./parachute";
import { TREE_META_KEYS } from "./tree";
import { trashPageOfDeletedAccount } from "./pages";
// Side effect: these modules create the tables the transaction below writes to.
import "./notifications";

/** What `trashed_by` / `prism_trashed_by` say for a page of a deleted account (never its email). */
export const DELETED_ACCOUNT_LABEL = "deleted-account";

export interface PrivatePageCounts {
  /** Private pages moved to the Trash now. */
  trashed: number;
  /** Private pages that were already in the Trash and only changed hands. */
  reassigned: number;
  /** Vaults that were looked through. */
  vaults: number;
}

export interface AccountRowCounts {
  sessions: number;
  devices: number;
  pats: number;
  pushSubscriptions: number;
  apnsTokens: number;
  notifications: number;
  notificationSettings: number;
  pageLevels: number;
  reminders: number;
  accessRequests: number;
  invites: number;
  grants: number;
  memberships: number;
  commentParticipants: number;
  integrationSecrets: number;
  pagePreferences: number;
  mcpTokens: number;
  user: number;
}

/** The vaults a private page of this account can be in: every vault it is a member of or holds
 *  a grant in, plus the primary vault (an account with no row anywhere still had one there). */
function vaultsOf(email: string): VaultEntry[] {
  const ids = new Set<string>(["primary"]);
  for (const r of db.prepare("SELECT vault_id FROM memberships WHERE email = ?").all(email) as Array<{ vault_id: string }>) ids.add(r.vault_id);
  for (const r of db.prepare("SELECT DISTINCT vault_id FROM grants WHERE subject_type = 'user' AND subject = ?").all(email) as Array<{ vault_id: string | null }>) ids.add(r.vault_id ?? "primary");
  return getVaultRegistry().filter((v) => ids.has(v.id));
}

const isOwnPrivate = (n: Note, email: string): boolean =>
  n.metadata?.prism_visibility === "private" && typeof n.metadata?.prism_creator === "string" && (n.metadata.prism_creator as string).trim().toLowerCase() === email;

/**
 * Step 1. Throws on the first vault that cannot be listed or written — the caller then deletes
 * nothing. One lean listing per vault (no bodies), one compare-and-set write per private page.
 */
export async function trashPrivatePagesOf(email: string, opts: { timeoutMs?: number } = {}): Promise<PrivatePageCounts> {
  const counts: PrivatePageCounts = { trashed: 0, reassigned: 0, vaults: 0 };
  for (const entry of vaultsOf(email)) {
    const notes = await vaultClient(entry.id, { timeoutMs: opts.timeoutMs ?? 30_000 }).listNotes({ includeMetadata: [...TREE_META_KEYS] });
    counts.vaults++;
    for (const n of notes) {
      if (!isOwnPrivate(n, email)) continue;
      const r = await trashPageOfDeletedAccount(entry, n, config.ownerEmail, DELETED_ACCOUNT_LABEL);
      counts[r]++;
    }
  }
  return counts;
}

/** Step 2: every credential that is not a plain row. Hub revocations are best-effort (logged);
 *  a token the hub would not revoke stays listed for the owner (Network → Server, legacy tokens). */
export async function revokeAccountCredentials(email: string): Promise<{ devices: number; mcpTokensFailed: number }> {
  let devices = 0;
  // "session": an account deletion never opens the first-device door (the history row goes anyway).
  for (const d of listLiveDeviceTokens(email)) if (await revokeDevice(d.id, "session")) devices++;
  let mcpTokensFailed = 0;
  const live = db.prepare("SELECT jti FROM mcp_tokens WHERE email = ? AND revoked_at IS NULL").all(email) as Array<{ jti: string }>;
  for (const t of live) {
    try {
      await revokeVaultToken(t.jti);
      db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE jti = ?").run(Date.now(), t.jti);
    } catch (e) {
      mcpTokensFailed++;
      console.error(`[account-delete] revoking an MCP hub token failed: ${(e as Error).message}`);
    }
  }
  return { devices, mcpTokensFailed };
}

/** Step 3: one transaction over every row that is the account's own. */
export const deleteAccountRows = db.transaction((email: string): AccountRowCounts => {
  const run = (sql: string, ...args: unknown[]): number => db.prepare(sql).run(...args).changes;
  const deviceIds = (db.prepare("SELECT id FROM device_tokens WHERE email = ?").all(email) as Array<{ id: string }>).map((r) => r.id);
  let apnsTokens = run("DELETE FROM apns_tokens WHERE owner_email = ?", email);
  for (const id of deviceIds) apnsTokens += run("DELETE FROM apns_tokens WHERE device_id = ?", id);
  const counts: AccountRowCounts = {
    sessions: run("DELETE FROM sessions WHERE email = ?", email),
    apnsTokens,
    pats: run("DELETE FROM mcp_pats WHERE email = ?", email),
    devices: run("DELETE FROM device_tokens WHERE email = ?", email),
    pushSubscriptions: run("DELETE FROM push_subscriptions WHERE email = ?", email),
    notifications: run("DELETE FROM notifications WHERE recipient = ?", email),
    notificationSettings: run("DELETE FROM notification_settings WHERE email = ?", email),
    pageLevels: run("DELETE FROM notification_page_levels WHERE email = ?", email),
    reminders: run("DELETE FROM reminders WHERE owner_email = ?", email),
    accessRequests: run("DELETE FROM access_requests WHERE requester = ?", email),
    // Unused invites it sent, and unused invites addressed to it (they would re-open the account).
    invites: run("DELETE FROM invites WHERE accepted_at IS NULL AND (created_by = ? OR email = ?)", email, email),
    // Grants whose SUBJECT is this account. Grants it MADE for others stay (created_by kept).
    grants: run("DELETE FROM grants WHERE subject_type = 'user' AND subject = ?", email),
    memberships: run("DELETE FROM memberships WHERE email = ?", email),
    commentParticipants: run("DELETE FROM comment_participants WHERE email = ?", email),
    integrationSecrets: run("DELETE FROM tenant_secrets WHERE owner_email = ?", email),
    pagePreferences: run("DELETE FROM page_preferences WHERE email = ?", email),
    // Revoked hub tokens are forgotten; one the hub would not revoke stays for the owner to see.
    mcpTokens: run("DELETE FROM mcp_tokens WHERE email = ? AND revoked_at IS NOT NULL", email),
    user: run("DELETE FROM users WHERE email = ?", email),
  };
  run("DELETE FROM device_auth_codes WHERE email = ?", email);
  run("DELETE FROM device_account_history WHERE email = ?", email);
  run("DELETE FROM magic_links WHERE email = ?", email);
  run("DELETE FROM notification_email_log WHERE email = ?", email);
  // What it did for others stays, without its address.
  run("UPDATE notifications SET actor_email = NULL WHERE actor_email = ?", email);
  run("UPDATE access_requests SET decided_by = NULL WHERE decided_by = ?", email);
  return counts;
});

/** Steps 2 + 3, after step 1 succeeded. Tells collab sockets and caches that access changed. */
export async function removeAccount(email: string): Promise<AccountRowCounts & { mcpTokensFailed: number }> {
  const revoked = await revokeAccountCredentials(email);
  const rows = deleteAccountRows(email);
  notifyAccessChanged();
  return { ...rows, devices: Math.max(rows.devices, revoked.devices), mcpTokensFailed: revoked.mcpTokensFailed };
}

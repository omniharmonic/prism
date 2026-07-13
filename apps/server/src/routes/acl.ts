/**
 * Access-control management — owner-only. Lives at /acl/* (NOT /api, whose
 * owner-passthrough would proxy to the vault; NOT /share, which is the public
 * read view). Backs the share dialog: per-note people grants, capability links
 * (Google-Docs "anyone with the link"), note↔tag membership, and tag-grants
 * ("share everything tagged X with this person"). Authorization for the shared
 * content itself is still enforced by the /api gateway via these grants.
 */
import { Hono } from "hono";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { config } from "../config";
import { vault, vaultClient, VaultError } from "../parachute";
import { resolveActor } from "../auth/actor";
import { signCapability } from "../auth/capability";
import { serverKeyPair, fingerprint } from "../auth/peer";
import { LEVELS, type Level } from "../permissions";
import { roleAtLeast } from "../roles";
import {
  ensureUser,
  hasAccount,
  listUsers,
  upsertGrant,
  removeGrant,
  removeGrantBySubjectResource,
  grantsForResource,
  grantsForPeer,
  createCapability,
  capabilitiesForResource,
  deleteCapability,
  createPublication,
  getPublicationBySlug,
  getPublicationByResource,
  listPublications,
  excludedNoteIds,
  deletePublication,
  storePairing,
  listPeers,
  removePeer,
  setPeerCollabUrl,
  getPeer,
  createSpace,
  getSpace,
  listSpaces,
  deleteSpace,
  upsertFederatedNote,
  federatedNotesForSpace,
  deleteFederatedNote,
  getFederatedByKey,
  listMirrorRequests,
  getMirrorRequest,
  setMirrorRequestStatus,
  updatePublication,
  listSuggestions,
  getSuggestion,
  setSuggestionStatus,
  deleteSuggestion,
  getFederationEnabled,
  setFederationEnabled,
  addVaultEntry,
  getVaultRegistry,
  removeVaultEntry,
  listMemberships,
  setMembership,
  removeMembership,
  listGrantsForVault,
  getGrantById,
  listPeerEdits,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  assignVaultToWorkspace,
  vaultsForWorkspace,
  workspaceForVault,
  DEFAULT_WORKSPACE_ID,
  createVaultMirror,
  listVaultMirrors,
  getVaultMirror,
  updateVaultMirror,
  removeVaultMirror,
  removeVaultMirrorsForVault,
  type MirrorDeleteMode,
  type VaultMirror,
  type Space,
} from "../db";
import { runVaultMirrorOnce } from "../worker/vault-mirror";
import { startWorker } from "../worker/scheduler";
import { vaultRegistry } from "../config";
import { createVaultViaCli, seedVault } from "../vault-provision";
import { noteKind } from "../collab";
import { normalizePathPrefix, pathInPrefix } from "../paths";
import { hashPassword } from "../auth/password";
import { createInvite } from "../auth/invite";
import { getSecret, secretsConfigured } from "../secrets";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, copyFile } from "node:fs/promises";
const pexec = promisify(execFile);

/** Grant a person access to a resource, inviting them if they have no account
 *  yet so the access binds to a real, authenticated identity. */
async function grantAndInvite(
  email: string,
  level: Level,
  resourceType: "note" | "tag",
  resource: string,
  owner: string,
  vaultId: string,
): Promise<{ invited: boolean; inviteUrl?: string }> {
  ensureUser(email);
  upsertGrant({ vault_id: vaultId, subject_type: "user", subject: email, resource_type: resourceType, resource, level, created_by: owner });
  if (!hasAccount(email)) {
    // Return the accept URL so the owner can hand it over directly — email may
    // not be configured/paid, and even when it is, "copy invite link" is useful.
    const inviteUrl = await createInvite(email, null, owner);
    return { invited: true, inviteUrl };
  }
  return { invited: false };
}

export const acl = new Hono();

// Everything here is owner/admin-only (workspace management).
acl.use("*", async (c, next) => {
  if (!roleAtLeast(resolveActor(c).role, "admin")) return c.json({ error: "forbidden" }, 403);
  await next();
});

const isLevel = (x: unknown): x is Level =>
  typeof x === "string" && (LEVELS as readonly string[]).includes(x);
const isEmail = (x: unknown): x is string => typeof x === "string" && /.+@.+\..+/.test(x);
const normEmail = (x: string) => x.trim().toLowerCase();

/** After any federation-relevant mutation, re-reconcile the live bridge so new
 *  bindings come up (and revoked ones tear down) without a server restart. Gated
 *  + lazy so the @hocuspocus/provider client never loads on a non-federation
 *  deployment; failures are swallowed (best-effort — never block the ACL write). */
function kickFederationSync(): void {
  if (!getFederationEnabled()) return;
  void import("../federation-manager")
    .then(({ federationManager }) => federationManager.syncSpaces())
    .catch((e) => console.error("[federation] syncSpaces after ACL change failed:", e));
}

/** Capability-link URL: opens the FOCUSED collaborative document (Google-Docs
 *  style) — just the doc, level-aware (read-only for viewers, comments sidebar,
 *  suggest mode), live via Hocuspocus. NOT the full workspace. The token is the
 *  only credential the recipient needs. */
function linkUrl(noteId: string, token: string): string {
  return `${config.appOrigin}/collab/${encodeURIComponent(noteId)}?t=${encodeURIComponent(token)}`;
}

function deriveTitle(content: string): string {
  const c = content ?? "";
  const h = c.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (h?.[1]) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 120) || "Untitled";
  if (!c.includes("<")) {
    const line = c.split("\n").find((l) => l.trim().length > 0);
    if (line) return line.replace(/^#+\s*/, "").trim().slice(0, 120);
  }
  const text = c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 100) || "Untitled";
}

acl.get("/users", (c) => c.json(listUsers()));

// ── Vault registry management (multi-vault: in-app create / link) ────────────
// Owner-only (the whole /acl group is). Tokens are written to SQLite server-side
// and NEVER returned — the response is the same token-free summary as GET
// /api/vaults: { id, label, vault, active:false } (added vaults are never the
// primary/active one, which stays the env entry[0]).
const vaultSlug = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/** A registry-unique id derived from the label (random suffix on collision). */
function uniqueVaultId(label: string): string {
  let id = vaultSlug(label) || randomUUID().slice(0, 8);
  const taken = new Set(getVaultRegistry().map((v) => v.id));
  while (taken.has(id)) id = `${vaultSlug(label) || "vault"}-${Math.floor(Math.random() * 10000)}`;
  return id;
}

/** Probe a linked vault is reachable with the given token (GET /tags). Returns
 *  true on a 2xx, false on any error/non-2xx — best-effort guard, not auth. */
async function probeVault(url: string, vault: string, token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/vault/${encodeURIComponent(vault)}/api/tags`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

acl.post("/vaults", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const mode = body.mode;

  if (mode === "link") {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
    const vault = typeof body.vault === "string" ? body.vault.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!label || !vault || !token) return c.json({ error: "bad_request", detail: "label, vault and token are required" }, 400);
    if (!/^https?:\/\//i.test(url)) return c.json({ error: "bad_request", detail: "url must be http(s)" }, 400);
    if (!(await probeVault(url, vault, token))) return c.json({ error: "unreachable" }, 400);
    const id = uniqueVaultId(label);
    addVaultEntry({ id, label, url, vault, token });
    return c.json({ id, label, vault, active: false });
  }

  if (mode === "create") {
    if (!config.allowVaultCreate) return c.json({ error: "disabled", detail: "vault creation is disabled on this server" }, 403);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!label || !name) return c.json({ error: "bad_request", detail: "label and name are required" }, 400);
    if (!/^[a-z0-9_-]+$/.test(name)) return c.json({ error: "bad_request", detail: "name must match ^[a-z0-9_-]+$" }, 400);

    let created: { name: string; token: string };
    try {
      created = await createVaultViaCli(name);
    } catch (e) {
      // The failure happens BEFORE any token is minted (creation failed), so the
      // message can't carry a token; still, log server-side and keep detail terse.
      console.error("[vaults] parachute-vault create failed:", e);
      return c.json({ error: "create_failed", detail: (e as Error).message }, 500);
    }

    const url = config.parachuteUrl;
    const id = uniqueVaultId(label);
    addVaultEntry({ id, label, url, vault: name, token: created.token });

    if (body.seedSchemas !== false) {
      try {
        await seedVault({ vaultUrl: url, vault: name, token: created.token });
      } catch (e) {
        console.error("[vaults] seedTagSchemas failed (non-fatal):", e);
      }
    }
    return c.json({ id, label, vault: name, active: false });
  }

  return c.json({ error: "bad_request", detail: "mode must be 'link' or 'create'" }, 400);
});

// Remove an owner-ADDED vault. Env-configured vaults (e.g. "primary") are not in
// the prism_vaults table, so removeVaultEntry no-ops on them and the merged
// registry keeps the env entry — i.e. an env vault can never be deleted here.
acl.delete("/vaults/:id", (c) => {
  const id = c.req.param("id");
  if (vaultRegistry.some((v) => v.id === id)) {
    return c.json({ error: "forbidden", detail: "cannot remove an env-configured vault" }, 400);
  }
  // Mirrors referencing this vault must die with it: an orphaned mirror would
  // silently retarget the primary vault (resolveVaultEntry fallback) and its
  // delete-verify would then mass-archive/delete the destination copies.
  const mirrorsDropped = removeVaultMirrorsForVault(id);
  if (mirrorsDropped) console.log(`[vaults] removed ${mirrorsDropped} mirror(s) referencing deleted vault ${id}`);
  removeVaultEntry(id);
  return c.json({ ok: true, mirrorsRemoved: mirrorsDropped });
});

// ── Vault mirrors (single-server vault-to-vault folder sync) ─────────────────
// A mirror converges a folder (path prefix) of one registry vault onto a prefix
// in another vault on this server — one-way, source-wins, structure preserved.
// Config rows only; the sync itself runs in the worker (src/worker/vault-mirror.ts)
// and on demand via POST /acl/mirrors/:id/sync.
//
// SERVER-OWNER only (not just the /acl admin gate): a mirror names arbitrary
// src/dest vaults and the engine writes with the server's own vault tokens, so
// a mere vault-admin could otherwise exfiltrate another tenant's vault into one
// they control. Same posture as the workspace routes.
acl.use("/mirrors/*", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});
acl.use("/mirrors", async (c, next) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  await next();
});

const isDeleteMode = (x: unknown): x is MirrorDeleteMode =>
  x === "archive" || x === "delete" || x === "keep";

/** Client view of a mirror row: last_result JSON parsed, nothing secret to strip. */
function mirrorView(m: VaultMirror): Record<string, unknown> {
  let lastResult: unknown = null;
  if (m.last_result) {
    try {
      lastResult = JSON.parse(m.last_result);
    } catch {
      lastResult = m.last_result;
    }
  }
  return { ...m, last_result: lastResult };
}

acl.get("/mirrors", (c) => c.json(listVaultMirrors().map(mirrorView)));

acl.post("/mirrors", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const srcVault = typeof body.srcVault === "string" ? body.srcVault.trim() : "";
  const destVault = typeof body.destVault === "string" ? body.destVault.trim() : "";
  const srcPrefix = typeof body.srcPrefix === "string" ? normalizePathPrefix(body.srcPrefix) : null;
  const destPrefix = typeof body.destPrefix === "string" ? normalizePathPrefix(body.destPrefix) : null;
  if (!srcVault || !destVault) return c.json({ error: "bad_request", detail: "srcVault and destVault are required" }, 400);
  if (!srcPrefix || !destPrefix) return c.json({ error: "bad_request", detail: "srcPrefix and destPrefix must be valid path prefixes" }, 400);
  if (body.deleteMode !== undefined && !isDeleteMode(body.deleteMode)) {
    return c.json({ error: "bad_request", detail: "deleteMode must be 'archive', 'delete' or 'keep'" }, 400);
  }
  const registry = getVaultRegistry();
  for (const [name, id] of [["srcVault", srcVault], ["destVault", destVault]] as const) {
    if (!registry.some((v) => v.id === id)) return c.json({ error: "bad_request", detail: `${name} "${id}" is not a registered vault` }, 400);
  }
  // A mirror whose destination lies inside its own source (or vice versa) in the
  // SAME vault would feed itself — refuse the overlap outright.
  if (srcVault === destVault && (pathInPrefix(srcPrefix, destPrefix) || pathInPrefix(destPrefix, srcPrefix))) {
    return c.json({ error: "bad_request", detail: "source and destination prefixes overlap within the same vault" }, 400);
  }
  const actor = resolveActor(c);
  const mirror = createVaultMirror({
    src_vault: srcVault,
    src_prefix: srcPrefix,
    dest_vault: destVault,
    dest_prefix: destPrefix,
    delete_mode: isDeleteMode(body.deleteMode) ? body.deleteMode : undefined,
    created_by: actor.kind === "user" ? actor.email : null,
  });
  // The worker gate is "secrets OR mirrors exist" — creating the first mirror on
  // a secrets-less server must start the loop without a restart (idempotent).
  startWorker();
  return c.json(mirrorView(mirror));
});

acl.patch("/mirrors/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (body.deleteMode !== undefined && !isDeleteMode(body.deleteMode)) {
    return c.json({ error: "bad_request", detail: "deleteMode must be 'archive', 'delete' or 'keep'" }, 400);
  }
  const updated = updateVaultMirror(c.req.param("id"), {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    delete_mode: isDeleteMode(body.deleteMode) ? body.deleteMode : undefined,
  });
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json(mirrorView(updated));
});

acl.delete("/mirrors/:id", (c) => {
  if (!getVaultMirror(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
  removeVaultMirror(c.req.param("id"));
  return c.json({ ok: true });
});

/** Run a mirror NOW (bypasses the enabled flag and the worker cadence). */
acl.post("/mirrors/:id/sync", async (c) => {
  const mirror = getVaultMirror(c.req.param("id"));
  if (!mirror) return c.json({ error: "not_found" }, 404);
  try {
    const result = await runVaultMirrorOnce(mirror, { force: true });
    return c.json({ ok: true, result });
  } catch (e) {
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 500);
  }
});

/** Full sharing picture for a note: direct people, links, and tag-grants that
 *  currently reach it (because the note carries a granted tag). */
acl.get("/notes/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const note = await vault.getNote(id);
    const tags = note.tags ?? [];
    const people = grantsForResource("note", id)
      .filter((g) => g.subject_type === "user")
      .map((g) => ({ email: g.subject, level: g.level }));
    const links = capabilitiesForResource("note", id).map((cap) => ({
      id: cap.id,
      level: cap.level,
      label: cap.label,
      expiresAt: cap.expires_at,
      url: linkUrl(id, signCapability({ id: cap.id, exp: cap.expires_at })),
    }));
    const tagAccess: Array<{ tag: string; email?: string; subjectType: string; level: Level }> = [];
    for (const tag of tags) {
      for (const g of grantsForResource("tag", tag, resolveActor(c).vaultId)) {
        tagAccess.push({
          tag,
          email: g.subject_type === "user" ? g.subject : undefined,
          subjectType: g.subject_type,
          level: g.level,
        });
      }
    }
    const visibility = note.metadata?.prism_visibility === "private" ? "private" : "workspace";
    const creator = (note.metadata?.prism_creator as string | undefined) ?? null;
    return c.json({ note: { id, tags, title: deriveTitle(note.content), visibility, creator }, people, links, tagAccess });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "vault_error" }, 502);
  }
});

acl.put("/notes/:id/people", async (c) => {
  const { email, level } = await c.req.json<{ email?: string; level?: string }>();
  if (!isEmail(email) || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  const { invited, inviteUrl } = await grantAndInvite(normEmail(email), level, "note", c.req.param("id"), config.ownerEmail, resolveActor(c).vaultId);
  return c.json({ ok: true, email: normEmail(email), level, invited, inviteUrl });
});

acl.delete("/notes/:id/people/:email", (c) => {
  removeGrantBySubjectResource(
    "user",
    normEmail(decodeURIComponent(c.req.param("email"))),
    "note",
    c.req.param("id"),
    resolveActor(c).vaultId,
  );
  return c.json({ ok: true });
});

acl.post("/notes/:id/links", async (c) => {
  const id = c.req.param("id");
  const { level, expiresInDays, label } = await c.req.json<{
    level?: string;
    expiresInDays?: number;
    label?: string;
  }>();
  if (!isLevel(level)) return c.json({ error: "bad_request" }, 400);
  const capId = randomUUID();
  const exp = Date.now() + (expiresInDays ?? 30) * 86_400_000;
  createCapability({ id: capId, resource_type: "note", resource: id, level, label: label ?? null, expires_at: exp });
  upsertGrant({
    vault_id: resolveActor(c).vaultId,
    subject_type: "link",
    subject: capId,
    resource_type: "note",
    resource: id,
    level,
    created_by: config.ownerEmail,
  });
  return c.json({ id: capId, level, expiresAt: exp, url: linkUrl(id, signCapability({ id: capId, exp })) });
});

acl.delete("/notes/:id/links/:capId", (c) => {
  const capId = c.req.param("capId");
  deleteCapability(capId);
  removeGrantBySubjectResource("link", capId, "note", c.req.param("id"), resolveActor(c).vaultId);
  return c.json({ ok: true });
});

// Mark a note private-to-creator (or back to workspace-visible). One path for
// BOTH shells: web + desktop call this (desktop can't reach the /api gateway
// PATCH directly). Merges metadata (prism_creator preserved) and uses the vault
// client's force write, so it never 428s on the optimistic-concurrency guard.
acl.put("/notes/:id/visibility", async (c) => {
  const id = c.req.param("id");
  const { isPrivate } = await c.req.json<{ isPrivate?: boolean }>().catch(() => ({}) as { isPrivate?: boolean });
  if (typeof isPrivate !== "boolean") return c.json({ error: "bad_request", detail: "isPrivate (boolean) required" }, 400);
  const vc = vaultClient(resolveActor(c).vaultId);
  try {
    const note = await vc.getNote(id);
    await vc.updateNote(id, {
      metadata: { ...(note.metadata ?? {}), prism_visibility: isPrivate ? "private" : "workspace" },
    });
    return c.json({ ok: true, visibility: isPrivate ? "private" : "workspace" });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "vault_error" }, 502);
  }
});

// Join / leave a shared tag (so a note becomes covered by tag-grants).
acl.post("/notes/:id/tags", async (c) => {
  const { tag } = await c.req.json<{ tag?: string }>();
  if (!tag) return c.json({ error: "bad_request" }, 400);
  await vault.addTags(c.req.param("id"), [tag]);
  return c.json({ ok: true });
});

acl.delete("/notes/:id/tags/:tag", async (c) => {
  await vault.removeTags(c.req.param("id"), [decodeURIComponent(c.req.param("tag"))]);
  return c.json({ ok: true });
});

// Tag-grants: a person can access everything carrying a tag (≈ "share a folder").
acl.put("/tags/:tag/people", async (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const { email, level } = await c.req.json<{ email?: string; level?: string }>();
  if (!isEmail(email) || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  const { invited, inviteUrl } = await grantAndInvite(normEmail(email), level, "tag", tag, config.ownerEmail, resolveActor(c).vaultId);
  return c.json({ ok: true, email: normEmail(email), level, invited, inviteUrl });
});

// Who currently has access to a tag/folder in the active vault (backs the Share
// dialog's folder panel + the ProjectTree → Members deep-link, Phase 2.3).
acl.get("/tags/:tag/access", (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  return c.json(
    grantsForResource("tag", tag, resolveActor(c).vaultId).map((g) => ({
      tag,
      email: g.subject_type === "user" ? g.subject : undefined,
      subjectType: g.subject_type,
      level: g.level,
    })),
  );
});

acl.delete("/tags/:tag/people/:email", (c) => {
  removeGrantBySubjectResource(
    "user",
    normEmail(decodeURIComponent(c.req.param("email"))),
    "tag",
    decodeURIComponent(c.req.param("tag")),
    resolveActor(c).vaultId,
  );
  return c.json({ ok: true });
});

// ── Members & whole-workspace access (Phase 2) ───────────────────────────────
// Manage who belongs to THIS vault (the active X-Prism-Vault) and at what role,
// plus a whole-workspace access grant. Admin-gated by the group middleware.
acl.get("/members", (c) => {
  const vaultId = resolveActor(c).vaultId;
  const byEmail = new Map(listUsers().map((u) => [u.email, u.name]));
  return c.json(
    listMemberships(vaultId).map((m) => ({
      email: m.email,
      name: byEmail.get(m.email) ?? null,
      role: m.role,
      joinedAt: m.created_at,
    })),
  );
});

const isRoleName = (x: unknown): x is "owner" | "admin" | "member" | "guest" =>
  x === "owner" || x === "admin" || x === "member" || x === "guest";

acl.put("/members", async (c) => {
  const actor = resolveActor(c);
  const { email, role } = await c.req.json<{ email?: string; role?: string }>();
  if (!isEmail(email) || !isRoleName(role)) return c.json({ error: "bad_request" }, 400);
  setMembership(actor.vaultId, normEmail(email), role, actor.kind === "user" ? actor.email : config.ownerEmail);
  // If they have no account yet, issue an invite link the admin can hand over.
  let inviteUrl: string | undefined;
  if (!hasAccount(normEmail(email))) inviteUrl = await createInvite(normEmail(email), null, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), role, invited: !!inviteUrl, inviteUrl });
});

acl.delete("/members/:email", (c) => {
  removeMembership(resolveActor(c).vaultId, normEmail(decodeURIComponent(c.req.param("email"))));
  return c.json({ ok: true });
});

// ── Grants audit (2.2): every grant in the active vault, each revocable ──
acl.get("/grants", (c) => {
  const byEmail = new Map(listUsers().map((u) => [u.email, u.name]));
  return c.json(
    listGrantsForVault(resolveActor(c).vaultId).map((g) => ({
      id: g.id,
      subjectType: g.subject_type,
      subject: g.subject,
      subjectName: g.subject_type === "user" ? (byEmail.get(g.subject) ?? null) : null,
      resourceType: g.resource_type,
      resource: g.resource,
      level: g.level,
      grantedBy: g.created_by,
      grantedAt: g.created_at,
    })),
  );
});

acl.delete("/grants/:id", (c) => {
  // Scope the revoke to the admin's OWN vault — a grant id from another tenant
  // must not be deletable here.
  const g = getGrantById(c.req.param("id"));
  if (!g || g.vault_id !== resolveActor(c).vaultId) return c.json({ error: "not_found" }, 404);
  removeGrant(g.id);
  return c.json({ ok: true });
});

// ── Workspace (= this server) management: people × vaults (server-owner only) ──
// A WORKSPACE is the whole server — a permission boundary grouping MULTIPLE vaults
// and the people who can reach them. The per-vault /acl/members endpoints above
// manage ONE vault (the active X-Prism-Vault); these give the server owner a
// single cross-vault surface: every person, their role + access in each vault, and
// the ability to add a person to a CHOSEN vault at a chosen level in one step.
// Gated on the SERVER owner (not just any vault admin) since it spans all vaults.
function isServerOwner(c: Parameters<typeof resolveActor>[0]): boolean {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail;
}

/** The full workspace picture: the vaults on this server + every person's access
 *  matrix (per-vault management `role` and/or whole-vault access `level`). */
acl.get("/workspace", (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const vaults = getVaultRegistry().map((v) => ({ id: v.id, label: v.label, vault: v.vault }));
  const names = new Map(listUsers().map((u) => [u.email, u.name]));
  type Access = { role?: string; level?: string };
  const people = new Map<string, { email: string; name: string | null; isServerOwner: boolean; access: Record<string, Access> }>();
  const ensure = (email: string) => {
    let p = people.get(email);
    if (!p) { p = { email, name: names.get(email) ?? null, isServerOwner: email === config.ownerEmail, access: {} }; people.set(email, p); }
    return p;
  };
  // The server owner is owner of every vault (implicit — may have no rows).
  if (config.ownerEmail) {
    const owner = ensure(config.ownerEmail);
    for (const v of vaults) (owner.access[v.id] ??= {}).role = "owner";
  }
  for (const v of vaults) {
    for (const m of listMemberships(v.id)) (ensure(m.email).access[v.id] ??= {}).role = m.role;
    for (const g of listGrantsForVault(v.id)) {
      if (g.subject_type === "user" && g.resource_type === "vault") {
        (ensure(g.subject).access[v.id] ??= {}).level = g.level;
      }
    }
  }
  return c.json({ vaults, people: [...people.values()] });
});

const inRegistry = (vaultId: string): boolean => getVaultRegistry().some((v) => v.id === vaultId);

/** Give a person whole-vault ACCESS to a chosen vault at a level (view..own).
 *  This is the "add someone to the workspace → access to a chosen vault" step. */
acl.put("/workspace/access", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const { email, vaultId, level } = await c.req.json<{ email?: string; vaultId?: string; level?: string }>().catch(() => ({}) as Record<string, string>);
  if (!isEmail(email) || !isLevel(level) || typeof vaultId !== "string" || !inRegistry(vaultId)) {
    return c.json({ error: "bad_request", detail: "email, known vaultId, and level required" }, 400);
  }
  ensureUser(normEmail(email));
  upsertGrant({ vault_id: vaultId, subject_type: "user", subject: normEmail(email), resource_type: "vault", resource: vaultId, level, created_by: config.ownerEmail });
  let inviteUrl: string | undefined;
  if (!hasAccount(normEmail(email))) inviteUrl = await createInvite(normEmail(email), null, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), vaultId, level, invited: !!inviteUrl, inviteUrl });
});

acl.delete("/workspace/access/:vaultId/:email", (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const vaultId = c.req.param("vaultId");
  removeGrantBySubjectResource("user", normEmail(decodeURIComponent(c.req.param("email"))), "vault", vaultId, vaultId);
  return c.json({ ok: true });
});

/** Set a person's management ROLE in a chosen vault (owner/admin/member/guest).
 *  Distinct from access: a role confers management rights over that vault. */
acl.put("/workspace/members", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const { email, vaultId, role } = await c.req.json<{ email?: string; vaultId?: string; role?: string }>().catch(() => ({}) as Record<string, string>);
  if (!isEmail(email) || !isRoleName(role) || typeof vaultId !== "string" || !inRegistry(vaultId)) {
    return c.json({ error: "bad_request", detail: "email, known vaultId, and role required" }, 400);
  }
  setMembership(vaultId, normEmail(email), role, config.ownerEmail);
  let inviteUrl: string | undefined;
  if (!hasAccount(normEmail(email))) inviteUrl = await createInvite(normEmail(email), null, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), vaultId, role, invited: !!inviteUrl, inviteUrl });
});

acl.delete("/workspace/members/:vaultId/:email", (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  removeMembership(c.req.param("vaultId"), normEmail(decodeURIComponent(c.req.param("email"))));
  return c.json({ ok: true });
});

// ── Workspaces: one server, many workspaces (server-owner only) ──────────────
// A workspace groups one or more VAULTS + a subdomain. The owner defines them
// here; each vault belongs to exactly one workspace (unassigned → 'default').
// Membership/access stay per-vault, so a workspace's people = the union over its
// vaults (surfaced by the existing /acl/workspace matrix, scoped as the UI lands).
const wsSlug = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";

function workspaceView(w: { id: string; name: string; hostname: string | null; created_at: number }) {
  const vaultIds = vaultsForWorkspace(w.id);
  const registry = new Map(getVaultRegistry().map((v) => [v.id, v]));
  return {
    id: w.id,
    name: w.name,
    hostname: w.hostname,
    createdAt: w.created_at,
    isDefault: w.id === DEFAULT_WORKSPACE_ID,
    vaults: vaultIds.map((id) => ({ id, label: registry.get(id)?.label ?? id, vault: registry.get(id)?.vault ?? id })),
  };
}

acl.get("/workspaces", (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  return c.json(listWorkspaces().map(workspaceView));
});

acl.post("/workspaces", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const { name, hostname } = await c.req.json<{ name?: string; hostname?: string }>().catch(() => ({}) as { name?: string; hostname?: string });
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "bad_request", detail: "name required" }, 400);
  if (hostname !== undefined && hostname !== "" && !/^[a-z0-9.-]+$/i.test(hostname)) {
    return c.json({ error: "bad_request", detail: "hostname must be a bare host (no scheme/path)" }, 400);
  }
  let id = wsSlug(name);
  const taken = new Set(listWorkspaces().map((w) => w.id));
  while (taken.has(id)) id = `${wsSlug(name)}-${Math.floor(Math.random() * 10000)}`;
  return c.json(workspaceView(createWorkspace({ id, name: name.trim(), hostname: hostname?.trim() || null })));
});

acl.put("/workspaces/:id", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  if (!getWorkspace(id)) return c.json({ error: "not_found" }, 404);
  const { name, hostname } = await c.req.json<{ name?: string; hostname?: string | null }>().catch(() => ({}) as { name?: string; hostname?: string | null });
  if (hostname !== undefined && hostname !== null && hostname !== "" && !/^[a-z0-9.-]+$/i.test(hostname)) {
    return c.json({ error: "bad_request", detail: "hostname must be a bare host" }, 400);
  }
  updateWorkspace(id, {
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    ...(hostname !== undefined ? { hostname: hostname ? hostname.trim() : null } : {}),
  });
  return c.json(workspaceView(getWorkspace(id)!));
});

acl.delete("/workspaces/:id", (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  if (id === DEFAULT_WORKSPACE_ID) return c.json({ error: "forbidden", detail: "the default workspace is permanent" }, 400);
  deleteWorkspace(id);
  return c.json({ ok: true });
});

/** Assign a vault to a workspace (each vault belongs to exactly one). */
acl.put("/workspaces/:id/vaults", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  if (!getWorkspace(id)) return c.json({ error: "not_found" }, 404);
  const { vaultId } = await c.req.json<{ vaultId?: string }>().catch(() => ({}) as { vaultId?: string });
  if (typeof vaultId !== "string" || !getVaultRegistry().some((v) => v.id === vaultId)) {
    return c.json({ error: "bad_request", detail: "known vaultId required" }, 400);
  }
  const previous = workspaceForVault(vaultId);
  assignVaultToWorkspace(vaultId, id);
  return c.json({ ok: true, vaultId, workspaceId: id, previous });
});

// ── Server settings + Cloudflare tunnel management (server-owner only) ────────
// The workspace's operator surface: a config snapshot (secret VALUES are never
// returned — only booleans), Cloudflare tunnel status + controls (the tunnel is a
// pm2 process, `prism-tunnel`), and a CURATED editable-.env allowlist. Infra-
// sensitive → server-owner-gated and narrowly scoped: no token/secret is editable
// here, and .env writes are backed up first + flagged restart-required.

/** Cloudflare tunnel status: the pm2 process state + the public hostname it
 *  fronts (read from the cloudflared config). Best-effort — never throws. */
async function tunnelStatus(): Promise<Record<string, unknown>> {
  let hostname: string | null = null;
  try {
    const cfg = await readFile(`${process.env.HOME}/.cloudflared/prism-config.yml`, "utf8");
    hostname = cfg.match(/hostname:\s*(\S+)/)?.[1] ?? null;
  } catch { /* config absent */ }
  try {
    const { stdout } = await pexec("pm2", ["jlist"]);
    const list = JSON.parse(stdout) as Array<{ name: string; pm2_env: { status: string; restart_time: number; pm_uptime: number } }>;
    const proc = list.find((p) => p.name === "prism-tunnel");
    if (proc) {
      return { managed: true, name: "prism-tunnel", status: proc.pm2_env.status, restarts: proc.pm2_env.restart_time, uptime: proc.pm2_env.pm_uptime, hostname };
    }
    return { managed: false, hostname, detail: "no pm2 process named 'prism-tunnel'" };
  } catch {
    return { managed: false, hostname, detail: "pm2 not available on this host" };
  }
}

/** Server config + status snapshot. NEVER returns a secret/token value — only
 *  whether each is configured. */
acl.get("/server", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const integrations: Record<string, boolean> = {};
  for (const k of ["matrix", "fathom", "fireflies", "github", "google", "notion"]) {
    integrations[k] = secretsConfigured() && !!getSecret("primary", config.ownerEmail, k);
  }
  return c.json({
    appOrigin: config.appOrigin,
    port: config.port,
    ownerEmail: config.ownerEmail,
    parachuteUrl: config.parachuteUrl,
    parachuteVault: config.parachuteVault,
    vaultCount: getVaultRegistry().length,
    federationEnabled: getFederationEnabled(),
    trustLocal: config.trustLocal,
    secretsAvailable: secretsConfigured(),
    emailConfigured: !!config.resendApiKey,
    magicFrom: config.magicFrom,
    integrations,
    tunnel: await tunnelStatus(),
  });
});

acl.get("/server/tunnel", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  return c.json(await tunnelStatus());
});

/** Start / stop / restart the Cloudflare tunnel (the pm2 `prism-tunnel` process).
 *  NOTE: `stop` takes the PUBLIC site offline — the UI warns, and if the caller is
 *  reaching this over the tunnel they'd cut their own connection. Owner's choice. */
acl.post("/server/tunnel", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const { action } = await c.req.json<{ action?: string }>().catch(() => ({}) as { action?: string });
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return c.json({ error: "bad_request", detail: "action must be start|stop|restart" }, 400);
  }
  try {
    await pexec("pm2", [action, "prism-tunnel"]);
    return c.json({ ok: true, action, tunnel: await tunnelStatus() });
  } catch (e) {
    return c.json({ error: "tunnel_control_failed", detail: (e as Error).message }, 500);
  }
});

// ── Tunnel ingress: wire each workspace subdomain to this server ─────────────
// A workspace serves on its own subdomain; that needs (1) a Cloudflare DNS route
// and (2) an ingress rule in the cloudflared config. This surfaces both: the
// current config, which workspace hostnames are missing an ingress rule, the
// exact `cloudflared tunnel route dns` command per hostname (DNS is created by
// the operator — it mutates their Cloudflare account), and a GUARDED apply that
// only ADDS missing rules (never rewrites/drops existing ones), backs up first,
// restarts the tunnel, and ROLLS BACK if it doesn't come back online.
const CF_CONFIG = `${process.env.HOME}/.cloudflared/prism-config.yml`;

async function readTunnelConfig(): Promise<{ text: string; tunnelId: string | null }> {
  const text = await readFile(CF_CONFIG, "utf8");
  const tunnelId = text.match(/^tunnel:\s*(\S+)/m)?.[1] ?? null;
  return { text, tunnelId };
}

/** Workspace hostnames that aren't yet present as an ingress `hostname:` line. */
function missingIngress(configText: string): string[] {
  const present = new Set([...configText.matchAll(/hostname:\s*(\S+)/g)].map((m) => m[1]!.toLowerCase()));
  return listWorkspaces()
    .map((w) => w.hostname)
    .filter((h): h is string => !!h)
    .filter((h) => !present.has(h.toLowerCase()));
}

acl.get("/server/tunnel/ingress", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  try {
    const { text, tunnelId } = await readTunnelConfig();
    const missing = missingIngress(text);
    return c.json({
      configPath: CF_CONFIG,
      config: text,
      tunnelId,
      missing,
      // DNS is created out-of-band (it mutates the operator's Cloudflare account),
      // so we surface the exact commands rather than run them.
      routeDnsCommands: missing.map((h) => `cloudflared tunnel route dns ${tunnelId ?? "<tunnel>"} ${h}`),
    });
  } catch (e) {
    return c.json({ error: "config_unreadable", detail: (e as Error).message }, 500);
  }
});

acl.post("/server/tunnel/ingress", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  let text: string;
  try {
    ({ text } = await readTunnelConfig());
  } catch (e) {
    return c.json({ error: "config_unreadable", detail: (e as Error).message }, 500);
  }
  const missing = missingIngress(text);
  if (missing.length === 0) return c.json({ ok: true, added: [], detail: "all workspace hostnames already routed" });

  // Insert each missing rule immediately BEFORE the catch-all (`- service:
  // http_status:404`), preserving every existing rule. If there's no catch-all,
  // append to the end of the ingress list.
  const rules = missing.map((h) => `  - hostname: ${h}\n    service: http://localhost:${config.port}\n`).join("");
  const catchAll = text.match(/^\s*-\s*service:\s*http_status:404\s*$/m);
  const next = catchAll
    ? text.replace(catchAll[0], `${rules}${catchAll[0]}`)
    : `${text.replace(/\n?$/, "\n")}${rules}`;

  try {
    await copyFile(CF_CONFIG, `${CF_CONFIG}.bak-${Date.now()}`);
    await writeFile(CF_CONFIG, next);
    await pexec("pm2", ["restart", "prism-tunnel"]);
  } catch (e) {
    return c.json({ error: "apply_failed", detail: (e as Error).message }, 500);
  }
  // Verify the tunnel came back; roll back the config if not.
  const status = await tunnelStatus();
  if ((status as { status?: string }).status !== "online") {
    try {
      await writeFile(CF_CONFIG, text); // restore
      await pexec("pm2", ["restart", "prism-tunnel"]);
    } catch { /* best-effort rollback */ }
    return c.json({ error: "tunnel_unhealthy_rolled_back", detail: "tunnel did not come back online; config restored" }, 500);
  }
  return c.json({ ok: true, added: missing, tunnel: status });
});

// Curated editable .env keys — deliberately NARROW. No token/secret/OWNER_EMAIL
// (editing those from the web could lock the owner out or leak). Each write backs
// up .env first and is flagged restart-required (the process reads env at boot).
const EDITABLE_ENV: Record<string, (v: string) => boolean> = {
  APP_ORIGIN: (v) => /^https?:\/\/.+/.test(v),
  MAGIC_FROM: (v) => v.length > 0 && v.length < 200,
  RESEND_API_KEY: (v) => v.length < 200,
};

acl.put("/server/config", async (c) => {
  if (!isServerOwner(c)) return c.json({ error: "forbidden" }, 403);
  const { key, value } = await c.req.json<{ key?: string; value?: string }>().catch(() => ({}) as { key?: string; value?: string });
  if (typeof key !== "string" || !(key in EDITABLE_ENV)) {
    return c.json({ error: "not_editable", detail: `only ${Object.keys(EDITABLE_ENV).join(", ")} are editable here` }, 400);
  }
  if (typeof value !== "string" || !EDITABLE_ENV[key]!(value)) {
    return c.json({ error: "bad_value", detail: `invalid value for ${key}` }, 400);
  }
  const envPath = `${process.cwd()}/.env`;
  try {
    const raw = await readFile(envPath, "utf8");
    // Back up before any write (timestamped, gitignored *.env.bak-*).
    await copyFile(envPath, `${envPath}.bak-${Date.now()}`).catch(() => {});
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    const next = re.test(raw) ? raw.replace(re, line) : `${raw.replace(/\n?$/, "\n")}${line}\n`;
    await writeFile(envPath, next, { mode: 0o600 });
    return c.json({ ok: true, key, restartRequired: true });
  } catch (e) {
    return c.json({ error: "write_failed", detail: (e as Error).message }, 500);
  }
});

// Whole-workspace access grant: broad note access (view..own) WITHOUT management
// rights. Distinct from a role (which also confers management). resource = vault_id.
acl.put("/vault/people", async (c) => {
  const actor = resolveActor(c);
  const { email, level } = await c.req.json<{ email?: string; level?: string }>();
  if (!isEmail(email) || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  ensureUser(normEmail(email));
  upsertGrant({ vault_id: actor.vaultId, subject_type: "user", subject: normEmail(email), resource_type: "vault", resource: actor.vaultId, level, created_by: config.ownerEmail });
  let inviteUrl: string | undefined;
  if (!hasAccount(normEmail(email))) inviteUrl = await createInvite(normEmail(email), null, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), level, invited: !!inviteUrl, inviteUrl });
});

acl.delete("/vault/people/:email", (c) => {
  const actor = resolveActor(c);
  removeGrantBySubjectResource("user", normEmail(decodeURIComponent(c.req.param("email"))), "vault", actor.vaultId, actor.vaultId);
  return c.json({ ok: true });
});

// ── Publishing (Horizon B): turn a tag into a public, read-only site ──
// Config (the publications row) and access (an `anyone` grant) are decoupled;
// effectiveLevel in the /api/p gateway stays the only authoritative guard.
const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "site";

/** Parse a stored theme JSON blob back into an object for the settings UI.
 *  Tolerates null/malformed → null (never throws into the list response). */
function parsePublicationTheme(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Max serialized size for a per-publication theme blob (renders on a PUBLIC
 *  page, so it stays small + bounded). */
const MAX_THEME_BYTES = 4096;

/** Validate an owner-supplied theme: a plain JSON object under the size cap (or
 *  null to clear). Returns the serialized string to persist, `null` to clear, or
 *  an `{ error }` describing why it was rejected. The publinc site additionally
 *  re-validates every value at render (http(s) logo, color/url patterns) — this
 *  is the size/shape gate, not the injection gate. */
function validateTheme(value: unknown): { json: string | null } | { error: string } {
  if (value === null || value === undefined) return { json: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "theme must be a plain object or null" };
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_THEME_BYTES) {
    return { error: `theme must be under ${MAX_THEME_BYTES} bytes` };
  }
  return { json };
}

acl.get("/publications", (c) =>
  c.json(
    listPublications().map((p) => {
      const kind = p.resource_type === "path" ? "path" : "tag";
      return {
        slug: p.id,
        kind,
        // Keep `tag` populated for tag pubs (existing UI/e2e), add `pathPrefix`
        // for path pubs. Both echo `resource` for their respective kind; the
        // other is empty/null to match core's PublicationInfo contract.
        tag: kind === "tag" ? p.resource : "",
        pathPrefix: kind === "path" ? p.resource : null,
        template: p.template,
        title: p.title,
        passwordRequired: !!p.password_hash,
        theme: parsePublicationTheme(p.theme),
        homeNoteId: p.home_note_id,
        excludeNoteIds: excludedNoteIds(p),
        expiresAt: p.expires_at,
        url: `${config.appOrigin}/p/${p.id}`,
        createdAt: p.created_at,
      };
    }),
  ),
);

acl.post("/tags/:tag/publish", async (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const body = await c.req
    .json<{ template?: string; title?: string; slug?: string; homeNoteId?: string; password?: string }>()
    .catch(() => ({}) as { template?: string; title?: string; slug?: string; homeNoteId?: string; password?: string });

  // Optional password: hashed at rest (scrypt). Empty/absent → open publication.
  const passwordHash = body.password ? hashPassword(body.password) : null;

  // One publication per tag (v1) → idempotent: reuse the existing slug if present.
  const existing = getPublicationByResource("tag", tag);
  let slug = existing?.id ?? "";
  if (!existing) {
    slug = (body.slug && slugify(body.slug)) || slugify(tag);
    while (getPublicationBySlug(slug)) slug = `${slug}-${Math.floor(Math.random() * 1000)}`;
    createPublication({
      id: slug,
      resource_type: "tag",
      resource: tag,
      template: body.template || "wiki",
      title: body.title ?? null,
      home_note_id: body.homeNoteId ?? null,
      password_hash: passwordHash,
      theme: null,
      expires_at: null,
      created_by: config.ownerEmail,
    });
  } else if (body.password !== undefined) {
    // Re-publishing with a password field present updates the gate (set or clear).
    updatePublication(existing.id, { password_hash: passwordHash });
  }
  // The publication primitive: an `anyone-with-the-link` grant scoped to the tag.
  upsertGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: tag, level: "view", created_by: config.ownerEmail });

  // Live count for the UI warning ("this will publish N notes" — and is dynamic).
  let count = 0;
  try { count = (await vault.listNotes({ tags: [tag] })).length; } catch { /* best-effort */ }
  return c.json({ slug, tag, url: `${config.appOrigin}/p/${slug}`, count, passwordRequired: !!passwordHash });
});

/** Set or clear a publication's password (clear by sending an empty/omitted password). */
acl.put("/tags/:tag/publish/password", async (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const pub = getPublicationByResource("tag", tag);
  if (!pub) return c.json({ error: "not_found" }, 404);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  updatePublication(pub.id, { password_hash: password ? hashPassword(password) : null });
  return c.json({ ok: true, passwordRequired: !!password });
});

acl.delete("/tags/:tag/publish", (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const pub = getPublicationByResource("tag", tag);
  if (pub) deletePublication(pub.id);
  removeGrantBySubjectResource("anyone", "*", "tag", tag);
  return c.json({ ok: true });
});

// ── Publish-by-path-prefix: a public, read-only site rooted at a directory ──
// Unlike tag pubs, a path publication uses NO `anyone` grant — the public read
// path (routes/publish.ts) guards it purely by the path-membership predicate on
// the vault's own `path` field. So this only writes the `publications` row.
acl.post("/publish/path", async (c) => {
  const body = await c.req
    .json<{ pathPrefix?: string; title?: string; slug?: string; password?: string }>()
    .catch(() => ({}) as { pathPrefix?: string; title?: string; slug?: string; password?: string });

  const prefix = typeof body.pathPrefix === "string" ? normalizePathPrefix(body.pathPrefix) : null;
  if (!prefix) return c.json({ error: "bad_request", message: "invalid path prefix" }, 400);

  // Optional password: hashed at rest (scrypt). Empty/absent → open publication.
  const passwordHash = body.password ? hashPassword(body.password) : null;

  // One publication per prefix → idempotent: reuse the existing slug if present.
  const existing = getPublicationByResource("path", prefix);
  let slug = existing?.id ?? "";
  if (!existing) {
    slug = (body.slug && slugify(body.slug)) || slugify(prefix);
    while (getPublicationBySlug(slug)) slug = `${slug}-${Math.floor(Math.random() * 1000)}`;
    createPublication({
      id: slug,
      resource_type: "path",
      resource: prefix,
      template: "wiki",
      title: body.title ?? null,
      home_note_id: null,
      password_hash: passwordHash,
      theme: null,
      expires_at: null,
      created_by: config.ownerEmail,
    });
  } else if (body.password !== undefined) {
    updatePublication(existing.id, { password_hash: passwordHash });
  }

  // Live count (and dynamic): notes whose path is inside the prefix. The same
  // membership predicate the public read path uses — never trust a vault query.
  let count = 0;
  try {
    count = (await vault.listNotes({})).filter((n) => pathInPrefix(n.path, prefix)).length;
  } catch {
    /* best-effort */
  }
  return c.json({ slug, pathPrefix: prefix, url: `${config.appOrigin}/p/${slug}`, count, passwordRequired: !!passwordHash });
});

// ── Slug-based publication management (works for BOTH tag and path pubs) ──
/** Set or clear a publication's password by slug (clear by omitting/empty password). */
acl.put("/publications/:slug/password", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub) return c.json({ error: "not_found" }, 404);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  updatePublication(pub.id, { password_hash: password ? hashPassword(password) : null });
  return c.json({ ok: true, passwordRequired: !!password });
});

/** Per-publication "tending" controls (owner hand-tuning of a public wiki):
 *  - homeNoteId: which note loads first (string, or null to clear → derive at read).
 *  - excludeNoteIds: note ids to DROP from the public set even though they match
 *    the tag/path (string[]; empty clears all exclusions).
 *  - theme: a small plain object of presentation overrides (logo/colors/font),
 *    persisted as JSON (≤4KB; null clears). Re-validated at render on the public
 *    site (http(s) logo, color patterns) — never trusted as raw HTML.
 *  Only the provided fields are patched. Returns 404 for an unknown slug. */
acl.put("/publications/:slug/settings", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub) return c.json({ error: "not_found" }, 404);
  const body = await c.req
    .json<{ title?: string | null; homeNoteId?: string | null; excludeNoteIds?: unknown; theme?: unknown }>()
    .catch(() => ({}) as { title?: string | null; homeNoteId?: string | null; excludeNoteIds?: unknown; theme?: unknown });

  const patch: {
    title?: string | null;
    home_note_id?: string | null;
    excluded_note_ids?: string | null;
    theme?: string | null;
  } = {};

  if ("title" in body) {
    if (body.title !== null && typeof body.title !== "string") {
      return c.json({ error: "bad_request", detail: "title must be a string or null" }, 400);
    }
    // Empty string → clear (fall back to derived title).
    patch.title = body.title && body.title.trim() ? body.title.trim() : null;
  }

  if ("homeNoteId" in body) {
    if (body.homeNoteId !== null && typeof body.homeNoteId !== "string") {
      return c.json({ error: "bad_request", detail: "homeNoteId must be a string or null" }, 400);
    }
    patch.home_note_id = body.homeNoteId;
  }

  if ("excludeNoteIds" in body) {
    const ids = body.excludeNoteIds;
    if (!Array.isArray(ids) || !ids.every((s) => typeof s === "string")) {
      return c.json({ error: "bad_request", detail: "excludeNoteIds must be an array of strings" }, 400);
    }
    patch.excluded_note_ids = JSON.stringify(ids);
  }

  if ("theme" in body) {
    const t = validateTheme(body.theme);
    if ("error" in t) return c.json({ error: "bad_request", detail: t.error }, 400);
    patch.theme = t.json;
  }

  updatePublication(pub.id, patch);
  return c.json({ ok: true });
});

/** Unpublish by slug. Removes the row; for a tag pub it also drops the backing
 *  `anyone/tag/view` grant. (Path pubs have no grant to remove.) */
acl.delete("/publications/:slug", (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub) return c.json({ error: "not_found" }, 404);
  deletePublication(pub.id);
  if (pub.resource_type === "tag") {
    removeGrantBySubjectResource("anyone", "*", "tag", pub.resource);
  }
  return c.json({ ok: true });
});

// ── Suggestions review (Horizon C, suggest-level): durable owner inbox ──
// A suggest-level peer/collaborator's proposed change is stored (survives
// restart) for the owner to accept or reject. Accept/reject is a status
// transition; applying an accepted suggestion to the live doc is handled by the
// collab/federation layer when that note next loads (gated path).
acl.get("/suggestions", (c) => {
  const status = c.req.query("status") as "pending" | "accepted" | "rejected" | undefined;
  return c.json(
    listSuggestions(status).map((s) => ({
      id: s.id,
      noteId: s.note_id,
      spaceNoteKey: s.space_note_key,
      author: s.author,
      authorKind: s.author_kind,
      summary: s.summary,
      status: s.status,
      createdAt: s.created_at,
      resolvedAt: s.resolved_at,
    })),
  );
});

acl.post("/suggestions/:id/accept", (c) => {
  const s = getSuggestion(c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  setSuggestionStatus(s.id, "accepted");
  return c.json({ ok: true, status: "accepted" });
});

acl.post("/suggestions/:id/reject", (c) => {
  const s = getSuggestion(c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  setSuggestionStatus(s.id, "rejected");
  return c.json({ ok: true, status: "rejected" });
});

acl.delete("/suggestions/:id", (c) => {
  deleteSuggestion(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Peer federation (Horizon C): identity + one-time pairing (owner setup) ──
acl.get("/peers/identity", (c) => {
  const kp = serverKeyPair();
  return c.json({ publicKey: kp.publicKeyB64url, fingerprint: fingerprint(kp.publicKeyB64url) });
});

/** Whether the live federation transport is enabled on this node. The pairing /
 *  space / mirror endpoints work either way (they only mutate the local store),
 *  but actual sync requires the flag — the UI shows status + a toggle. Reads the
 *  runtime value (persisted; defaults to the FEDERATION_ENABLED env). */
acl.get("/federation/status", (c) => c.json({ enabled: getFederationEnabled() }));

/** Toggle the live federation transport at runtime (owner-only; persisted, no
 *  restart). Enabling starts the FederationManager and binds known spaces;
 *  disabling tears every binding down. The module is imported LAZILY so a node
 *  that never enables federation never loads @hocuspocus/provider. */
acl.post("/federation/enabled", async (c) => {
  const { enabled } = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
  if (typeof enabled !== "boolean") return c.json({ error: "bad_request" }, 400);
  setFederationEnabled(enabled); // set first — start()/syncSpaces() gate on this flag
  try {
    const { federationManager } = await import("../federation-manager");
    if (enabled) {
      federationManager.start();
      await federationManager.syncSpaces();
    } else {
      await federationManager.stop();
    }
  } catch (e) {
    console.error("[federation] toggle lifecycle failed:", e);
    // The flag is persisted regardless; a restart will reconcile the manager.
  }
  return c.json({ enabled });
});

acl.post("/peers/pair", async (c) => {
  const { label } = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  // The raw code is shown to the owner ONCE to hand to the peer out-of-band; only
  // its hash is stored (invite.ts pattern). 7-day single-use TTL.
  const code = randomBytes(18).toString("base64url");
  storePairing(createHash("sha256").update(code).digest("hex"), label ?? null, config.ownerEmail, 7 * 86_400_000);
  const kp = serverKeyPair();
  return c.json({
    code,
    expiresInDays: 7,
    serverPublicKey: kp.publicKeyB64url,
    fingerprint: fingerprint(kp.publicKeyB64url),
  });
});

acl.get("/peers", (c) =>
  c.json(
    listPeers().map((p) => ({
      pubkey: p.pubkey,
      email: p.email,
      label: p.label,
      fingerprint: fingerprint(p.pubkey),
      pairedAt: p.paired_at,
      createdAt: p.created_at,
    })),
  ),
);

acl.delete("/peers/:pubkey", (c) => {
  const pubkey = decodeURIComponent(c.req.param("pubkey"));
  for (const g of grantsForPeer(pubkey)) removeGrant(g.id);
  removePeer(pubkey);
  kickFederationSync();
  return c.json({ ok: true });
});

/** Set (or clear) a paired peer's /collab WS URL so the FederationManager can
 *  open the outbound binding without an out-of-band step (federation gap #1). */
acl.post("/peers/:pubkey/url", async (c) => {
  const pubkey = decodeURIComponent(c.req.param("pubkey"));
  if (!getPeer(pubkey)) return c.json({ error: "unknown_peer" }, 404);
  const { collabUrl } = await c.req.json<{ collabUrl?: string | null }>().catch(() => ({}) as { collabUrl?: string });
  if (collabUrl !== undefined && collabUrl !== null && !/^wss?:\/\//.test(collabUrl)) {
    return c.json({ error: "bad_url" }, 400);
  }
  setPeerCollabUrl(pubkey, collabUrl ?? null);
  kickFederationSync();
  return c.json({ ok: true });
});

// ── Shared spaces (Horizon C): owner-managed federation collections ──
// A space groups notes (each assigned a content-independent space_note_key) and
// is shared with peers via grants (subject_type='peer', resource_type='space').
// The live bridge (federation-manager.ts) is GATED behind config.federationEnabled;
// these management endpoints only mutate the local ACL/identity store.
const asStringArray = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

/** Serialize a Space row for the API (parse the JSON tag scopes). Includes the
 *  granted peers (so the UI reflects real grants, not optimistic state) and a
 *  sync summary derived from the space's federated-note mappings. */
function spaceView(s: Space) {
  const peers = grantsForResource("space", s.id)
    .filter((g) => g.subject_type === "peer")
    .map((g) => {
      const peer = getPeer(g.subject);
      return {
        pubkey: g.subject,
        fingerprint: fingerprint(g.subject),
        label: peer?.label ?? null,
        level: g.level,
      };
    });
  const fed = federatedNotesForSpace(s.id);
  const syncedAts = fed.map((f) => f.peer_synced_at).filter((t): t is number => t != null);
  return {
    id: s.id,
    title: s.title,
    includeTags: s.scope_include_tags ? (JSON.parse(s.scope_include_tags) as string[]) : [],
    excludeTags: s.scope_exclude_tags ? (JSON.parse(s.scope_exclude_tags) as string[]) : [],
    pathPrefix: s.path_prefix,
    createdAt: s.created_at,
    peers,
    noteCount: fed.length,
    lastSyncedAt: syncedAts.length ? Math.max(...syncedAts) : null,
  };
}

acl.get("/spaces", (c) => c.json(listSpaces().map(spaceView)));

acl.post("/spaces", async (c) => {
  const body = await c.req
    .json<{ title?: string; includeTags?: string[]; excludeTags?: string[]; pathPrefix?: string }>()
    .catch(() => ({}) as Record<string, never>);
  const space = createSpace({
    id: randomUUID(),
    title: typeof body.title === "string" ? body.title : null,
    scope_include_tags: JSON.stringify(asStringArray(body.includeTags)),
    scope_exclude_tags: JSON.stringify(asStringArray(body.excludeTags)),
    path_prefix: typeof body.pathPrefix === "string" ? body.pathPrefix : null,
    created_by: config.ownerEmail,
  });
  return c.json(spaceView(space));
});

acl.delete("/spaces/:id", (c) => {
  const id = c.req.param("id");
  // Drop the space's federated-note identities and any peer grants on it.
  for (const fed of federatedNotesForSpace(id)) deleteFederatedNote(fed.space_note_key);
  for (const g of grantsForResource("space", id)) removeGrant(g.id);
  deleteSpace(id);
  kickFederationSync();
  return c.json({ ok: true });
});

// Add a note to a space: mint its content-independent space_note_key and PIN the
// collab kind (so an inbound peer update can never reseed it as the wrong shape).
acl.post("/spaces/:id/notes", async (c) => {
  const id = c.req.param("id");
  if (!getSpace(id)) return c.json({ error: "not_found" }, 404);
  const { noteId } = await c.req.json<{ noteId?: string }>().catch(() => ({}) as { noteId?: string });
  if (typeof noteId !== "string" || !noteId) return c.json({ error: "bad_request" }, 400);
  let kind: string;
  try {
    const note = await vault.getNote(noteId);
    kind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "note_not_found" }, 404);
    return c.json({ error: "vault_error" }, 502);
  }
  const row = upsertFederatedNote({
    space_note_key: randomUUID(),
    space_id: id,
    local_id: noteId,
    kind,
    peer_synced_at: null,
    source_updated_at: null,
  });
  kickFederationSync();
  return c.json(row);
});

// Grant / revoke a paired peer's access to a space.
acl.post("/spaces/:id/peers", async (c) => {
  const id = c.req.param("id");
  if (!getSpace(id)) return c.json({ error: "not_found" }, 404);
  const { pubkey, level, expiresInDays } = await c.req.json<{ pubkey?: string; level?: string; expiresInDays?: number }>().catch(() => ({}) as { pubkey?: string; level?: string; expiresInDays?: number });
  if (typeof pubkey !== "string" || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  if (!getPeer(pubkey)) return c.json({ error: "unknown_peer" }, 404);
  const grant = upsertGrant({
    subject_type: "peer",
    subject: pubkey,
    resource_type: "space",
    resource: id,
    level,
    created_by: config.ownerEmail,
    expires_at: typeof expiresInDays === "number" && expiresInDays > 0 ? Date.now() + expiresInDays * 86_400_000 : null,
  });
  kickFederationSync();
  return c.json({ ok: true, grant });
});

acl.delete("/spaces/:id/peers/:pubkey", (c) => {
  removeGrantBySubjectResource("peer", decodeURIComponent(c.req.param("pubkey")), "space", c.req.param("id"));
  kickFederationSync();
  return c.json({ ok: true });
});

// Per-note level override (4.3): raise a peer's access on ONE shared note above
// the space default (a note-level peer grant is maxed in by effectiveLevel /
// resolveLevel). Additive (raises only — the project avoids deny grants); with an
// optional TTL. resource = this hub's local note id.
acl.put("/federation/note-level", async (c) => {
  const { noteId, pubkey, level, expiresInDays } = await c.req
    .json<{ noteId?: string; pubkey?: string; level?: string; expiresInDays?: number }>()
    .catch(() => ({}) as { noteId?: string; pubkey?: string; level?: string; expiresInDays?: number });
  if (typeof noteId !== "string" || !noteId || typeof pubkey !== "string" || !isLevel(level)) {
    return c.json({ error: "bad_request", detail: "noteId + pubkey + level required" }, 400);
  }
  if (!getPeer(pubkey)) return c.json({ error: "unknown_peer" }, 404);
  const grant = upsertGrant({
    subject_type: "peer",
    subject: pubkey,
    resource_type: "note",
    resource: noteId,
    level,
    created_by: config.ownerEmail,
    expires_at: typeof expiresInDays === "number" && expiresInDays > 0 ? Date.now() + expiresInDays * 86_400_000 : null,
  });
  kickFederationSync();
  return c.json({ ok: true, noteId, pubkey, level, grant });
});

acl.delete("/federation/note-level/:noteId/:pubkey", (c) => {
  removeGrantBySubjectResource("peer", decodeURIComponent(c.req.param("pubkey")), "note", decodeURIComponent(c.req.param("noteId")));
  kickFederationSync();
  return c.json({ ok: true });
});

// Peer-edit audit (4.3): who among our federated peers edited which shared note,
// and when — owner review of inbound federated changes.
acl.get("/federation/peer-edits", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  return c.json(
    listPeerEdits(limit).map((e) => ({
      spaceNoteKey: e.space_note_key,
      localId: e.local_id,
      peer: e.peer_pubkey,
      peerFingerprint: fingerprint(e.peer_pubkey),
      editedAt: e.edited_at,
    })),
  );
});

// ── "Parachute Sync": mirror ONE note to a paired peer in a single action (4.2) ──
// Collapses the 4-step flow (create space → add note → grant peer → sync) behind
// one call, reusing a singleton "Parachute Sync" space so every one-click mirror
// shares it. Idempotent per note: re-mirroring refreshes the peer grant/level.
const SYNC_SPACE_TITLE = "Parachute Sync";
acl.post("/notes/:id/mirror", async (c) => {
  const noteId = c.req.param("id");
  const { pubkey, level, expiresInDays } = await c.req
    .json<{ pubkey?: string; level?: string; expiresInDays?: number }>()
    .catch(() => ({}) as { pubkey?: string; level?: string; expiresInDays?: number });
  if (typeof pubkey !== "string" || !isLevel(level)) return c.json({ error: "bad_request", detail: "pubkey + level required" }, 400);
  if (!getPeer(pubkey)) return c.json({ error: "unknown_peer" }, 404);
  const expires_at = typeof expiresInDays === "number" && expiresInDays > 0 ? Date.now() + expiresInDays * 86_400_000 : null;

  let kind: string;
  try {
    const note = await vault.getNote(noteId);
    kind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "note_not_found" }, 404);
    return c.json({ error: "vault_error" }, 502);
  }

  // 1. find-or-create the singleton sync space.
  let space = listSpaces().find((s) => s.title === SYNC_SPACE_TITLE);
  if (!space) {
    space = createSpace({
      id: randomUUID(),
      title: SYNC_SPACE_TITLE,
      scope_include_tags: "[]",
      scope_exclude_tags: "[]",
      path_prefix: null,
      created_by: config.ownerEmail,
    });
  }
  // 2. add the note (reuse its federated identity if already mirrored).
  const existing = federatedNotesForSpace(space.id).find((f) => f.local_id === noteId);
  const fed =
    existing ??
    upsertFederatedNote({ space_note_key: randomUUID(), space_id: space.id, local_id: noteId, kind, peer_synced_at: null, source_updated_at: null });
  // 3. grant the peer access to the space at the requested level (with optional TTL).
  upsertGrant({ subject_type: "peer", subject: pubkey, resource_type: "space", resource: space.id, level, created_by: config.ownerEmail, expires_at });
  // 4. kick the bridge so the doc starts mirroring to the peer.
  kickFederationSync();
  return c.json({ ok: true, spaceId: space.id, spaceNoteKey: fed.space_note_key, pubkey, level, expiresAt: expires_at });
});

// ── Inbound federation mirror requests (owner-reviewed) ──────────────────────
// A paired peer's POST /api/federation/mirror lands here as 'pending'. Accepting
// creates the local shared space (same id) + a peer grant + a placeholder note
// per shared space_note_key + the federated_notes mapping — productionizing what
// the two-hub harness used to insert into SQLite by hand.
acl.get("/federation/mirrors", (c) => {
  const status = c.req.query("status") as "pending" | "accepted" | "rejected" | undefined;
  return c.json(
    listMirrorRequests(status).map((r) => ({
      id: r.id,
      peer: r.peer_pubkey,
      fingerprint: fingerprint(r.peer_pubkey),
      spaceId: r.space_id,
      spaceTitle: r.space_title,
      notes: JSON.parse(r.payload) as Array<{ spaceNoteKey: string; kind: string; title?: string }>,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    })),
  );
});

// UUID-shaped ids only — defense-in-depth so a stored mirror payload can never
// escape the `shared/<space>/<key>.md` note path (the /mirror route validates
// too, but accept must not trust the row blindly).
const FED_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

acl.post("/federation/mirrors/:id/accept", async (c) => {
  const req = getMirrorRequest(c.req.param("id"));
  if (!req || req.status !== "pending") return c.json({ error: "not_found" }, 404);
  if (!getPeer(req.peer_pubkey)?.paired_at) return c.json({ error: "unknown_peer" }, 400);
  if (!FED_ID_RE.test(req.space_id)) return c.json({ error: "bad_space_id" }, 400);
  const { level } = await c.req.json<{ level?: string }>().catch(() => ({}) as { level?: string });
  const lvl: Level = isLevel(level) ? level : "edit";

  // Local shared space (same id as the peer's) + the peer's grant on it.
  if (!getSpace(req.space_id)) {
    createSpace({
      id: req.space_id,
      title: req.space_title,
      scope_include_tags: null,
      scope_exclude_tags: null,
      path_prefix: `shared/${req.space_id}`,
      created_by: config.ownerEmail,
    });
  }
  upsertGrant({ subject_type: "peer", subject: req.peer_pubkey, resource_type: "space", resource: req.space_id, level: lvl, created_by: config.ownerEmail });

  // One placeholder note per shared key (empty so the first peer sync is the
  // unambiguous seed; kind PINNED via metadata.prism_type so noteKind matches the
  // federated row and the bridge won't skip on a kind mismatch). Idempotent.
  const notes = JSON.parse(req.payload) as Array<{ spaceNoteKey: string; kind: string; title?: string }>;
  const mapped: Array<{ spaceNoteKey: string; localId: string; kind: string }> = [];
  const skipped: string[] = [];
  for (const n of notes) {
    if (!FED_ID_RE.test(n.spaceNoteKey)) { skipped.push(n.spaceNoteKey); continue; } // anti-traversal
    const existing = getFederatedByKey(n.spaceNoteKey);
    if (existing) {
      mapped.push({ spaceNoteKey: n.spaceNoteKey, localId: existing.local_id, kind: existing.kind });
      continue;
    }
    let localId: string;
    try {
      const note = await vault.createNote({
        content: "",
        path: `shared/${req.space_id}/${n.spaceNoteKey}.md`,
        metadata: { prism_type: n.kind, ...(n.title ? { title: n.title } : {}) },
      });
      localId = note.id;
    } catch {
      return c.json({ error: "vault_error" }, 502);
    }
    upsertFederatedNote({ space_note_key: n.spaceNoteKey, space_id: req.space_id, local_id: localId, kind: n.kind, peer_synced_at: null, source_updated_at: null });
    mapped.push({ spaceNoteKey: n.spaceNoteKey, localId, kind: n.kind });
  }
  setMirrorRequestStatus(req.id, "accepted");
  kickFederationSync();
  return c.json({ ok: true, spaceId: req.space_id, level: lvl, mapped, skipped });
});

acl.post("/federation/mirrors/:id/reject", (c) => {
  const req = getMirrorRequest(c.req.param("id"));
  if (!req) return c.json({ error: "not_found" }, 404);
  setMirrorRequestStatus(req.id, "rejected");
  return c.json({ ok: true, status: "rejected" });
});

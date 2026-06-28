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
import { vault, VaultError } from "../parachute";
import { resolveActor } from "../auth/actor";
import { signCapability } from "../auth/capability";
import { serverKeyPair, fingerprint } from "../auth/peer";
import { LEVELS, type Level } from "../permissions";
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
  type Space,
} from "../db";
import { noteKind } from "../collab";
import { hashPassword } from "../auth/password";
import { createInvite } from "../auth/invite";

/** Grant a person access to a resource, inviting them if they have no account
 *  yet so the access binds to a real, authenticated identity. */
async function grantAndInvite(
  email: string,
  level: Level,
  resourceType: "note" | "tag",
  resource: string,
  owner: string,
): Promise<{ invited: boolean; inviteUrl?: string }> {
  ensureUser(email);
  upsertGrant({ subject_type: "user", subject: email, resource_type: resourceType, resource, level, created_by: owner });
  if (!hasAccount(email)) {
    // Return the accept URL so the owner can hand it over directly — email may
    // not be configured/paid, and even when it is, "copy invite link" is useful.
    const inviteUrl = await createInvite(email, null, owner);
    return { invited: true, inviteUrl };
  }
  return { invited: false };
}

export const acl = new Hono();

// Everything here is owner-only.
acl.use("*", async (c, next) => {
  if (!resolveActor(c).isOwner) return c.json({ error: "forbidden" }, 403);
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
  if (!config.federationEnabled) return;
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
      for (const g of grantsForResource("tag", tag)) {
        tagAccess.push({
          tag,
          email: g.subject_type === "user" ? g.subject : undefined,
          subjectType: g.subject_type,
          level: g.level,
        });
      }
    }
    return c.json({ note: { id, tags, title: deriveTitle(note.content) }, people, links, tagAccess });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "vault_error" }, 502);
  }
});

acl.put("/notes/:id/people", async (c) => {
  const { email, level } = await c.req.json<{ email?: string; level?: string }>();
  if (!isEmail(email) || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  const { invited, inviteUrl } = await grantAndInvite(normEmail(email), level, "note", c.req.param("id"), config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), level, invited, inviteUrl });
});

acl.delete("/notes/:id/people/:email", (c) => {
  removeGrantBySubjectResource(
    "user",
    normEmail(decodeURIComponent(c.req.param("email"))),
    "note",
    c.req.param("id"),
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
  removeGrantBySubjectResource("link", capId, "note", c.req.param("id"));
  return c.json({ ok: true });
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

// Tag-grants: a person can access everything carrying a tag.
acl.put("/tags/:tag/people", async (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const { email, level } = await c.req.json<{ email?: string; level?: string }>();
  if (!isEmail(email) || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  const { invited, inviteUrl } = await grantAndInvite(normEmail(email), level, "tag", tag, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), level, invited, inviteUrl });
});

acl.delete("/tags/:tag/people/:email", (c) => {
  removeGrantBySubjectResource(
    "user",
    normEmail(decodeURIComponent(c.req.param("email"))),
    "tag",
    decodeURIComponent(c.req.param("tag")),
  );
  return c.json({ ok: true });
});

// ── Publishing (Horizon B): turn a tag into a public, read-only site ──
// Config (the publications row) and access (an `anyone` grant) are decoupled;
// effectiveLevel in the /api/p gateway stays the only authoritative guard.
const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "site";

acl.get("/publications", (c) =>
  c.json(
    listPublications().map((p) => ({
      slug: p.id,
      tag: p.resource,
      template: p.template,
      title: p.title,
      passwordRequired: !!p.password_hash,
      expiresAt: p.expires_at,
      url: `${config.appOrigin}/p/${p.id}`,
      createdAt: p.created_at,
    })),
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

/** Serialize a Space row for the API (parse the JSON tag scopes). */
function spaceView(s: Space) {
  return {
    id: s.id,
    title: s.title,
    includeTags: s.scope_include_tags ? (JSON.parse(s.scope_include_tags) as string[]) : [],
    excludeTags: s.scope_exclude_tags ? (JSON.parse(s.scope_exclude_tags) as string[]) : [],
    pathPrefix: s.path_prefix,
    createdAt: s.created_at,
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
  const { pubkey, level } = await c.req.json<{ pubkey?: string; level?: string }>().catch(() => ({}) as { pubkey?: string; level?: string });
  if (typeof pubkey !== "string" || !isLevel(level)) return c.json({ error: "bad_request" }, 400);
  if (!getPeer(pubkey)) return c.json({ error: "unknown_peer" }, 404);
  const grant = upsertGrant({
    subject_type: "peer",
    subject: pubkey,
    resource_type: "space",
    resource: id,
    level,
    created_by: config.ownerEmail,
  });
  kickFederationSync();
  return c.json({ ok: true, grant });
});

acl.delete("/spaces/:id/peers/:pubkey", (c) => {
  removeGrantBySubjectResource("peer", decodeURIComponent(c.req.param("pubkey")), "space", c.req.param("id"));
  kickFederationSync();
  return c.json({ ok: true });
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

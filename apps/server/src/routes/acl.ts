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
  getPeer,
  createSpace,
  getSpace,
  listSpaces,
  deleteSpace,
  upsertFederatedNote,
  federatedNotesForSpace,
  deleteFederatedNote,
  type Space,
} from "../db";
import { noteKind } from "../collab";
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
    .json<{ template?: string; title?: string; slug?: string; homeNoteId?: string }>()
    .catch(() => ({}) as { template?: string; title?: string; slug?: string; homeNoteId?: string });

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
      password_hash: null,
      theme: null,
      expires_at: null,
      created_by: config.ownerEmail,
    });
  }
  // The publication primitive: an `anyone-with-the-link` grant scoped to the tag.
  upsertGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: tag, level: "view", created_by: config.ownerEmail });

  // Live count for the UI warning ("this will publish N notes" — and is dynamic).
  let count = 0;
  try { count = (await vault.listNotes({ tags: [tag] })).length; } catch { /* best-effort */ }
  return c.json({ slug, tag, url: `${config.appOrigin}/p/${slug}`, count });
});

acl.delete("/tags/:tag/publish", (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const pub = getPublicationByResource("tag", tag);
  if (pub) deletePublication(pub.id);
  removeGrantBySubjectResource("anyone", "*", "tag", tag);
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
  return c.json({ ok: true, grant });
});

acl.delete("/spaces/:id/peers/:pubkey", (c) => {
  removeGrantBySubjectResource("peer", decodeURIComponent(c.req.param("pubkey")), "space", c.req.param("id"));
  return c.json({ ok: true });
});

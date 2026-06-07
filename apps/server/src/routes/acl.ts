/**
 * Access-control management — owner-only. Lives at /acl/* (NOT /api, whose
 * owner-passthrough would proxy to the vault; NOT /share, which is the public
 * read view). Backs the share dialog: per-note people grants, capability links
 * (Google-Docs "anyone with the link"), note↔tag membership, and tag-grants
 * ("share everything tagged X with this person"). Authorization for the shared
 * content itself is still enforced by the /api gateway via these grants.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { vault, VaultError } from "../parachute";
import { resolveActor } from "../auth/actor";
import { signCapability } from "../auth/capability";
import { LEVELS, type Level } from "../permissions";
import {
  ensureUser,
  hasAccount,
  listUsers,
  upsertGrant,
  removeGrantBySubjectResource,
  grantsForResource,
  createCapability,
  capabilitiesForResource,
  deleteCapability,
} from "../db";
import { createInvite } from "../auth/invite";

/** Grant a person access to a resource, inviting them if they have no account
 *  yet so the access binds to a real, authenticated identity. */
async function grantAndInvite(
  email: string,
  level: Level,
  resourceType: "note" | "tag",
  resource: string,
  owner: string,
): Promise<{ invited: boolean }> {
  ensureUser(email);
  upsertGrant({ subject_type: "user", subject: email, resource_type: resourceType, resource, level, created_by: owner });
  if (!hasAccount(email)) {
    await createInvite(email, null, owner);
    return { invited: true };
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
  const line = (content ?? "").split("\n").find((l) => l.trim().length > 0) ?? "Untitled";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || "Untitled";
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
  const { invited } = await grantAndInvite(normEmail(email), level, "note", c.req.param("id"), config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), level, invited });
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
  const { invited } = await grantAndInvite(normEmail(email), level, "tag", tag, config.ownerEmail);
  return c.json({ ok: true, email: normEmail(email), level, invited });
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

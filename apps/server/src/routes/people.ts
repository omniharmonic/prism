import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { resolveActor, type Actor } from "../auth/actor";
import { resolveVaultEntry } from "../db";
import { effectiveCaps, type NoteRef } from "../permissions";
import { roleFloor } from "../roles";
import {
  vaultClient,
  VaultError,
  VaultConflictError,
  type Note,
} from "../parachute";
import { treeUpsertNote } from "../tree";
import { PeopleIndex } from "../worker/people";
import { IdentityIndex, isNonHumanPerson, isTombstone } from "../identity";
import {
  isPerson,
  personCategory,
  personSummary,
  normalizeIdentity,
  identityPatch,
  withIdentityLock,
} from "../people-directory";

export const peopleApi = new Hono();
const ref = (note: Note): NoteRef => ({
  id: note.id,
  tags: note.tags ?? [],
  creator:
    typeof note.metadata?.prism_creator === "string"
      ? note.metadata.prism_creator
      : null,
  visibility:
    note.metadata?.prism_visibility === "private" ? "private" : "workspace",
  path: note.path ?? null,
});
const capsFor = (actor: Actor, note: NoteRef) =>
  effectiveCaps(
    actor.grants,
    note,
    roleFloor(actor.role),
    actor.kind === "user"
      ? actor.email
      : actor.kind === "link"
        ? actor.capabilityId
        : null,
  );

peopleApi.get("/", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  if (
    c.req.header("x-prism-vault") &&
    c.req.header("x-prism-vault") !== actor.vaultId
  )
    return c.json({ error: "vault_unavailable" }, 409);
  const query = (c.req.query("q") ?? "").trim().toLowerCase();
  const after = c.req.query("after") ?? "";
  if (query.length > 200 || after.length > 2048)
    return c.json({ error: "bad_request" }, 400);
  try {
    const inventory = await vaultClient(actor.vaultId).listNotes({
      tags: ["person"],
      limit: 10_000,
      includeMetadata: [
        "name",
        "title",
        "role",
        "email",
        "emails",
        "contact",
        "channels",
        "matrix",
        "matrixId",
        "telegram",
        "signal",
        "whatsapp",
        "phone",
        "type",
        "prism_creator",
        "prism_visibility",
        // merged people are hidden from the directory (identity layer)
        "status",
        "merged_into",
        "mergedInto",
        "superseded_by",
      ],
    });
    if (inventory.length >= 10_000)
      return c.json({ error: "people_inventory_limit" }, 503);
    const matches = inventory
      // A merged stub or a non-human note tagged `person` is not somebody to list.
      .filter((n) => isPerson(n) && !isTombstone(n) && !isNonHumanPerson(n) && capsFor(actor, ref(n)).has("view"))
      .map(personSummary)
      .filter(
        (p) =>
          !query ||
          [p.name, p.role ?? "", ...p.identities.map((i) => i.value)].some(
            (v) => v.toLowerCase().includes(query),
          ),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((p) => !after || p.id.localeCompare(after) > 0);
    const people = matches.slice(0, 50);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      people,
      next: matches.length > 50 ? people.at(-1)!.id : null,
    });
  } catch {
    return c.json({ error: "people_unavailable" }, 503);
  }
});

peopleApi.post("/:id/identities", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "forbidden" }, 403);
  if (
    c.req.header("x-prism-vault") &&
    c.req.header("x-prism-vault") !== actor.vaultId
  )
    return c.json({ error: "vault_unavailable" }, 409);
  const body = await c.req
    .json<{
      kind?: unknown;
      value?: unknown;
      action?: unknown;
      ifUpdatedAt?: unknown;
    }>()
    .catch(() => null);
  if (
    !body ||
    (body.kind !== "email" && body.kind !== "matrix") ||
    typeof body.value !== "string" ||
    (body.action !== "add" && body.action !== "remove") ||
    typeof body.ifUpdatedAt !== "string"
  )
    return c.json({ error: "bad_request" }, 400);
  const kind = body.kind as "email" | "matrix",
    action = body.action as "add" | "remove";
  const value =
    action === "remove" && body.value.trim().length <= 320
      ? body.value.trim().toLowerCase()
      : normalizeIdentity(kind, body.value);
  if (!value) return c.json({ error: "invalid_identity" }, 400);
  return withIdentityLock(
    JSON.stringify([actor.vaultId, kind, value]),
    async () => {
      try {
        const vc = vaultClient(actor.vaultId);
        const note = await vc.getNote(c.req.param("id"));
        if (!isPerson(note) || !capsFor(actor, ref(note)).has("edit"))
          return c.json({ error: "forbidden" }, 403);
        if (!note.updatedAt || note.updatedAt !== body.ifUpdatedAt)
          return c.json(
            {
              error: "conflict",
              detail:
                "This person changed. Reload before reviewing their accounts.",
            },
            409,
          );
        if (action === "add") {
          const people = await vc.listNotes({
            tags: ["person"],
            limit: 10_000,
          });
          if (people.length >= 10_000)
            return c.json({ error: "people_inventory_limit" }, 503);
          const resolution = new PeopleIndex(people).resolve(
            kind === "email" ? { email: value } : { matrixId: value },
          );
          if (
            resolution.status === "ambiguous" ||
            (resolution.status === "verified" &&
              resolution.person.id !== note.id)
          )
            return c.json(
              {
                error: "identity_requires_review",
                detail:
                  "This account cannot be assigned automatically. Review its existing person records first.",
              },
              409,
            );
        }
        const freshActor = resolveActor(c);
        if (
          freshActor.kind !== "user" ||
          freshActor.email !== actor.email ||
          !capsFor(freshActor, ref(note)).has("edit")
        )
          return c.json({ error: "forbidden" }, 403);
        const metadata = identityPatch(note, kind, value, action, {
          id: randomUUID(),
          kind,
          value,
          action,
          actor: actor.email,
          at: new Date().toISOString(),
        });
        const updated = await vc.updateNote(note.id, {
          metadata,
          ifUpdatedAt: note.updatedAt,
        });
        treeUpsertNote(resolveVaultEntry(actor.vaultId), updated);
        return c.json({
          person: { ...personSummary(updated), canManageIdentities: true },
        });
      } catch (e) {
        if (e instanceof VaultConflictError)
          return c.json({ error: "conflict" }, 409);
        if (e instanceof VaultError && e.status === 404)
          return c.json({ error: "not_found" }, 404);
        return c.json({ error: "identity_change_failed" }, 503);
      }
    },
  );
});

peopleApi.get("/:id", async (c) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  if (
    c.req.header("x-prism-vault") &&
    c.req.header("x-prism-vault") !== actor.vaultId
  )
    return c.json({ error: "vault_unavailable" }, 409);
  const after = c.req.query("after") ?? "";
  if (after.length > 2048) return c.json({ error: "bad_request" }, 400);
  try {
    const vc = vaultClient(actor.vaultId);
    let person = await vc.getNote(c.req.param("id"), { includeLinks: true });
    if (!isPerson(person) || !capsFor(actor, ref(person)).has("view"))
      return c.json({ error: "not_found" }, 404);
    // A merged person opens as the person they were merged into (additive
    // `mergedFrom` hint); a stub whose target can't be found opens as itself.
    let mergedFrom: { id: string; path: string | null } | null = null;
    if (isTombstone(person)) {
      const people = await vc.listNotes({ tags: ["person"], limit: 10_000, includeMetadata: ["name", "status", "merged_into", "mergedInto", "superseded_by", "type", "prism_creator", "prism_visibility"] });
      const canonical = new IdentityIndex(people.filter(isPerson)).canonicalOf(person);
      if (canonical && canonical.id !== person.id && capsFor(actor, ref(canonical)).has("view")) {
        mergedFrom = { id: person.id, path: person.path };
        person = await vc.getNote(canonical.id, { includeLinks: true });
      }
    }
    // Hydrated edges include both directions. Only explicit canonical links
    // associate records; a matching display name never merges people.
    const edges = new Map<string, Set<string>>();
    for (const link of person.links ?? []) {
      const other =
        link.sourceId === person.id
          ? link.targetId
          : link.targetId === person.id
            ? link.sourceId
            : null;
      if (!other || other === person.id) continue;
      const types = edges.get(other) ?? new Set<string>();
      types.add(link.relationship);
      edges.set(other, types);
    }
    const ids = [...edges.keys()]
      .sort((a, b) => a.localeCompare(b))
      .filter((id) => !after || id.localeCompare(after) > 0);
    const related: Array<{
      id: string;
      title: string;
      path: string | null;
      category: ReturnType<typeof personCategory>;
      relationships: string[];
    }> = [];
    // Scan a bounded page with bounded concurrency. Hidden records never yield
    // names, identities, bodies or counts. Cursor progress is opaque below.
    for (let offset = 0; offset < ids.length; offset += 6) {
      const batch = await Promise.all(
        ids.slice(offset, offset + 6).map(async (id) => {
          try {
            const n = await vc.getNote(id);
            return capsFor(actor, ref(n)).has("view") ? n : null;
          } catch (e) {
            if (e instanceof VaultError && e.status === 404) return null;
            throw e;
          }
        }),
      );
      for (const n of batch)
        if (n)
          related.push({
            id: n.id,
            title:
              (typeof n.metadata?.title === "string" &&
                n.metadata.title.trim()) ||
              n.path?.split("/").pop() ||
              "Untitled note",
            path: n.path,
            category: personCategory(n),
            relationships: [...edges.get(n.id)!].sort(),
          });
      if (related.length > 50) break;
      if (offset >= 996) return c.json({ error: "people_links_limit" }, 503);
    }
    const page = related.slice(0, 50);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      person: {
        ...personSummary(person),
        canManageIdentities:
          actor.kind === "user" && capsFor(actor, ref(person)).has("edit"),
      },
      related: page,
      next: related.length > 50 ? page.at(-1)!.id : null,
      ...(mergedFrom ? { mergedFrom } : {}),
    });
  } catch (e) {
    if (e instanceof VaultError && e.status === 404)
      return c.json({ error: "not_found" }, 404);
    return c.json({ error: "person_unavailable" }, 503);
  }
});

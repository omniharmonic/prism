/**
 * Durable canvas assertions project into ordinary vault links.
 * Drawings are authoritative; never execute a client-supplied edge not in the
 * server's current scene. CAS guards projection writes. Any unobserved source
 * revision forfeits deletion ownership, protecting manual/external relations.
 */
import { db, resolveVaultEntry } from "./db";
import { vaultClient, type Note } from "./parachute";
import {
  canvasRelations,
  type CanvasRelation,
} from "../../../packages/core/src/components/renderers/canvas-relations";

export class CanvasRelationError extends Error {}
type Edge = {
  source_id: string;
  target_id: string;
  relationship: string;
  owned: number;
};
type Assertion = Edge & { arrow_id: string };
const locks = new Map<string, Promise<void>>();
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
export async function reconcileCanvasRelations(options: {
  vaultId: string;
  canvasId: string;
  fingerprint: string;
  scene: () => Promise<readonly any[]>;
  authorize: (note: Note) => void;
}) {
  const { vaultId, canvasId, authorize } = options;
  return locked(vaultId, async () => {
    const entry = resolveVaultEntry(vaultId);
    if (entry.id !== vaultId) throw new CanvasRelationError("not_found");
    const identity = JSON.stringify([entry.url, entry.vault]);
    db.transaction(() => {
      const prior = db
        .prepare("SELECT identity FROM canvas_relation_vaults WHERE vault_id=?")
        .get(vaultId) as { identity: string } | undefined;
      if (prior?.identity !== identity) {
        for (const table of [
          "canvas_assertions",
          "canvas_relations",
          "canvas_relation_sources",
          "canvas_relation_jobs",
          "canvas_relation_receipts",
        ])
          db.prepare(`DELETE FROM ${table} WHERE vault_id=?`).run(vaultId);
        db.prepare(
          "INSERT INTO canvas_relation_vaults VALUES(?,?) ON CONFLICT(vault_id) DO UPDATE SET identity=excluded.identity",
        ).run(vaultId, identity);
      }
    })();
    const vc = vaultClient(vaultId);
    const canvas = await vc.getNote(canvasId);
    authorize(canvas);
    const desired = canvasRelations(await options.scene());
    const fingerprint = JSON.stringify(desired);
    if (fingerprint !== options.fingerprint)
      throw new CanvasRelationError("scene_changed");
    const old = db
      .prepare(
        "SELECT * FROM canvas_assertions WHERE vault_id=? AND canvas_id=?",
      )
      .all(vaultId, canvasId) as Assertion[];
    const jobs = db
      .prepare(
        "SELECT source_id FROM canvas_relation_jobs WHERE vault_id=? AND canvas_id=?",
      )
      .all(vaultId, canvasId) as { source_id: string }[];
    const sources = [
      ...new Set([
        ...desired.map((r) => r.sourceId),
        ...old.map((r) => r.source_id),
        ...jobs.map((r) => r.source_id),
      ]),
    ];
    if (sources.length > 500)
      throw new CanvasRelationError("relationship_limit");
    // Check every affected endpoint before staging anything, including removed
    // assertions and pending recovery work. No private source IDs leave this API.
    const ids = new Set([
      canvasId,
      ...sources,
      ...desired.map((r) => r.targetId),
      ...old.map((r) => r.target_id),
    ]);
    for (const source of sources) {
      const edges = db
        .prepare(
          "SELECT target_id FROM canvas_relations WHERE vault_id=? AND source_id=?",
        )
        .all(vaultId, source) as { target_id: string }[];
      for (const edge of edges) ids.add(edge.target_id);
    }
    if (ids.size > 1000) throw new CanvasRelationError("relationship_limit");
    for (const id of ids) authorize(await vc.getNote(id));
    // A live peer may have changed the scene while endpoint reads were pending.
    if (JSON.stringify(canvasRelations(await options.scene())) !== fingerprint)
      throw new CanvasRelationError("scene_changed");
    db.transaction(() => {
      db.prepare(
        "DELETE FROM canvas_assertions WHERE vault_id=? AND canvas_id=?",
      ).run(vaultId, canvasId);
      for (const r of desired) {
        db.prepare(
          "INSERT INTO canvas_assertions(vault_id,canvas_id,arrow_id,source_id,target_id,relationship) VALUES(?,?,?,?,?,?)",
        ).run(
          vaultId,
          canvasId,
          r.arrowId,
          r.sourceId,
          r.targetId,
          r.relationship,
        );
        db.prepare(
          "INSERT OR IGNORE INTO canvas_relations(vault_id,source_id,target_id,relationship) VALUES(?,?,?,?)",
        ).run(vaultId, r.sourceId, r.targetId, r.relationship);
      }
      for (const source of sources)
        db.prepare(
          "INSERT OR IGNORE INTO canvas_relation_jobs VALUES(?,?,?)",
        ).run(vaultId, canvasId, source);
    })();
    const prior = db
      .prepare(
        "SELECT retained FROM canvas_relation_receipts WHERE vault_id=? AND canvas_id=? AND fingerprint=?",
      )
      .get(vaultId, canvasId, fingerprint) as { retained: number } | undefined;
    let retained = !!prior?.retained;
    for (const source of sources) {
      const note = await vc.getNote(source, { includeLinks: true });
      authorize(note);
      authorize(await vc.getNote(canvasId));
      if (!note.updatedAt)
        throw new CanvasRelationError("revision_unavailable");
      const previous = db
        .prepare(
          "SELECT updated_at FROM canvas_relation_sources WHERE vault_id=? AND source_id=?",
        )
        .get(vaultId, source) as { updated_at: string } | undefined;
      if (previous?.updated_at !== note.updatedAt) {
        // Conservative by design: unknown edits may have added a manual claim.
        // Never infer ownership merely because an edge happens to exist.
        db.prepare(
          "UPDATE canvas_relations SET owned=0 WHERE vault_id=? AND source_id=?",
        ).run(vaultId, source);
      }
      const edges = db
        .prepare(
          "SELECT * FROM canvas_relations WHERE vault_id=? AND source_id=?",
        )
        .all(vaultId, source) as Edge[];
      const add: Array<{ target: string; relationship: string }> = [],
        remove: Array<{ target: string; relationship: string }> = [];
      for (const edge of edges) {
        authorize(await vc.getNote(edge.target_id));
        const present =
          note.links?.some(
            (l) =>
              l.sourceId === source &&
              l.targetId === edge.target_id &&
              l.relationship === edge.relationship,
          ) ?? false;
        const count = (
          db
            .prepare(
              "SELECT count(*) AS n FROM canvas_assertions WHERE vault_id=? AND source_id=? AND target_id=? AND relationship=?",
            )
            .get(vaultId, source, edge.target_id, edge.relationship) as {
            n: number;
          }
        ).n;
        if (count && !present)
          add.push({ target: edge.target_id, relationship: edge.relationship });
        if (!count && present) {
          if (edge.owned)
            remove.push({
              target: edge.target_id,
              relationship: edge.relationship,
            });
          else retained = true;
        }
      }
      // Last fresh authorization immediately before the CAS, including both ends.
      authorize(note);
      const updated =
        add.length || remove.length
          ? await vc.updateNote(source, {
              ifUpdatedAt: note.updatedAt,
              links: { add, remove },
            })
          : note;
      if (!updated.updatedAt)
        throw new CanvasRelationError("revision_unavailable");
      db.transaction(() => {
        for (const edge of add)
          db.prepare(
            "UPDATE canvas_relations SET owned=1 WHERE vault_id=? AND source_id=? AND target_id=? AND relationship=?",
          ).run(vaultId, source, edge.target, edge.relationship);
        db.prepare(
          "INSERT INTO canvas_relation_sources VALUES(?,?,?) ON CONFLICT(vault_id,source_id) DO UPDATE SET updated_at=excluded.updated_at",
        ).run(vaultId, source, updated.updatedAt);
        db.prepare(
          "DELETE FROM canvas_relation_jobs WHERE vault_id=? AND canvas_id=? AND source_id=?",
        ).run(vaultId, canvasId, source);
      })();
    }
    db.prepare(
      "INSERT INTO canvas_relation_receipts VALUES(?,?,?,?) ON CONFLICT(vault_id,canvas_id) DO UPDATE SET fingerprint=excluded.fingerprint,retained=excluded.retained",
    ).run(vaultId, canvasId, fingerprint, retained ? 1 : 0);
    return { synced: desired.length, retained };
  });
}

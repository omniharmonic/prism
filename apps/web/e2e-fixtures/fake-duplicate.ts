/**
 * The pages DUPLICATE route (`POST /api/notes/:id/duplicate`, NP-PG-18) for in-page
 * fixture servers: the page and every live page under its path are copied beside it
 * ("<Title> (copy)"), same relative paths and order keys, bodies through the SAME
 * pure copy code the server uses (`copyBodyOf`), one `requestId` = one copy however
 * often it is sent. `skip` = ids this viewer "cannot see" (left out, only counted);
 * `failOnce` = source ids whose copy fails once (a 207, finished by the retry).
 * Mutates `notes` in place.
 */
import { ORDER_KEY, copyBodyOf, isTrashed, isUnder, leafName, parentOf, templateKeepsKey, withoutExtension } from "../../../packages/core/src/lib/pages/model";

type Row = { id: string; path?: string | null; content?: string; tags?: string[] | null; metadata?: Record<string, unknown> | null; createdAt?: string; updatedAt?: string | null };
interface Job { source: string; target: string; copies: Map<string, string> }
const jobs = new Map<string, Job>();
let seq = 0;

export function fakeDuplicate(
  notes: Row[],
  id: string,
  body: Record<string, unknown>,
  stamp: () => string,
  opts: { skip?: Set<string>; failOnce?: Set<string> } = {},
): { status: number; body: Record<string, unknown> } {
  const root = notes.find((n) => n.id === id);
  if (!root?.path || isTrashed(root)) return { status: 404, body: { error: "not_found" } };
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return { status: 400, body: { error: "invalid_request" } };
  const from = root.path;
  let job = jobs.get(requestId);
  if (job && job.source !== root.id) return { status: 422, body: { error: "request_mismatch" } };
  if (!job) {
    const parent = parentOf(from);
    const base = `${withoutExtension(leafName(from))} (copy)`;
    const taken = (p: string) => notes.some((n) => n.path?.toLowerCase() === p.toLowerCase());
    let name = base;
    for (let i = 2; taken((parent ? `${parent}/` : "") + name); i++) name = `${base} ${i}`;
    job = { source: root.id, target: (parent ? `${parent}/` : "") + name, copies: new Map() };
    jobs.set(requestId, job);
  }
  const below = body.withSubpages === false ? [] : notes.filter((n) => isUnder(n.path, from) && !isTrashed(n)).sort((a, b) => (a.path! < b.path! ? -1 : 1));
  const skipped = below.filter((n) => opts.skip?.has(n.id)).length;
  const plan = [root, ...below.filter((n) => !opts.skip?.has(n.id))];
  const title = withoutExtension(leafName(job.target));
  const pathOf = new Map(plan.map((n) => [n.path!.toLowerCase(), job!.target + n.path!.slice(from.length)]));
  const answer = () => ({ id: job!.copies.get(root.id)!, path: job!.target, title, created: job!.copies.size, skipped, rows: 0, droppedTags: 0, privateKept: 0 });
  for (const source of plan) {
    if (job.copies.has(source.id)) continue;
    if (opts.failOnce?.delete(source.id)) {
      return { status: 207, body: { error: "partial_duplicate", reason: "Some pages were copied and some were not.", requestId, ...answer(), remaining: plan.length - job.copies.size, failed: { reason: "vault_500" } } };
    }
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source.metadata ?? {})) if (templateKeepsKey(k, v)) metadata[k] = v;
    if (source === root) metadata.title = title;
    else if (typeof source.metadata?.[ORDER_KEY] === "number") metadata[ORDER_KEY] = source.metadata[ORDER_KEY];
    const copyId = `copy-${++seq}`;
    job.copies.set(source.id, copyId);
    notes.push({
      id: copyId,
      path: pathOf.get(source.path!.toLowerCase())!,
      tags: [...(source.tags ?? [])],
      metadata,
      content: copyBodyOf(
        { content: source.content ?? "", path: source.path, metadata: source.metadata, tags: source.tags },
        { pageId: (old) => job!.copies.get(old) ?? null, path: (t) => pathOf.get(t.toLowerCase()) ?? null },
      ),
      createdAt: stamp(),
      updatedAt: stamp(),
    });
  }
  return { status: 200, body: { ok: true, ...answer(), unlinked: 0, files: { copied: 0, failed: 0 }, filesPending: [], audience: { sharedPage: false, private: 0 } } };
}

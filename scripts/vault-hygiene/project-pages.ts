/** Optional project repair/hygiene. Dry-run first; backup, fresh CAS and undo for every write. */
import { pathToFileURL } from "node:url";
import { guardTarget, isLive, INGEST_OWNED_TAGS, parseArgs, rateOf, readToken, runCli, Throttle, UndoLog, undoLogPath, UsageError, VaultApi, HttpError, type Ctx, type VaultNote } from "./lib";
import { projectTarget } from "../../packages/core/src/lib/projects/related";
const ROOT = "vault/projects/";
const MERGES = new Map([["ethboulder", "eth-boulder"], ["bioregional-foodchain-design", "bioregional-food-chain"]]);
const PROMOTIONS = ["opencivics/icfc", "opencivics-case-studies/planetary-regeneration-alliance"];
const isProject = (n: VaultNote) => n.tags?.includes("project") || n.metadata?.type === "project" || /\/PROJECT(?:\.md)?$/i.test(n.path ?? "");
const folderOf = (n: VaultNote) => (n.path ?? "").replace(/\/PROJECT(?:\.md)?$/i, "");
const titleOf = (n: VaultNote) => String(n.metadata?.title || n.metadata?.name || folderOf(n).split("/").pop() || "Project");
const values = (v: unknown): unknown[] => v == null ? [] : Array.isArray(v) ? v : [v];

export function projectResolver(notes: VaultNote[]) {
  const projects = notes.filter(n => isLive(n) && isProject(n) && !n.metadata?.merged_into);
  const promoted = new Map(projects.filter(p => typeof p.metadata?.promoted_from === "string").map(p => [String(p.metadata!.promoted_from), p]));
  const index = new Map<string, VaultNote[]>();
  for (const p of projects) {
    if (promoted.has(p.id)) continue;
    const folder = folderOf(p);
    for (const value of [p.id, p.path, folder, folder.replace(ROOT, ""), p.metadata?.slug, ...values(p.metadata?.aliases)]) {
      if (typeof value !== "string" || !value) continue;
      const key = projectTarget(value); const existing = index.get(key) ?? [];
      if (!existing.some(n => n.id === p.id)) existing.push(p);
      index.set(key, existing);
    }
  }
  const redirects = new Map<string, VaultNote>();
  for (const [id, target] of promoted) {
    const source = projects.find(p => p.id === id);
    if (source) for (const ref of [source.id, source.path, folderOf(source), folderOf(source).replace(ROOT, ""), ...values(source.metadata?.aliases)]) if (typeof ref === "string") redirects.set(projectTarget(ref), target);
  }
  for (const [from, to] of MERGES) {
    const duplicate = projects.find(p => folderOf(p).toLowerCase() === `${ROOT}${from}`);
    const target = projects.find(p => folderOf(p).toLowerCase() === `${ROOT}${to}`);
    if (duplicate && target) for (const ref of [duplicate.id, duplicate.path, folderOf(duplicate), from, ...values(duplicate.metadata?.aliases)]) if (typeof ref === "string") redirects.set(projectTarget(ref), target);
  }
  return { projects, resolve(value: string): VaultNote | undefined {
    let key = projectTarget(value);
    if (redirects.has(key)) return redirects.get(key);
    for (const [from, to] of MERGES) {
      if ([from, `${ROOT}${from}`, `${ROOT}${from}/project`].includes(key)) key = `${ROOT}${to}/project`;
    }
    const found = index.get(key); return found?.length === 1 ? found[0] : undefined;
  }};
}

export interface Patch { content?: string; metadata?: Record<string, unknown> }
export function hygienePatch(note: VaultNote, notes: VaultNote[], resolver = projectResolver(notes)): Patch {
  const { projects, resolve } = resolver;
  const metadata: Record<string, unknown> = {};
  // Populated canonical membership wins over stale legacy metadata.
  // Unknown/ambiguous canonical values are preserved verbatim.
  const canonicalValues = values(note.metadata?.projects);
  const stored = canonicalValues.length ? canonicalValues : values(note.metadata?.project);
  let memberships = stored.map(v => typeof v === "string" ? resolve(v)?.path ? `[[${resolve(v)!.path}]]` : v : v);
  if (!stored.length && note.path && !isProject(note)) {
    const ancestors = projects.filter(p => note.path!.startsWith(`${folderOf(p)}/`)).sort((a,b) => folderOf(b).length - folderOf(a).length);
    if (ancestors[0]?.path) memberships = [`[[${ancestors[0].path}]]`];
  }
  memberships = [...new Map(memberships.map(v => [JSON.stringify(v), v])).values()];
  if (memberships.length && JSON.stringify(note.metadata?.projects) !== JSON.stringify(memberships)) metadata.projects = memberships;
  if (note.metadata?.project != null && memberships.length) metadata.project = null;
  let content = note.content ?? "";
  if (isProject(note) && !note.tags?.some(t => INGEST_OWNED_TAGS.includes(t)) && !content.trimStart().startsWith("<")) {
    const heading = /^#\s+(.+)\r?\n/.exec(content);
    if (heading && heading[1]!.trim().toLowerCase() === titleOf(note).trim().toLowerCase()) content = content.slice(heading[0].length).replace(/^\s*\n/, "");
    const sections = /^##\s+(Key Context for Agents|Agent config|Recent Activity)\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gim;
    content = content.replace(sections, (section, name: string, body: string) => {
      const field = name.toLowerCase() === "recent activity" ? "agent_recent_activity" : "agent_context";
      const text = body.replace(/<!--[\s\S]*?-->/g, "").trim();
      if (text) {
        const existing = String(metadata[field] ?? note.metadata?.[field] ?? "");
        if (!existing.includes(text)) metadata[field] = [existing, `${name}:\n${text}`].filter(Boolean).join("\n\n");
      }
      return "";
    });
  }
  return { ...(Object.keys(metadata).length ? { metadata } : {}), ...(content !== (note.content ?? "") ? { content: content.trimEnd() + "\n" } : {}) };
}

export function missingProjects(notes: VaultNote[]): Array<{ path: string; source?: VaultNote }> {
  const paths = new Set(notes.filter(isLive).map(n => n.path));
  const folders = new Set<string>();
  for (const note of notes.filter(isLive)) {
    if (!note.path?.startsWith(ROOT)) continue;
    const tail = note.path.slice(ROOT.length);
    if (tail.includes("/")) folders.add(tail.split("/")[0]!);
    else if (isProject(note)) folders.add(tail);
  }
  for (const path of PROMOTIONS) if (notes.some(n => isLive(n) && (n.path === `${ROOT}${path}` || n.path?.startsWith(`${ROOT}${path}/`)))) folders.add(path);
  return [...folders].filter(slug => !MERGES.has(slug) && !paths.has(`${ROOT}${slug}/PROJECT`) && !paths.has(`${ROOT}${slug}/PROJECT.md`) && !notes.some(n => isLive(n) && n.path === `${ROOT}${slug}` && isProject(n))).sort().map(slug => ({ path: `${ROOT}${slug}/PROJECT`, source: notes.find(n => n.path === `${ROOT}${slug}` && isProject(n)) }));
}


export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "prism-url", "rate", "undo-log", "phase"]);
  for (const flag of args.flags) if (!["apply", "backup-confirmed", "production", "live-sections-confirmed"].includes(flag)) throw new UsageError(`unknown flag --${flag}`);
  const phase = args.get("phase") ?? "hygiene";
  if (!["repair", "hygiene", "indexes"].includes(phase)) throw new UsageError("--phase repair|hygiene|indexes");
  if (phase === "indexes" && !args.has("live-sections-confirmed")) throw new UsageError("index retirement needs --live-sections-confirmed after deploying live sections");
  const apply = args.has("apply");
  if (apply && !args.has("backup-confirmed")) throw new UsageError("--apply needs --backup-confirmed");
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", readToken(ctx));
  const owner = ctx.env.PRISM_OWNER_TOKEN?.trim();
  const prism = apply && phase !== "hygiene" ? guardTarget(args.get("prism-url"), args.has("production"), "--prism-url") : null;
  if (prism && !owner) throw new UsageError("repair/index apply needs PRISM_OWNER_TOKEN for reversible Trash");
  const throttle = new Throttle(ctx, rateOf(args));
  const log = new UndoLog(ctx, undoLogPath(args, ctx, `project-${phase}`));
  const loadInventory = async () => {
    const rows = await vault.listNotes({ includeContent: false, includeLinks: phase === "repair", includeMetadata: ["projects", "project", "title", "name", "slug", "type", "aliases", "promoted_from", "merged_into", "prism_trashed_at"] });
    if (rows.length >= 50000) throw new UsageError("inventory reached limit; refusing a partial migration");
    const live = rows.filter(isLive);
    // Bodies are needed only for project prose and generated index checks.
    // Meeting, email and document bodies are never downloaded or rewritten.
    for (let i = 0; i < live.length; i++) {
      const n = live[i]!;
      if (isProject(n) || (phase === "indexes" && /\/(?:INDEX|index)(?:\.md)?$/.test(n.path ?? ""))) {
        const fresh = await vault.getNote(n.id, { includeLinks: phase === "repair" });
        if (fresh && isLive(fresh)) live[i] = fresh;
      }
    }
    return live;
  };
  let notes = await loadInventory();
  let resolver = projectResolver(notes);
  let writes = 0;
  let planned = 0;
  let failures = 0;
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} project-${phase}: ${notes.length} live notes`);
  const patch = async (fresh: VaultNote, change: Patch) => {
    if (!Object.keys(change).length) return;
    planned++;
    ctx.log(`  ${apply ? "patch" : "would patch"} ${fresh.id} ${fresh.path ?? ""}`);
    if (!apply) return;
    if (!fresh.updatedAt) throw new Error("fresh revision missing");
    const before = { ...(change.content !== undefined ? { content: fresh.content ?? "" } : {}), ...(change.metadata ? { metadata: Object.fromEntries(Object.keys(change.metadata).map(k => [k, fresh.metadata?.[k] ?? null])) } : {}) };
    await throttle.wait(); const after = await vault.patch(fresh.id, change, fresh.updatedAt);
    log.append({ kind: "vault-patch", script: `project-${phase}`, at: ctx.now().toISOString(), id: fresh.id, path: fresh.path ?? null, before, afterUpdatedAt: after.updatedAt ?? "" }); writes++;
  };
  const create = async (path: string, content: string, tags: string[], metadata: Record<string, unknown>): Promise<VaultNote | undefined> => {
    const existing = await vault.getNote(path);
    if (existing) {
      if (!isLive(existing)) throw new Error("path is occupied by a trashed note");
      return existing;
    }
    planned++;
    ctx.log(`  ${apply ? "create" : "would create"} ${path}`);
    if (!apply) return { id: `planned:${path}`, path, content, tags, metadata };
    await throttle.wait(); const after = await vault.create({ path, content, tags, metadata });
    if (!after.existed) { log.append({ kind: "vault-create", script: `project-${phase}`, at: ctx.now().toISOString(), id: after.id, path: after.path ?? path, afterUpdatedAt: after.updatedAt ?? "" }); writes++; }
    return after;
  };
  const trash = async (note: VaultNote, canonicalId: string) => {
    planned++;
    ctx.log(`  ${apply ? "trash" : "would trash"} ${note.id} ${note.path ?? ""}`);
    const children = note.path ? (await vault.listNotes({ pathPrefix: `${note.path}/`, includeMetadata: ["prism_trashed_at"] })).filter(isLive) : [];
    if (children.length) throw new Error("refusing cascading Trash of descendants");
    if (!apply) return;
    if (!note.updatedAt) throw new Error("fresh revision missing");
    await throttle.wait(); const res = await ctx.fetch(`${prism!.origin}/api/notes/${encodeURIComponent(note.id)}/trash`, { method: "POST", headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ if_updated_at: note.updatedAt }) });
    if (!res.ok) throw new HttpError(res.status, `trash ${note.id}: ${res.status}`);
    const after = await vault.getNote(note.id, { includeContent: false }).catch(() => null);
    log.append({ kind: "prism-trash", script: `project-${phase}`, at: ctx.now().toISOString(), id: note.id, path: note.path ?? null, canonicalId, ...(after?.updatedAt ? { afterUpdatedAt: after.updatedAt } : {}) }); writes++;
  };
  if (phase === "hygiene") {
    for (const candidate of notes) {
      if (!Object.keys(hygienePatch(candidate, notes, resolver)).length) continue;
      try { const fresh = await vault.getNote(candidate.id, { includeContent: isProject(candidate) }); if (fresh && isLive(fresh)) await patch(fresh, hygienePatch(fresh, notes, resolver)); }
      catch { failures++; ctx.log(`  failed ${candidate.id}: write conflicted or unavailable`); }
    }
  }
  if (phase === "repair") {
    for (const candidate of missingProjects(notes)) {
      try {
        const source = candidate.source ? await vault.getNote(candidate.source.id) : null;
        const slug = candidate.path.slice(ROOT.length).replace(/\/PROJECT$/, "");
        await create(candidate.path, source?.content ?? "", ["project"], { ...(source?.metadata ?? {}), title: source ? titleOf(source) : slug.split("/").pop()!.replace(/-/g, " "), type: "project", slug, ...(source ? { promoted_from: source.id } : {}) });
      } catch { failures++; ctx.log(`  failed create ${candidate.path}`); }
    }
    if (apply) { notes = await loadInventory(); resolver = projectResolver(notes); }
    for (const candidate of notes.filter(isProject)) {
      try {
        const fresh = await vault.getNote(candidate.id); if (!fresh || !isLive(fresh)) continue;
        if ((fresh.content?.length ?? 0) > 40000) {
          const path = `${folderOf(fresh)}/Project background`;
          const archive = await create(path, fresh.content!, ["document"], { title: "Project background", projects: [`[[${fresh.path}]]`], split_from: fresh.id });
          if (archive?.content === fresh.content && archive.metadata?.split_from === fresh.id) await patch(fresh, { content: `${String(fresh.metadata?.description || fresh.metadata?.purpose || "Project background and working notes are preserved below.")}\n\n[[${path}|Project background]]\n` });
          else { failures++; ctx.log(`  skip split ${fresh.id}: archive path differs`); }
        }
      } catch { failures++; ctx.log(`  failed split ${candidate.id}`); }
    }
    const merges = [...MERGES].map(([from,to]) => ({ from, duplicate: notes.find(n => isProject(n) && folderOf(n) === `${ROOT}${from}`), canonical: notes.find(n => isProject(n) && folderOf(n) === `${ROOT}${to}`) }));
    for (const canonical of notes.filter(n => isProject(n) && typeof n.metadata?.promoted_from === "string")) {
      const duplicate = notes.find(n => n.id === canonical.metadata!.promoted_from);
      if (duplicate) merges.push({ from: duplicate.id.replace(/[^a-zA-Z0-9_-]/g,"_"), duplicate, canonical });
    }
    for (const { from, duplicate, canonical } of merges) {
      if (!duplicate || !canonical) continue;
      try {
        const fresh = await vault.getNote(duplicate.id); if (!fresh || !isLive(fresh)) continue;
        if (fresh.path && notes.some(n => n.id !== fresh.id && n.path?.startsWith(`${fresh.path}/`))) throw new Error("duplicate has descendants");
        const archive = await create(`${folderOf(canonical)}/Merged project ${from}`, fresh.content ?? "", ["document"], { ...fresh.metadata, title: `Merged project: ${titleOf(fresh)}`, type: "document", projects: [`[[${canonical.path}]]`], merged_from: fresh.id });
        if (archive?.content !== (fresh.content ?? "") || archive.metadata?.merged_from !== fresh.id) throw new Error("archive differs");
        // Old wikilinks resolve through aliases; never rewrite ingester-owned text.
        const target = await vault.getNote(canonical.id);
        if (!target || !isLive(target)) throw new Error("canonical unavailable");
        const aliases = [...new Set([...values(target.metadata?.aliases), fresh.id, fresh.path, folderOf(fresh), from, titleOf(fresh), ...values(fresh.metadata?.aliases)].filter(v => typeof v === "string" && v))];
        if (JSON.stringify(aliases) !== JSON.stringify(target.metadata?.aliases)) await patch(target, { metadata: { aliases } });
        for (const member of notes) {
          if (member.id === fresh.id) continue;
          const change = hygienePatch(member, notes, resolver);
          const refs = (member.links ?? []).filter(l => l.sourceId === member.id && l.targetId === fresh.id);
          if (!change.metadata && !refs.length) continue;
          const current = await vault.getNote(member.id, { includeLinks: true, includeContent: false }); if (!current || !isLive(current)) continue;
          await patch(current, { ...(hygienePatch(current, notes, resolver).metadata ? { metadata: hygienePatch(current, notes, resolver).metadata } : {}) });
          const latest = apply ? await vault.getNote(current.id, { includeLinks: true, includeContent: false }) : current;
          const removed = (latest?.links ?? []).filter(l => l.sourceId === current.id && l.targetId === fresh.id).map(l => ({ target: l.targetId, relationship: l.relationship }));
          if (removed.length && apply) {
            const added = removed.map(l => ({ target: canonical.id, relationship: l.relationship })).filter(l => !(latest?.links ?? []).some(x => x.sourceId === current.id && x.targetId === l.target && x.relationship === l.relationship));
            await throttle.wait(); const after = await vault.patchLinks(current.id, { add: added, remove: removed }, latest!.updatedAt!);
            log.append({ kind: "vault-links", script: "project-repair", at: ctx.now().toISOString(), id: current.id, path: current.path ?? null, afterUpdatedAt: after.updatedAt ?? "", added, removed }); writes++;
          }
        }
        // No Trash after a concurrent source edit; Prism CAS is the final gate.
        await trash(fresh, canonical.id);
      } catch { failures++; ctx.log(`  failed merge ${duplicate.id}: preserved source; rerun after review`); }
    }
  }
  if (phase === "indexes") {
    for (const candidate of notes) {
      // Only pure generated Dataview indexes; any surrounding human prose blocks retirement.
      if (!candidate.path?.startsWith(ROOT) || !/(?:^|\/)(?:INDEX|index)(?:\.md)?$/.test(candidate.path)) continue;
      const body = candidate.content ?? "";
      if (!body.includes("```dataview") || body.replace(/^#.*$/gm, "").replace(/```dataview[\s\S]*?```/g, "").trim()) continue;
      try { const fresh = await vault.getNote(candidate.id); if (fresh?.content === candidate.content && isLive(fresh)) await trash(fresh, "live-project-sections"); }
      catch { failures++; ctx.log(`  failed index ${candidate.id}`); }
    }
  }
  ctx.log(`done: ${planned} planned, ${writes} writes, ${failures} failed; undo ${log.path}`);
  return failures ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli((argv,ctx) => main(argv,ctx));

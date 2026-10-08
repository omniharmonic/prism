/**
 * Apply the proposed tag-schema corrections in schema-fixes.json.
 *
 * Why a separate script: `seedTagSchemas` (apps/server/scripts/lib) is additive
 * only — it never overwrites a field definition — and Prism's `PUT /api/schemas`
 * refuses type changes. The changes here CHANGE existing definitions, so they go
 * straight to the vault's `PUT /tags/:tag` with a `vault:<name>:admin` token.
 * No note is rewritten; a schema write only changes what the vault validates.
 *
 * Usage (from the repo root):
 *   PARACHUTE_TOKEN=… node --import tsx scripts/vault-hygiene/apply-schema-fixes.ts \
 *     --vault-url http://127.0.0.1:1940 --production [--vault default] [--only <tag>]… [--include-optional]
 *       → dry run: prints the diff against the LIVE schema, writes nothing.
 *   PARACHUTE_ADMIN_TOKEN=$(parachute auth mint-token --scope vault:default:admin --ephemeral) \
 *     node --import tsx scripts/vault-hygiene/apply-schema-fixes.ts … --apply --backup-confirmed
 *       → writes one PUT per touched tag, then re-reads and verifies every change.
 *   … --reverse  → the undo: plans (and with --apply writes) every `to` back to its `from`.
 *
 * A field whose live definition matches neither `from` nor `to` (someone changed
 * it meanwhile) is reported as drift and left alone.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardTarget, parseArgs, runCli, scrub, UsageError, VaultApi, writeMode, type Ctx, type FieldDef, type VaultTag } from "./lib";

export interface SchemaChange {
  id: string;
  tag: string;
  field: string;
  optional?: boolean;
  from: FieldDef | null;
  to: FieldDef;
  reason: string;
}

export const FIXES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "schema-fixes.json");

export function loadFixes(path = FIXES_PATH): SchemaChange[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { changes: SchemaChange[] }).changes;
}

/** The part of a definition the vault validates against. Descriptions don't count. */
export function essentials(d: FieldDef | null | undefined): string {
  if (!d) return "absent";
  return JSON.stringify([d.type ?? null, d.enum ?? null, d.default ?? null]);
}

/** {@link essentials} without the default: what a live field with NO default is compared on. */
function shape(d: FieldDef | null | undefined): string {
  if (!d) return "absent";
  return JSON.stringify([d.type ?? null, d.enum ?? null]);
}

export type Verdict = "pending" | "already" | "drift" | "tag-missing";

export interface PlannedChange {
  change: SchemaChange;
  verdict: Verdict;
  live: FieldDef | null;
  /**
   * The live field has no default where the fix file expected one (vault ≤0.6 filled the first
   * enum value implicitly, so older vaults never stored one). The change is applied WITHOUT a
   * default: adding one would make the vault start filling it into notes.
   */
  noDefault?: boolean;
}

export function planChanges(changes: SchemaChange[], live: VaultTag[], opts: { only?: string[]; includeOptional?: boolean } = {}): PlannedChange[] {
  const byName = new Map(live.map((t) => [t.name, t]));
  const out: PlannedChange[] = [];
  for (const change of changes) {
    if (change.optional && !opts.includeOptional) continue;
    if (opts.only?.length && !opts.only.includes(change.tag)) continue;
    const tag = byName.get(change.tag);
    const hasSchema = !!tag && (!!tag.description || Object.keys(tag.fields ?? {}).length > 0);
    if (!hasSchema) {
      out.push({ change, verdict: "tag-missing", live: null });
      continue;
    }
    const cur = tag!.fields?.[change.field] ?? null;
    const now = essentials(cur);
    let verdict: Verdict = now === essentials(change.to) ? "already" : now === essentials(change.from) ? "pending" : "drift";
    let noDefault = false;
    if (verdict === "drift" && cur && cur.default === undefined && change.from?.default !== undefined && JSON.stringify(change.from.default) === JSON.stringify(change.to.default ?? null)) {
      // Same field, but this vault never stored the default: judge it without one.
      if (shape(cur) === shape(change.to)) verdict = "already";
      else if (shape(cur) === shape(change.from)) (verdict = "pending"), (noDefault = true);
    }
    out.push({ change, verdict, live: cur, ...(noDefault ? { noDefault } : {}) });
  }
  // A shared type change drops the field from every declarer before re-declaring it
  // (sharedTypeChanges). If that run stopped half-way the field is absent here while a
  // sibling tag is pending or done: re-adding it is the rest of the same change.
  for (const p of out) {
    if (p.verdict !== "drift" || p.live || !p.change.from) continue;
    const sibling = out.some((q) => q !== p && q.change.field === p.change.field && q.verdict !== "tag-missing" && q.verdict !== "drift" && essentials(q.change.to) === essentials(p.change.to));
    if (sibling) p.verdict = "pending";
  }
  return out;
}

export interface SharedTypeChange {
  field: string;
  type: string;
  /** Planned tags that still declare the field with the old type. */
  tags: string[];
  /** Tags outside the plan that declare the field with another type: the change cannot be made. */
  blockers: string[];
}

/**
 * The vault refuses a field whose type differs from ANY other tag's declaration of the same
 * name (422 tag_field_conflict), so a type change of a field several tags share can never be
 * written tag by tag. Such a field is first dropped from every planned declarer
 * (`replace_fields`), then re-declared with the new type. Note values are never touched.
 */
export function sharedTypeChanges(changes: SchemaChange[], live: VaultTag[]): SharedTypeChange[] {
  const out: SharedTypeChange[] = [];
  for (const field of [...new Set(changes.map((c) => c.field))]) {
    const planned = new Map(changes.filter((c) => c.field === field).map((c) => [c.tag, c]));
    const types = new Set([...planned.values()].map((c) => c.to.type ?? ""));
    if (types.size !== 1) continue;
    const type = [...types][0]!;
    const declarers = live.filter((t) => t.fields?.[field] && (t.fields[field]!.type ?? "") !== type);
    const tags = declarers.filter((t) => planned.has(t.name)).map((t) => t.name);
    if (!tags.length) continue;
    const blockers = declarers.filter((t) => !planned.has(t.name)).map((t) => t.name);
    if (declarers.length > 1 || blockers.length) out.push({ field, type, tags, blockers });
  }
  return out;
}

/** One human line per change: `task.status: enum +[pending, waiting]`. */
export function describe(p: PlannedChange): string {
  const { change: c, live } = p;
  const name = `${c.tag}.${c.field}`;
  if (p.verdict === "tag-missing") return `${name}: SKIP — the vault has no schema for #${c.tag}`;
  if (p.verdict === "already") return `${name}: already applied`;
  if (p.verdict === "drift") return `${name}: SKIP (drift) — live is ${essentials(live)}, expected ${essentials(c.from)}`;
  const parts: string[] = [];
  if (!live) parts.push(`add field (${c.to.type}${c.to.enum ? ` enum [${c.to.enum.join(", ")}]` : ""})`);
  else {
    if (live.type !== c.to.type) parts.push(`type ${live.type} → ${c.to.type}`);
    const a = live.enum ?? [];
    const b = c.to.enum ?? [];
    const added = b.filter((v) => !a.includes(v));
    if (live.enum && !c.to.enum) parts.push("enum removed (free text)");
    else if (!live.enum && c.to.enum) parts.push(`enum set [${b.join(", ")}]`);
    else {
      if (added.length) parts.push(`enum +[${added.join(", ")}]`);
      const removed = a.filter((v) => !b.includes(v));
      if (removed.length) parts.push(`enum −[${removed.join(", ")}]`);
    }
    if (p.noDefault) parts.push("no default kept (the live field has none)");
    else if (JSON.stringify(live.default ?? null) !== JSON.stringify(c.to.default ?? null)) parts.push(`default ${JSON.stringify(live.default ?? null)} → ${JSON.stringify(c.to.default ?? null)}`);
  }
  return `${name}: ${parts.join("; ") || "description only"}   (${c.reason})`;
}

const INDEXABLE = new Set(["string", "integer", "boolean", "reference", "date"]);

/** The body for one tag: the live fields (indexed kept only where the vault can index) with the changes laid over them. */
export function tagBody(live: VaultTag, changes: SchemaChange[]): { description: string; fields: Record<string, FieldDef> } {
  const fields: Record<string, FieldDef> = {};
  for (const [name, def] of Object.entries(live.fields ?? {})) {
    if (def?.indexed && !INDEXABLE.has(def.type ?? "")) {
      const { indexed: _drop, ...rest } = def;
      fields[name] = rest;
    } else fields[name] = def;
  }
  for (const c of changes) {
    const prev = fields[c.field];
    // Never drop an index the field already has (only task.priority today).
    fields[c.field] = { ...c.to, ...(prev?.indexed && INDEXABLE.has(c.to.type ?? "") ? { indexed: true } : {}) };
  }
  return { description: live.description ?? "", fields };
}

function withoutDefault(c: SchemaChange): SchemaChange {
  const { default: _none, ...to } = c.to;
  return { ...c, to };
}

export function reverseFixes(changes: SchemaChange[]): SchemaChange[] {
  return changes.filter((c) => c.from).map((c) => ({ ...c, id: `${c.id}-reverse`, from: c.to, to: c.from!, reason: `undo of ${c.id}` }));
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseArgs(argv, ["vault-url", "vault", "only", "fixes"]);
  for (const f of args.flags) if (!["apply", "backup-confirmed", "production", "include-optional", "reverse"].includes(f)) throw new UsageError(`unknown flag --${f}`);
  const url = guardTarget(args.get("vault-url"), args.has("production"));
  const apply = writeMode(args);
  const admin = ctx.env.PARACHUTE_ADMIN_TOKEN?.trim();
  if (apply && !admin) throw new UsageError("--apply needs PARACHUTE_ADMIN_TOKEN (parachute auth mint-token --scope vault:<name>:admin --ephemeral)");
  const read = ctx.env.PARACHUTE_TOKEN?.trim() || admin;
  if (!read) throw new UsageError("set PARACHUTE_TOKEN (read) or PARACHUTE_ADMIN_TOKEN");
  const vault = new VaultApi(ctx, url, args.get("vault") ?? "default", read);

  const loaded = loadFixes(args.get("fixes") ?? FIXES_PATH);
  // --reverse = the undo: every change's `to` becomes the expectation and `from`
  // the target. Additions (from: null) cannot be undone by a merging PUT and are skipped.
  const fixes = args.has("reverse") ? reverseFixes(loaded) : loaded;
  const live = await vault.getTags();
  const plan = planChanges(fixes, live, { only: args.all("only"), includeOptional: args.has("include-optional") });
  ctx.log(`${apply ? "APPLY" : "DRY RUN"} — ${plan.length} schema change(s) against ${url.host}`);
  for (const p of plan) ctx.log(`  ${describe(p)}`);
  const pending = plan.filter((p) => p.verdict === "pending");
  const counts = (v: Verdict) => plan.filter((p) => p.verdict === v).length;
  const shared = sharedTypeChanges(pending.map((p) => p.change), live);
  for (const g of shared) ctx.log(`  shared field "${g.field}": dropped from #${g.tags.join(", #")}, then re-declared as ${g.type} (the vault requires one type across tags)${g.blockers.length ? ` — BLOCKED by #${g.blockers.join(", #")}` : ""}`);
  ctx.log(`summary: ${pending.length} to apply, ${counts("already")} already applied, ${counts("drift")} drift, ${counts("tag-missing")} tag missing`);
  if (!apply) {
    if (pending.length) ctx.log("nothing written. Re-run with --apply --backup-confirmed and PARACHUTE_ADMIN_TOKEN to write.");
    return 0;
  }

  const byTag = new Map<string, SchemaChange[]>();
  for (const p of pending) byTag.set(p.change.tag, [...(byTag.get(p.change.tag) ?? []), p.noDefault ? withoutDefault(p.change) : p.change]);
  const liveByName = new Map(live.map((t) => [t.name, t]));
  const written: string[] = [];

  const blocked = shared.filter((g) => g.blockers.length);
  if (blocked.length) {
    for (const g of blocked) ctx.log(`  BLOCKED ${g.field}: #${g.blockers.join(", #")} also declare it with another type and are not in this plan`);
    ctx.log("stopped before writing anything.");
    return 1;
  }
  for (const g of shared) {
    for (const tag of g.tags) {
      const body = tagBody(liveByName.get(tag)!, []);
      delete body.fields[g.field];
      try {
        await vault.putTag(tag, { ...body, replace_fields: true }, admin!);
        const t = liveByName.get(tag)!;
        const { [g.field]: _dropped, ...rest } = t.fields ?? {};
        liveByName.set(tag, { ...t, fields: rest });
        ctx.log(`  dropped ${tag}.${g.field} (re-declared as ${g.type} below)`);
      } catch (e) {
        ctx.log(`  FAILED dropping ${tag}.${g.field}: ${scrub(e instanceof Error ? e.message : String(e))}`);
        ctx.log(`stopped. Re-run this step to finish: a dropped field is re-declared on the next run. Tags written before the failure: ${written.join(", ") || "none"}.`);
        return 1;
      }
    }
  }
  // Type changes first: a tag's PUT carries its whole field map, and the vault checks every
  // field in it against the other tags, so a field that still disagrees elsewhere (report.date
  // vs transcript.date) must be corrected before those other tags are written.
  const changesType = (tag: string, cs: SchemaChange[]) => cs.some((c) => (live.find((t) => t.name === tag)?.fields?.[c.field]?.type ?? c.to.type) !== c.to.type);
  const ordered = [...byTag].sort((a, b) => Number(changesType(b[0], b[1])) - Number(changesType(a[0], a[1])));
  for (const [tag, changes] of ordered) {
    try {
      await vault.putTag(tag, tagBody(liveByName.get(tag)!, changes), admin!);
      written.push(tag);
      ctx.log(`  wrote #${tag} (${changes.map((c) => c.field).join(", ")})`);
    } catch (e) {
      ctx.log(`  FAILED #${tag}: ${scrub(e instanceof Error ? e.message : String(e))}`);
      ctx.log(`stopped. Tags written before the failure: ${written.join(", ") || "none"}. Nothing else was sent.`);
      return 1;
    }
  }

  // Verify: the vault may merge definitions instead of replacing them.
  const after = planChanges(
    pending.map((p) => p.change),
    await vault.getTags(),
    { includeOptional: true },
  );
  const notTaken = after.filter((p) => p.verdict !== "already");
  for (const p of notTaken) ctx.log(`  NOT TAKEN ${p.change.tag}.${p.change.field}: live is ${essentials(p.live)}`);
  ctx.log(notTaken.length ? `verify: ${notTaken.length} change(s) did not take — see above` : `verify: all ${pending.length} change(s) live`);
  return notTaken.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli(main);

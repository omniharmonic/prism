import type { VaultClient } from "../../data/VaultClient";
import type { Note } from "../../lib/types";
import { safeTitleLeaf, type FieldHints, type PropertyKind, type SchemaPatch } from "../../lib/database/schema";
import { defaultConfig, VIEW_LABELS, type DatabaseConfig, type DatabaseView, type ViewType } from "./config";

/**
 * Create a database page over `tag` (see ./config.ts for the model). Exported
 * for any "new page" surface: `createDatabaseNote(client, "task", "Projects/Launch plan")`.
 */
export async function createDatabaseNote(client: VaultClient, tag: string, path: string, description = ""): Promise<Note> {
  return client.createNote({
    content: description,
    path,
    metadata: { prism_type: "database", title: path.split("/").pop() || tag, prism_database: defaultConfig(tag) },
  });
}

// ── A NEW database with its own tag and properties ("Blank with schema", CSV → new database) ──

/** One property a new database starts with: the vault field + Prism's presentation hints. */
export interface NewDatabaseProperty {
  key: string;
  field: NonNullable<SchemaPatch["fields"]>[string];
  ui: FieldHints;
}
export interface BlankDatabasePlan {
  /** The NEW tag its rows will carry (the server refuses one in use, shared, published or an integration's). */
  tag: string;
  title: string;
  /** Folder for the new database page (ignored with `adopt`). */
  folder?: string;
  /** An existing, still unconfigured database page to turn into this database. */
  adopt?: Pick<Note, "id" | "path">;
  properties: NewDatabaseProperty[];
  /** The first view (default: a Table showing every property). */
  view?: DatabaseView;
}

/** How far a new database got (so a retry continues instead of starting over). */
export interface NewDatabaseProgress {
  /** The database page, once it exists. */
  note?: Pick<Note, "id" | "path">;
  /** We created that page in this attempt (as opposed to adopting one that was there). */
  createdPage?: boolean;
  /** Property batches (20 fields each) already written. */
  schemaBatches?: number;
  schemaDone?: boolean;
  configDone?: boolean;
}
export class NewDatabaseError extends Error {
  constructor(public readonly stage: "page" | "schema" | "config" | "import", public readonly progress: NewDatabaseProgress, public readonly detail: string | null, public readonly pageRemoved = false) {
    super(`new database: ${stage} failed`);
    this.name = "NewDatabaseError";
  }
}
/** The server's `detail`/`reason` out of a transport error message, if it carries one. */
export const newDatabaseErrorDetail = (e: unknown): string | null => {
  const raw = String((e as Error)?.message ?? "");
  const at = raw.indexOf("{");
  return at < 0 ? null : raw.slice(at).match(/"(?:detail|reason)":"([^"]+)"/)?.[1] ?? null;
};

/** The schema writes a plan needs: ≤ 20 fields each; the FIRST claims the tag (`requireNew`). */
export function newDatabaseSchemaBatches(plan: Pick<BlankDatabasePlan, "title" | "properties">): SchemaPatch[] {
  if (!plan.properties.length) return [{ requireNew: true, description: `Pages of the “${plan.title}” database` }];
  const out: SchemaPatch[] = [];
  for (let i = 0; i < plan.properties.length; i += 20) {
    const patch: SchemaPatch = { ...(i === 0 ? { requireNew: true } : {}), fields: {}, ui: {} };
    for (const p of plan.properties.slice(i, i + 20)) {
      patch.fields![p.key] = p.field;
      patch.ui![p.key] = p.ui;
    }
    out.push(patch);
  }
  return out;
}

/**
 * The first view of a new database: `type` over the given properties. A board groups
 * by the first status / select property, a calendar dates by the first date property
 * (null when the type cannot be built from these properties — say why, write nothing).
 */
export function blankDatabaseView(type: ViewType, properties: Array<Pick<NewDatabaseProperty, "key" | "ui">>): DatabaseView | null {
  const keys = properties.map((p) => p.key);
  const first = (kinds: PropertyKind[]) => properties.find((p) => p.ui.kind && kinds.includes(p.ui.kind))?.key;
  const view: DatabaseView = { id: type, name: VIEW_LABELS[type], type, ...(keys.length ? { visible: keys } : {}) };
  if (type === "board") {
    const by = first(["status", "select"]);
    if (!by) return null;
    view.groupBy = by;
  }
  if (type === "calendar") {
    const by = first(["date"]);
    if (!by) return null;
    view.dateKey = by;
  }
  return view;
}

/** Why a view type cannot be the first view of these properties ("" = it can). */
export function blankViewRefusal(type: ViewType, properties: Array<Pick<NewDatabaseProperty, "key" | "ui">>): string {
  if (blankDatabaseView(type, properties)) return "";
  return type === "board" ? "A board groups pages by a Status or Select property — add one, or choose another view." : "A calendar places pages by a Date property — add one, or choose another view.";
}

/**
 * Create a database with its own NEW tag. Order matters:
 *   1. the database PAGE (unconfigured) — or `adopt` an empty one;
 *   2. the tag's properties, with `requireNew`: the SERVER refuses a tag that is
 *      used, shared, published or an integration's (if it does, a page made in
 *      step 1 is put in the Trash again — a schema, once written, cannot be undone,
 *      so it comes after the page);
 *   3. the page's view config, against the page's CURRENT revision.
 * A failure throws {@link NewDatabaseError} carrying the progress; pass it back as
 * `resume` to continue (nothing is created twice). The CSV path adds its rows after this.
 */
export async function createBlankDatabase(client: VaultClient, plan: BlankDatabasePlan, resume?: NewDatabaseProgress): Promise<{ note: Pick<Note, "id" | "path">; progress: NewDatabaseProgress }> {
  if (!client.updateSchema) throw new Error("A new database needs the Prism Server.");
  const progress: NewDatabaseProgress = { ...(resume ?? {}) };
  // 1. The page.
  if (!progress.note) {
    if (plan.adopt) progress.note = plan.adopt;
    else {
      try {
        const path = `${plan.folder ? `${plan.folder.replace(/\/+$/, "")}/` : ""}${safeTitleLeaf(plan.title)}`;
        progress.note = await client.createNote({ content: "", path, metadata: { prism_type: "database", title: plan.title } });
        progress.createdPage = true;
      } catch (e) {
        throw new NewDatabaseError("page", progress, newDatabaseErrorDetail(e));
      }
    }
  }
  const note = progress.note;
  // 2. Properties, in batches the schema route accepts. The FIRST write carries
  //    `requireNew`; later batches extend the tag it just claimed.
  if (!progress.schemaDone) {
    try {
      const batches = newDatabaseSchemaBatches(plan);
      for (let i = progress.schemaBatches ?? 0; i < batches.length; i++) {
        await client.updateSchema(plan.tag, batches[i]!);
        // (A description-only claim is not a property batch: a refusal after it still has nothing to keep.)
        if (plan.properties.length) progress.schemaBatches = i + 1;
      }
      progress.schemaDone = true;
    } catch (e) {
      // Refused before anything of the tag exists: take back a page we made for it.
      let removed = false;
      if (progress.createdPage && !progress.schemaBatches && client.trashPage) {
        try { await client.trashPage(note.id); removed = true; progress.note = undefined; progress.createdPage = false; } catch { /* the page stays; the message says so */ }
      }
      throw new NewDatabaseError("schema", progress, newDatabaseErrorDetail(e), removed);
    }
  }
  // 3. The view config, against the page as it is NOW (it may have changed since the dialog opened).
  if (!progress.configDone) {
    try {
      const config: DatabaseConfig = { ...defaultConfig(plan.tag), views: [plan.view ?? { id: "table", name: "Table", type: "table", ...(plan.properties.length ? { visible: plan.properties.map((p) => p.key) } : {}) }] };
      const fresh = await client.getNote(note.id, { fresh: true });
      await client.updateNote(note.id, { metadata: { prism_database: config }, ifUpdatedAt: fresh.updatedAt ?? undefined });
      progress.configDone = true;
    } catch (e) {
      throw new NewDatabaseError("config", progress, newDatabaseErrorDetail(e));
    }
  }
  return { note, progress };
}

/** A tag name a new database may claim (the server's rule is the authority). */
export const NEW_TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,63}$/;

/** The tag a name proposes: lower-case words joined by "-" ("Reading list" → "reading-list"). */
export function tagFromName(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "database";
}

/** Is `tag` free to start a new database? The SERVER decides where it can (it also knows grants and publications). */
export async function newTagAvailability(client: VaultClient, tag: string): Promise<{ available: boolean; reason?: string; detail?: string }> {
  if (client.checkNewTag) {
    const a = await client.checkNewTag(tag);
    return { available: a.available, reason: a.reason, detail: a.detail };
  }
  const [schemas, tags] = await Promise.all([client.getSchemas ? client.getSchemas([tag]) : Promise.resolve({ schemas: {} }), client.getTags()]);
  const used = tags.find((x) => x.tag === tag)?.count ?? 0;
  if (used > 0 || Object.keys((schemas.schemas as Record<string, { fields?: object }>)[tag]?.fields ?? {}).length)
    return { available: false, reason: "tag_in_use", detail: `#${tag} is already used${used ? ` by ${used} ${used === 1 ? "page" : "pages"}` : ""}` };
  return { available: true };
}

/**
 * Mint an unused tag for a new database from `base`: `base`, then `base-2`, `base-3`…
 * (at most `tries`). Only a tag the server calls available is returned; a refusal that
 * is not about use (an integration's tag, a bad name) stops at once.
 */
export async function mintNewTag(client: VaultClient, base: string, tries = 6): Promise<{ tag: string } | { tag: null; detail: string }> {
  let last = "";
  for (let i = 1; i <= tries; i++) {
    const tag = i === 1 ? base : `${base.slice(0, 60)}-${i}`;
    if (!NEW_TAG_NAME.test(tag)) return { tag: null, detail: "Use a tag name: letters, numbers, - or _." };
    const a = await newTagAvailability(client, tag);
    if (a.available) return { tag };
    last = a.detail ?? `#${tag} is already in use`;
    if (a.reason && a.reason !== "tag_in_use" && a.reason !== "tag_governed") return { tag: null, detail: last };
  }
  return { tag: null, detail: last };
}

import { parsePublicationNavigation, eligiblePublicationNavigation } from "../../../packages/core/src/lib/publishing/navigation";
/** Versioned presentation only. Never snapshots document bodies, access grants,
 * password hashes, or publication membership. Every transition is one SQLite
 * transaction; revisions detect stale editors and legacy settings changes. */
import {
  db,
  getPublicationBySlug,
  updatePublication,
  type Publication,
} from "./db";

export interface Presentation {
  title: string | null;
  template: "wiki" | "docs" | "landing";
  theme: Record<string, unknown> | null;
}
interface Row {
  slug: string;
  live_revision: number;
  live_json: string;
  draft_revision: number;
  draft_json: string | null;
  draft_base_revision: number | null;
}
export class PresentationError extends Error {
  constructor(
    public code:
      | "presentation_conflict"
      | "draft_missing"
      | "revision_missing"
      | "bad_presentation",
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new PresentationError("bad_presentation", message);
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const color =
  /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{3,20}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\))$/i;
export function validatePresentation(value: unknown): Presentation {
  if (!object(value)) return fail("Presentation must be an object.");
  const { title, template, theme } = value;
  if (title !== null && (typeof title !== "string" || title.length > 200))
    return fail("Use a title of at most 200 characters.");
  if (template !== "wiki" && template !== "docs" && template !== "landing")
    return fail("Choose a supported layout.");
  let clean: Record<string, unknown> | null = null;
  if (theme !== null) {
    if (
      !object(theme) ||
      Buffer.byteLength(JSON.stringify(theme), "utf8") > 4096
    )
      return fail("Theme must be an object under 4 KB.");
    clean = {};
    for (const [key, v] of Object.entries(theme)) {
      if (key === "navigation") {
        const navigation = parsePublicationNavigation(v);
        if (!navigation) return fail("Navigation needs version 1, at most 8 named sections and 64 unique page IDs.");
        clean[key] = navigation;
      } else if (key === "logoUrl" || key === "coverUrl") {
        if (typeof v !== "string" || v.length > 2048)
          return fail("Use a valid HTTPS image URL.");
        if (!v.trim()) continue;
        let u: URL;
        try {
          u = new URL(v);
        } catch {
          return fail("Use a valid HTTPS image URL.");
        }
        if (u.protocol !== "https:" || u.username || u.password)
          return fail("Use an HTTPS image URL without credentials.");
        clean[key] = u.href;
      } else if (["accent", "bg", "text"].includes(key)) {
        if (typeof v !== "string" || !color.test(v.trim()))
          return fail("Use a valid color.");
        clean[key] = v.trim();
      } else if (key === "font") {
        if (typeof v !== "string" || !["sans", "serif", "mono"].includes(v))
          return fail("Choose a supported font.");
        clean[key] = v;
      } else if (key === "contentWidth") {
        if (v !== "reading" && v !== "wide")
          return fail("Choose a supported content width.");
        clean[key] = v;
      } else if (["showSearch", "showGraph", "showMap"].includes(key)) {
        if (typeof v !== "boolean")
          return fail("Visibility choices must be booleans.");
        clean[key] = v;
      } else if (key === "description") {
        if (typeof v !== "string" || v.length > 500)
          return fail("Use a description of at most 500 characters.");
        clean[key] = v.trim();
      } else return fail("Unknown theme setting: " + key);
    }
    if (!Object.keys(clean).length) clean = null;
  }
  return {
    title: typeof title === "string" ? title.trim() || null : null,
    template,
    theme: clean,
  };
}
function snapshot(pub: Publication): Presentation {
  let theme = null;
  try {
    const parsed = JSON.parse(pub.theme ?? "null");
    if (object(parsed)) theme = parsed;
  } catch {
    /* tolerate historical blobs */
  }
  return {
    title: pub.title,
    template: pub.template as Presentation["template"],
    theme,
  };
}
function record(
  slug: string,
  revision: number,
  json: string,
  actor: string | null,
) {
  db.prepare(
    "INSERT INTO publication_presentation_history (slug,revision,presentation_json,created_at,created_by) VALUES (?,?,?,?,?)",
  ).run(slug, revision, json, Date.now(), actor);
}
/** Reconcile older clients changing live settings. Their writes are retained,
 * and any outstanding draft becomes visibly stale instead of overwriting them. */
function state(slug: string): Row {
  const pub = getPublicationBySlug(slug);
  if (!pub)
    throw new PresentationError(
      "revision_missing",
      "Publication no longer exists.",
    );
  const json = JSON.stringify(snapshot(pub));
  let row = db
    .prepare("SELECT * FROM publication_presentations WHERE slug=?")
    .get(slug) as Row | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO publication_presentations (slug,live_revision,live_json) VALUES (?,0,?)",
    ).run(slug, json);
    record(slug, 0, json, null);
  } else if (row.live_json !== json) {
    db.prepare(
      "UPDATE publication_presentations SET live_revision=live_revision+1,live_json=? WHERE slug=?",
    ).run(json, slug);
    record(slug, row.live_revision + 1, json, null);
  }
  return db
    .prepare("SELECT * FROM publication_presentations WHERE slug=?")
    .get(slug) as Row;
}
function result(row: Row) {
  const history = db
    .prepare(
      "SELECT revision,created_at,created_by,presentation_json FROM publication_presentation_history WHERE slug=? ORDER BY revision DESC LIMIT 30",
    )
    .all(row.slug) as Array<{
    revision: number;
    created_at: number;
    created_by: string | null;
    presentation_json: string;
  }>;
  return {
    liveRevision: row.live_revision,
    draftRevision: row.draft_revision,
    draftBaseRevision: row.draft_base_revision,
    live: JSON.parse(row.live_json) as Presentation,
    draft: row.draft_json ? (JSON.parse(row.draft_json) as Presentation) : null,
    history: history.map((h) => ({
      revision: h.revision,
      createdAt: h.created_at,
      createdBy: h.created_by,
      presentation: JSON.parse(h.presentation_json) as Presentation,
    })),
  };
}
export const getPresentation = db.transaction((slug: string) =>
  result(state(slug)),
);
function expected(row: Row, draft: unknown, live: unknown) {
  if (!Number.isSafeInteger(draft) || !Number.isSafeInteger(live))
    return fail("Expected revisions are required.");
  if (row.draft_revision !== draft || row.live_revision !== live)
    throw new PresentationError(
      "presentation_conflict",
      "Site settings changed in another session. Reload the current revisions before saving.",
    );
}
export const savePresentationDraft = db.transaction(
  (
    slug: string,
    value: unknown,
    draftRevision: unknown,
    liveRevision: unknown,
  ) => {
    const presentation = validatePresentation(value);
    const row = state(slug);
    expected(row, draftRevision, liveRevision);
    db.prepare(
      "UPDATE publication_presentations SET draft_json=?,draft_revision=draft_revision+1,draft_base_revision=? WHERE slug=?",
    ).run(JSON.stringify(presentation), row.live_revision, slug);
    return result(state(slug));
  },
);
export const publishPresentationDraft = db.transaction(
  (
    slug: string,
    draftRevision: unknown,
    liveRevision: unknown,
    actor: string,
  ) => {
    const row = state(slug);
    expected(row, draftRevision, liveRevision);
    if (!row.draft_json)
      throw new PresentationError(
        "draft_missing",
        "Save a presentation draft first.",
      );
    if (row.draft_base_revision !== row.live_revision)
      throw new PresentationError(
        "presentation_conflict",
        "The live site changed after this draft. Review and save a new draft before publishing.",
      );
    const draft = validatePresentation(JSON.parse(row.draft_json));
    updatePublication(slug, {
      title: draft.title,
      template: draft.template,
      theme: draft.theme ? JSON.stringify(draft.theme) : null,
    });
    const json = JSON.stringify(snapshot(getPublicationBySlug(slug)!));
    db.prepare(
      "UPDATE publication_presentations SET live_json=?,live_revision=live_revision+1,draft_json=NULL,draft_revision=draft_revision+1,draft_base_revision=NULL WHERE slug=?",
    ).run(json, slug);
    record(slug, row.live_revision + 1, json, actor);
    return result(state(slug));
  },
);
export const restorePresentationDraft = db.transaction(
  (
    slug: string,
    revision: unknown,
    draftRevision: unknown,
    liveRevision: unknown,
  ) => {
    const row = state(slug);
    expected(row, draftRevision, liveRevision);
    if (!Number.isSafeInteger(revision)) return fail("Choose a revision.");
    const old = db
      .prepare(
        "SELECT presentation_json FROM publication_presentation_history WHERE slug=? AND revision=?",
      )
      .get(slug, revision as number) as
      | { presentation_json: string }
      | undefined;
    if (!old)
      throw new PresentationError(
        "revision_missing",
        "That revision is unavailable.",
      );
    return savePresentationDraft(
      slug,
      JSON.parse(old.presentation_json),
      draftRevision,
      liveRevision,
    );
  },
);

/** Public projection of theme preferences: never expose unavailable page IDs. */
export function readerPresentationTheme(value: unknown, noteIds: string[]) {
  if (!object(value)) return null;
  const {navigation, ...rest} = value;
  const eligible = eligiblePublicationNavigation(navigation, new Set(noteIds));
  return eligible ? {...rest, navigation: eligible} : rest;
}

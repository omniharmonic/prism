/**
 * Container-named pages. Some notes are stored under a file name that says nothing
 * about the page — `vault/projects/bioregional-food-chain/PROJECT`: the FOLDER is the
 * page's name and the file is only "the note of that folder". Showing the leaf gave
 * every project page the title "PROJECT".
 *
 * For such a note the title is, in order: `metadata.title`, `metadata.name`, the
 * parent folder's name made readable (`bioregional-food-chain` → "Bioregional food
 * chain"). Every surface that names a page (header, tab, tree, search, ⌘K, recents)
 * goes through `pageTitle` / `noteLinkTitle`, which ask here first.
 *
 * RENAME. The title of a container-named page is NOT its file name, so editing it
 * never moves the file or the folder (ingest, relations and wikilinks find the note
 * at `<folder>/PROJECT`): `renamePageFromTitle` writes `metadata.title` instead.
 *
 * Pure and dependency-free: imported by the server (tree, notifications) too.
 */

/**
 * Exact file names (extension removed) treated as containers. Case-sensitive on
 * purpose: a page somebody titled "Project" or "Index" keeps its own name.
 */
const CONTAINER_NAMES = new Set(["PROJECT", "README", "index"]);

const EXTENSION = /\.(md|markdown|txt|html?)$/i;

/** The folder a container-named note stands for, or null for every other path. */
export function containerFolder(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.replace(/^vault\//, "").split("/").filter(Boolean);
  // A top-level `README` has no folder to take a name from: it keeps its file name.
  if (parts.length < 2) return null;
  const leaf = parts[parts.length - 1]!.replace(EXTENSION, "");
  return CONTAINER_NAMES.has(leaf) ? parts[parts.length - 2]! : null;
}

export const isContainerPath = (path: string | null | undefined): boolean => containerFolder(path) !== null;

/**
 * A folder name as a title. Only a slug is rewritten (`food-chain_v2` → "Food chain
 * v2"); a name somebody typed with spaces or capitals ("Food Chain", "OpenCivics")
 * is already a title and is returned as it is.
 */
export function humanizeSlug(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed) || /[A-Z]/.test(trimmed)) return trimmed;
  const words = trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : trimmed;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The display title of a container-named note; null when `path` is an ordinary page. */
export function containerTitle(path: string | null | undefined, metadata?: Record<string, unknown> | null): string | null {
  const folder = containerFolder(path);
  if (folder === null) return null;
  return text(metadata?.title) || text(metadata?.name) || humanizeSlug(folder) || null;
}

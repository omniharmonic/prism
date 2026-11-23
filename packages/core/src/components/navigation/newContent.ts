import {
  CONTENT_DEFAULTS,
  type ContentType,
  type CreateNoteParams,
  type NoteTreeEntry,
} from "../../lib/types";
import { isVaultNoteId } from "../../lib/noteIdentity";

/** Infer from the active real note; preserve each vault's literal path convention. */
export function newContentFolder(
  entries: NoteTreeEntry[],
  activeNoteId?: string | null,
): string {
  if (!isVaultNoteId(activeNoteId)) return "";
  const path = entries.find((entry) => entry.id === activeNoteId)?.path ?? "";
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
export function newContentFolders(entries: NoteTreeEntry[]): string[] {
  const folders = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path?.split("/") ?? [];
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders]
    .filter((folder) => validFolder(folder))
    .sort((a, b) => a.localeCompare(b));
}
export function validFolder(folder: string): boolean {
  return (
    !folder ||
    (!/[\\\u0000-\u001f]/.test(folder) &&
      folder
        .split("/")
        .every((part) => !!part && part !== "." && part !== ".."))
  );
}
export function folderLabel(folder: string): string {
  return folder
    ? folder
        .replace(/^vault\//, "")
        .split("/")
        .join(" / ")
    : "Vault home";
}
/** Shared creation payload for navigation/command entry points; title is never a path. */
export function newContentParams(
  type: ContentType,
  title: string,
  folder: string,
  entries: NoteTreeEntry[],
): { title: string; params: CreateNoteParams } {
  const name =
    title.trim() || (type === "document" ? "Untitled" : `Untitled ${type}`);
  if (
    name.length > 200 ||
    /[/\\\u0000-\u001f]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw Error(
      "Use a page title without slashes, then choose its location below.",
    );
  if (!validFolder(folder))
    throw Error("Choose a valid location for this page.");
  const defaults = CONTENT_DEFAULTS[type];
  if (!defaults) throw Error("Choose a supported page format.");
  const paths = new Set(entries.map((entry) => entry.path));
  const prefix = folder ? `${folder}/` : "";
  let finalName = name;
  for (let i = 2; paths.has(prefix + finalName); i++)
    finalName = `${name} (${i})`;
  return {
    title: finalName,
    params: {
      content: defaults.content || " ",
      path: prefix + finalName,
      metadata: { ...defaults.metadata, title: finalName },
    },
  };
}

/** Presentation preferences only: IDs are resolved against current publication
 * membership, never used to fetch pages or override visibility. */
export interface PublicationNavigation {
  version: 1;
  sections: Array<{ title: string; noteIds: string[] }>;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Shared strict validator; malformed/unknown legacy versions fall back to the
 * path tree in readers. The write endpoint rejects them instead. */
export function parsePublicationNavigation(
  value: unknown,
  editing = false,
): PublicationNavigation | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).some((k) => !["version", "sections"].includes(k)) ||
    !Array.isArray(value.sections) ||
    value.sections.length > 8
  )
    return null;
  const seen = new Set<string>();
  const sections: PublicationNavigation["sections"] = [];
  for (const section of value.sections) {
    if (
      !object(section) ||
      Object.keys(section).some((k) => !["title", "noteIds"].includes(k)) ||
      typeof section.title !== "string" ||
      (!editing && !section.title.trim()) ||
      section.title.length > 80 ||
      !Array.isArray(section.noteIds)
    )
      return null;
    const noteIds: string[] = [];
    for (const id of section.noteIds) {
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        seen.has(id) ||
        seen.size >= 64
      )
        return null;
      seen.add(id);
      noteIds.push(id);
    }
    sections.push({
      title: editing ? section.title : section.title.trim(),
      noteIds,
    });
  }
  return { version: 1, sections };
}

/** Strip stale, excluded, private and out-of-set references before sending a
 * reader manifest. A locked site's empty membership produces no section labels. */
export function eligiblePublicationNavigation(
  value: unknown,
  eligible: ReadonlySet<string>,
): PublicationNavigation | null {
  const parsed = parsePublicationNavigation(value);
  if (!parsed) return null;
  return {
    version: 1,
    sections: parsed.sections
      .map((section) => ({
        ...section,
        noteIds: section.noteIds.filter((id) => eligible.has(id)),
      }))
      .filter((section) => section.noteIds.length > 0),
  };
}

/**
 * The field-shape CONTRACT (`vault-shapes.json`) as typed data, plus the one
 * renderer of the "Field shapes" prompt block.
 *
 * The JSON is the single source of truth for the vault's metadata shape rules.
 * Loaded by the server's write guard + lint (`apps/server/src/vault-shapes.ts`),
 * vendored byte-for-byte into the agent repo (`config/vault-shapes.json`, read by
 * `scripts/vault_shapes.py`), and rendered into the block every routine / agent
 * prompt carries (`docs/vault-field-shapes.md`). The agent repo has a Python twin
 * of `renderFieldShapesBody` (`scripts/gen_field_shapes.py`); both must produce the
 * committed block byte-for-byte, which is what keeps the two renderers in step.
 *
 * Pure data + pure functions: safe to import anywhere (server, web, scripts).
 */
import contractJson from "./vault-shapes.json";
import tagSchemasJson from "./tag-schemas.json";

export interface VaultShapesContract {
  version: number;
  note: string;
  listFields: Record<string, string[]>;
  undeclaredListFields: Record<string, string[] | string>;
  exemptArrayFields: Record<string, Record<string, string> | string>;
  exemptTags: Record<string, string>;
  confidence: { tags: string[]; labels: string[] };
  taskStatus: { values: string[]; mirrorOnly: string[]; synonyms: Record<string, string> };
  threadPlatforms: string[];
  source: { tags: string[]; known: string[] };
  textFields: Record<string, string[]>;
  integerFields: Record<string, string[]>;
  lowercaseStatusTags: string[];
  projectLink: { fields: string[]; folder: string; noteName: string };
  lintTags: string[];
  /** The lintTags whose RATE may make the lint `failing`; the others are sampled and reported only, until their baseline is known. */
  lintAlertTags: string[];
  prompt: { heading: string; intro: string; rules: string[] };
}

export const VAULT_SHAPES: VaultShapesContract = contractJson as unknown as VaultShapesContract;

/** One declared field of a tag schema, as tag-schemas.json ships it (type + allowed values). */
export interface DeclaredField {
  type: string;
  enum?: readonly string[];
}

/** tag → field → declaration, straight from tag-schemas.json (the seeded schema; S12/S13 optional fields are not in it). */
export const DECLARED_FIELDS: Readonly<Record<string, Readonly<Record<string, DeclaredField>>>> = Object.fromEntries(
  Object.entries((tagSchemasJson as unknown as { tags: Record<string, { fields?: Record<string, DeclaredField> }> }).tags).map(([tag, def]) => [
    tag,
    Object.fromEntries(Object.entries(def.fields ?? {}).map(([name, f]) => [name, { type: f.type, ...(Array.isArray(f.enum) ? { enum: f.enum } : {}) }])),
  ]),
);

/** True for a tag the contract leaves alone (`exemptTags`; a trailing `*` is a prefix). */
export function isExemptTag(tag: string, c: VaultShapesContract = VAULT_SHAPES): boolean {
  return Object.keys(c.exemptTags).some((k) => k !== "_note" && (k.endsWith("*") ? tag.startsWith(k.slice(0, -1)) : k === tag));
}

export const FIELD_SHAPES_BEGIN = "<!-- field-shapes:begin";
export const FIELD_SHAPES_END = "<!-- field-shapes:end -->";

const code = (s: string): string => `\`${s}\``;

/** `a`, `b` or `c` (the last separator is a word; one item is just itself). */
function codeList(items: readonly string[], last: string): string {
  const c = items.map(code);
  if (c.length <= 1) return c.join("");
  return `${c.slice(0, -1).join(", ")} ${last} ${c[c.length - 1]}`;
}

/** The placeholder values the contract's prompt rules use (the Python twin builds the same strings). */
export function fieldShapesPlaceholders(c: VaultShapesContract = VAULT_SHAPES): Record<string, string> {
  const mirror = new Set(c.taskStatus.mirrorOnly);
  return {
    listFieldsByTag: Object.entries(c.listFields)
      .map(([tag, fields]) => `${tag}: ${fields.map(code).join(", ")}`)
      .join("; "),
    projectFolder: c.projectLink.folder,
    projectNote: c.projectLink.noteName,
    confidenceTags: c.confidence.tags.join(" / "),
    confidenceLabels: codeList(c.confidence.labels, "or"),
    agentTaskStatuses: c.taskStatus.values.filter((s) => !mirror.has(s)).map(code).join(", "),
    mirrorTaskStatuses: c.taskStatus.mirrorOnly.map(code).join("/"),
    sourceTags: c.source.tags.join(" / "),
    sources: codeList(c.source.known, "or"),
  };
}

/** The block's text: heading, intro, one bullet per rule. No markers, no trailing newline. */
export function renderFieldShapesBody(c: VaultShapesContract = VAULT_SHAPES): string {
  const values = fieldShapesPlaceholders(c);
  const fill = (s: string): string =>
    s.replace(/\{([A-Za-z]+)\}/g, (whole, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole));
  return [c.prompt.heading, "", fill(c.prompt.intro), "", ...c.prompt.rules.map((r) => `- ${fill(r)}`)].join("\n");
}

/**
 * The block as it is pasted into a prompt file: begin marker (contract version +
 * the first 12 hex of the contract file's SHA-256), body, end marker.
 */
export function renderFieldShapesBlock(contractSha256: string, c: VaultShapesContract = VAULT_SHAPES): string {
  const begin = `${FIELD_SHAPES_BEGIN} contract=v${c.version} sha256=${contractSha256.slice(0, 12)} · GENERATED from vault-shapes.json — do not edit by hand -->`;
  return `${begin}\n${renderFieldShapesBody(c)}\n${FIELD_SHAPES_END}`;
}

/**
 * The same rules as ONE compact paragraph, for agent system preambles that are sent
 * on every turn (the full block is ~2 KB; this is ~1 KB). Built from the contract, so
 * it cannot fall behind it.
 */
export function renderFieldShapesRule(c: VaultShapesContract = VAULT_SHAPES): string {
  const v = fieldShapesPlaceholders(c);
  const lists = Object.entries(c.listFields)
    .map(([tag, fields]) => `${tag}: ${fields.join(", ")}`)
    .join("; ");
  return [
    "Writing metadata (the vault's field shapes — bind hard): list fields are JSON lists, and an empty list or empty value is LEFT OUT, never \"\"",
    `(list fields — ${lists}).`,
    `Project links are [[${v.projectFolder}/<slug>/${v.projectNote}]] (the project NOTE; the folder [[${v.projectFolder}/<slug>]] resolves to nothing), and people links point at a person note that exists.`,
    `confidence on ${v.confidenceTags} is one of ${c.confidence.labels.join(" | ")} (never a number).`,
    `Task status is one of ${c.taskStatus.values.join(" | ")}, in metadata, never as a tag.`,
    `${v.sourceTags} source is one lower-case word (${c.source.known.join(", ")}); recording_id and a spec's version are text; never write lastMessageAt.`,
  ].join(" ");
}

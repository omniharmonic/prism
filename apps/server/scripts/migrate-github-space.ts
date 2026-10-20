/**
 * L-P2P-Migrate — one-time importer: GitHub directory-sync binding → federation "space".
 *
 * Takes an existing GitHub directory-sync binding (the desktop's whole-file,
 * local/remote-wins channel) and projects it into a federation `space` + a
 * `federated_notes` identity map, so the note set can also be collaborated on
 * over CRDT federation.
 *
 * NO FLAG-DAY / NO DATA LOSS: this does NOT touch or remove the GitHub binding.
 * The two channels co-exist during the transition — the desktop keeps pushing
 * markdown to GitHub while federation (when enabled) gives the same notes live
 * CRDT merge, which replaces the binding's coarse whole-file local/remote-wins
 * strategy. You can retire the GitHub binding later, by hand, once you trust
 * federation. This script only ADDS the federation mapping.
 *
 * ── Run ───────────────────────────────────────────────────────────────────
 *   cd apps/server
 *   # dry-run from a synthetic / extracted id-map file:
 *   node --env-file=.env --import tsx scripts/migrate-github-space.ts --id-map ./binding.json --dry-run
 *   # for real:
 *   node --env-file=.env --import tsx scripts/migrate-github-space.ts --id-map ./binding.json
 *   # or extract the binding straight out of the desktop's github-sync-configs.json:
 *   node --env-file=.env --import tsx scripts/migrate-github-space.ts \
 *     --config "$HOME/Library/Application Support/prism/github-sync-configs.json" --dry-run
 *
 * ── Input shapes ───────────────────────────────────────────────────────────
 * --id-map <path>   A JSON file describing ONE binding:
 *     {
 *       "vault_path": "vault/research/thiel-karp-genealogy",   // required: space path_prefix
 *       "id_map": {                                            // required: noteId -> repoPath
 *         "<vaultNoteId>": "people/peter-thiel.md",
 *         "<vaultNoteId>": "concepts/mimesis.md"
 *       },
 *       "title": "Thiel–Karp genealogy",   // optional: space title (defaults to vault_path)
 *       "remote_url": "https://github.com/owner/repo",  // optional, recorded only in the summary
 *       "conflict_strategy": "local-wins"               // optional, informational
 *     }
 *
 * --config <path>   The desktop's GitHub sync persistence file
 *     (`~/Library/Application Support/prism/github-sync-configs.json`), which is a
 *     `{ "<bindingId>": DirectorySyncConfig }` map. We extract the binding's
 *     `vault_path` + `id_map` (+ remote_url/conflict_strategy). If the file holds
 *     more than one binding, pass `--binding-id <id>` to pick one. (NOTE: the
 *     bindings live in github-sync-configs.json, NOT prism-config.json — the Rust
 *     side keeps them in a dedicated file.) A single bare DirectorySyncConfig
 *     object is also accepted.
 *
 * ── Other flags ────────────────────────────────────────────────────────────
 * --dry-run         Report the plan (space to create/reuse, N notes to map,
 *                   unresolvable ids) and write NOTHING.
 * --title <t>       Override the space title.
 * --binding-id <id> Select a binding from a multi-binding --config file.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * Re-running is safe and never duplicates rows:
 *   - The space is matched by `path_prefix` (== vault_path). An existing space is
 *     REUSED; a new one is only created on first run.
 *   - A note already present in `federated_notes` for THIS space is reused (its
 *     durable `space_note_key` is kept — the cross-hub "key is durable" rule).
 *     Only previously-unmapped notes get a fresh randomUUID key.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { vault, VaultError } from "../src/parachute";
import { noteKind } from "../src/collab";
import {
  createSpace,
  getSpace,
  listSpaces,
  federatedNotesForSpace,
  upsertFederatedNote,
  type Space,
} from "../src/db";

// ── argv ────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    "id-map": { type: "string" },
    config: { type: "string" },
    "binding-id": { type: "string" },
    title: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const DRY = values["dry-run"] === true;

interface Binding {
  vault_path: string;
  id_map: Record<string, string>;
  title?: string;
  remote_url?: string;
  conflict_strategy?: string;
}

function die(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function readJson(path: string): Promise<unknown> {
  const fs = await import("node:fs/promises");
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (e) {
    die(`could not read/parse JSON at ${path}: ${(e as Error).message}`);
  }
}

function isBindingLike(o: unknown): o is Binding {
  return (
    !!o &&
    typeof o === "object" &&
    typeof (o as Binding).vault_path === "string" &&
    !!(o as Binding).id_map &&
    typeof (o as Binding).id_map === "object"
  );
}

/** Resolve the chosen binding from --id-map or --config. */
async function loadBinding(): Promise<Binding> {
  const idMapPath = values["id-map"];
  const configPath = values.config;

  if (!idMapPath && !configPath) {
    die("provide --id-map <path> or --config <path> (see header for shapes)");
  }
  if (idMapPath && configPath) {
    die("pass only one of --id-map or --config");
  }

  if (idMapPath) {
    const raw = await readJson(idMapPath);
    if (!isBindingLike(raw)) {
      die(`--id-map file must be { vault_path: string, id_map: {noteId: repoPath} }`);
    }
    return raw;
  }

  // --config: github-sync-configs.json (map of id -> DirectorySyncConfig), or a
  // single DirectorySyncConfig object.
  const raw = await readJson(configPath!);
  if (isBindingLike(raw)) return raw; // single bare config object

  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>).filter(([, v]) => isBindingLike(v));
    if (entries.length === 0) {
      die(`--config file holds no GitHub bindings (expected a map of id -> {vault_path, id_map})`);
    }
    const wantId = values["binding-id"];
    if (wantId) {
      const hit = entries.find(([id]) => id === wantId);
      if (!hit) die(`--binding-id "${wantId}" not found. Available: ${entries.map(([id]) => id).join(", ")}`);
      return hit[1] as Binding;
    }
    if (entries.length > 1) {
      die(
        `--config holds ${entries.length} bindings; pick one with --binding-id <id>. ` +
          `Available: ${entries.map(([id]) => id).join(", ")}`,
      );
    }
    return entries[0]![1] as Binding;
  }
  die(`--config file is not a recognizable binding or binding map`);
}

/** ISO timestamp → epoch ms (or null). */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

async function main() {
  const binding = await loadBinding();
  const vaultPath = binding.vault_path;
  const title = values.title ?? binding.title ?? vaultPath;
  const idMap = binding.id_map;
  const noteIds = Object.keys(idMap);

  console.log(`\n=== migrate-github-space ${DRY ? "(DRY RUN — no writes)" : ""} ===`);
  console.log(`binding vault_path : ${vaultPath}`);
  if (binding.remote_url) console.log(`binding remote_url : ${binding.remote_url}`);
  if (binding.conflict_strategy) console.log(`binding conflict   : ${binding.conflict_strategy} (whole-file → replaced by CRDT merge)`);
  console.log(`id_map entries     : ${noteIds.length}`);

  // ── 1. resolve / plan the space (matched by path_prefix; reuse if it exists) ──
  const existingSpace: Space | null =
    listSpaces().find((s) => s.path_prefix === vaultPath) ?? null;

  let space: Space;
  if (existingSpace) {
    console.log(`\nspace: REUSE existing ${existingSpace.id} (path_prefix matches)`);
    space = existingSpace;
  } else if (DRY) {
    console.log(`\nspace: would CREATE new (title="${title}", path_prefix="${vaultPath}")`);
    // Synthesize a placeholder so the plan can describe per-note actions; not persisted.
    space = {
      id: "(new — not yet created)",
      title,
      scope_include_tags: null,
      scope_exclude_tags: null,
      path_prefix: vaultPath,
      created_by: null,
      created_at: 0,
    };
  } else {
    space = createSpace({
      id: randomUUID(),
      title,
      scope_include_tags: null,
      scope_exclude_tags: null,
      path_prefix: vaultPath,
      created_by: "migrate-github-space",
    });
    console.log(`\nspace: CREATED ${space.id} (title="${title}", path_prefix="${vaultPath}")`);
  }

  // Notes already federated INTO this space (idempotency: durable key reuse).
  const already = new Map<string, string>(); // local_id -> space_note_key
  if (existingSpace) {
    for (const f of federatedNotesForSpace(existingSpace.id)) already.set(f.local_id, f.space_note_key);
  }

  // ── 2. per-note: resolve, pin kind, mint/reuse key ──
  let mapped = 0;
  let reused = 0;
  const unresolvable: string[] = [];
  const plan: Array<{ noteId: string; repo: string; kind: string; key: string; action: string }> = [];

  for (const noteId of noteIds) {
    const repo = idMap[noteId]!;

    const existingKey = already.get(noteId);
    if (existingKey) {
      reused++;
      plan.push({ noteId, repo, kind: "—", key: existingKey, action: "reuse (already federated)" });
      continue;
    }

    let note;
    try {
      note = await vault.getNote(noteId);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) {
        unresolvable.push(noteId);
        plan.push({ noteId, repo, kind: "—", key: "—", action: "SKIP (note not found in vault)" });
        continue;
      }
      throw e;
    }

    const kind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
    const key = randomUUID();

    if (!DRY) {
      upsertFederatedNote({
        space_note_key: key,
        space_id: space.id,
        local_id: noteId,
        kind,
        peer_synced_at: null,
        source_updated_at: toMs(note.updatedAt) ?? toMs(note.createdAt),
      });
    }
    mapped++;
    plan.push({ noteId, repo, kind, key, action: DRY ? "would map" : "mapped" });
  }

  // ── 3. summary ──
  console.log(`\n--- plan ---`);
  for (const p of plan) {
    console.log(`  ${p.action.padEnd(28)} ${p.noteId}  →  ${p.repo}  [kind=${p.kind}]${p.key !== "—" ? `  key=${p.key}` : ""}`);
  }

  console.log(`\n=== summary ===`);
  console.log(`space id        : ${space.id}`);
  console.log(`mapped (new)    : ${mapped}`);
  console.log(`reused existing : ${reused}`);
  console.log(`skipped/missing : ${unresolvable.length}${unresolvable.length ? ` (${unresolvable.join(", ")})` : ""}`);
  if (DRY) {
    console.log(`\nDRY RUN — nothing was written. Re-run without --dry-run to apply.`);
  } else {
    console.log(`\nDone. The GitHub binding was NOT modified — both channels co-exist (no flag-day).`);
    console.log(`Federation (when enabled) now gives these notes CRDT merge instead of whole-file local/remote-wins.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

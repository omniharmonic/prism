// Production wiring for the projection builder: primary vault, the owner's Matrix client, PeopleIndex.
import { getSecret } from "../secrets";
import { personName } from "../person-name";
import { config } from "../config";
import { resolveVaultEntry } from "../db";
import { vaultClient, type Note } from "../parachute";
import { MatrixClient, agentSenderIds, type MatrixCreds } from "../worker/matrix.js";
import { PeopleIndex } from "../worker/people.js";
import { rebuildProjection, type ProjectDeps } from "./project.js";
import { startCommsLive } from "./live.js";
import { startCommsStatusSync } from "./status-sync.js";
import { startCommsNotify } from "./notify.js";
import { startCommsSearchIndexer } from "./search-vault.js";
import { purgeSearchIndexIfDisabled } from "./search-index.js";
import { foldSearch } from "./search-text.js";
import { markAllWindowsStale } from "./timeline.js";
import { PERSON_IDENTITY_KEYS } from "../people-metadata";
import { ownerProfile } from "../identity";
import { ownerConfigFor, ownerSettings } from "../people-owner";
import { startEmailProjection, type EmailProjectDeps } from "./email.js";

const EMAIL_KEYS = ["subject", "from", "to", "cc", "replyTo", "labels", "threadId", "messageId", "account", "lastMessageAt", "date", "isUnread", "html"];

/** Live deps for the email projection (primary vault; people by VERIFIED email key only). */
export async function buildEmailDeps(): Promise<EmailProjectDeps | null> {
  const entry = resolveVaultEntry(undefined);
  const vault = vaultClient(entry.id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  const people = new PeopleIndex(await vault.listNotes({ tags: ["person"], includeContent: false, includeMetadata: [...PERSON_IDENTITY_KEYS, "title", "photo", "avatar"] }));
  const owner = ownerProfile(people.identity, ownerConfigFor(entry.id));
  return {
    listEmailNotes: () => vault.listNotes({ tags: ["email"], includeContent: false, includeMetadata: EMAIL_KEYS }),
    getNote: (id) => vault.getNote(id).catch(() => null),
    personByEmail(addr) {
      const note = people.find({ email: addr });
      if (!note || (owner.person && note.id === owner.person.id)) return null;
      const m = (note.metadata ?? {}) as Record<string, unknown>;
      const photo = [m.photo, m.avatar].find((v): v is string => typeof v === "string" && v.startsWith("mxc://"));
      return { id: note.id, name: personName(note), ...(photo ? { photo } : {}) };
    },
    selfAddresses: [config.ownerEmail.toLowerCase()],
  };
}


/** Thin adapter over PeopleIndex strong-key lookup (matrix ids are lowercased by the index). */
export function peopleAdapter(index: PeopleIndex): ProjectDeps["people"] {
  return {
    byMatrixId(mxid) {
      const note = index.find({ matrixId: mxid });
      if (!note) return null;
      const m = (note.metadata ?? {}) as Record<string, unknown>;
      const photo = [m.photo, m.avatar].find((v): v is string => typeof v === "string" && v.startsWith("mxc://"));
      return { id: note.id, name: personName(note), ...(photo ? { photo } : {}) };
    },
  };
}

/** Build live deps for the primary vault, or null when Matrix is not configured. */
export async function buildProjectDeps(): Promise<ProjectDeps | null> {
  const entry = resolveVaultEntry(undefined);
  const raw = getSecret(entry.id, config.ownerEmail, "matrix");
  if (!raw) return null;
  const vault = vaultClient(entry.id, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? config.matrixVaultTimeoutMs : 30_000 });
  // Lean: no bodies, only the keys PeopleIndex + peopleAdapter read (rebuilt every 10 min by the live listener).
  const people = new PeopleIndex(await vault.listNotes({ tags: ["person"], includeContent: false, includeMetadata: [...PERSON_IDENTITY_KEYS, "title", "photo", "avatar"] }));
  // The owner's own ids, by the same rule as the vault ingest's ownerSenderIds (scheduler.ts):
  // ownerProfile over the people index. His bridge ghosts are detected by the rebuild.
  const owner = ownerProfile(people.identity, ownerConfigFor(entry.id));
  const ownerPersonId = owner.person?.id ?? null;
  return {
    vault: { listByTag: (tag) => vault.listNotes({ tags: [tag], includeContent: false }) },
    reader: new MatrixClient(JSON.parse(raw) as MatrixCreds, fetch, config.matrixReadTimeoutMs > 0 ? config.matrixReadTimeoutMs : 10_000),
    people: peopleAdapter(people),
    extraSelfIds: agentSenderIds(),
    ownerIds: [...owner.matrixIds],
    isOwner: (mxid) => !!ownerPersonId && people.find({ matrixId: mxid })?.id === ownerPersonId,
    // A veto source for ghost detection only (owner-detect.ts): his person note's name + aliases.
    ownerNames: [...(owner.person ? [personName(owner.person)] : []), ...ownerSettings(entry.id).aliases].filter(Boolean),
  };
}

type RebuildResult = Awaited<ReturnType<typeof rebuildProjection>> | null;
let inflight: Promise<RebuildResult> | null = null;
const liveRun = async (): Promise<RebuildResult> => {
  const deps = await buildProjectDeps();
  return deps ? rebuildProjection(deps) : null;
};
const logResult = (r: RebuildResult) =>
  console.log(r
    ? `[comms] projection rebuilt: ${r.conversations} conversations, ${r.failed.length} failed${r.failed.length ? ` (${Object.entries(r.failures ?? {}).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}, ${r.left ?? 0} left rooms excluded, ${r.ownerGhosts ?? 0} owner bridge ghosts (${r.ownerDetection ?? "auto"}${r.degraded ? ", degraded" : ""})`
    : "[comms] projection skipped: Matrix not configured");

/** Single-flight background rebuild. Never rejects; logs the outcome. */
export function startRebuild(run: () => Promise<RebuildResult> = liveRun): { started: boolean; running?: true } {
  if (inflight) return { started: false, running: true };
  inflight = run()
    .then((r) => { logResult(r); return r; })
    .catch((e) => { console.warn(`[comms] projection rebuild failed: ${String(e).slice(0, 200)}`); return null; })
    .finally(() => { inflight = null; });
  return { started: true };
}

/** Startup hook: background, never blocks or throws. */
export function startCommsProjection(): void {
  purgeSearchIndexIfDisabled(); // search off → no indexed message text at rest
  if (!config.commsEnabled) return;
  // Whatever happened while the server was down (or COMMS was off) produced no comms event:
  // no cached window may be served as current until it is refetched (final review M1).
  markAllWindowsStale();
  startCommsNotify(); // Sprint Task 1: new messages → APNs (pushes only with COMMS_NOTIFY_ENABLED)
  startRebuild();
  startCommsStatusSync(); // tag changes (classifier / status control / ingest strip) → status
  startCommsLive(); // Task 11: the ingest bus → comms_events + warm window cache + SSE
  startEmailProjection(buildEmailDeps); // COMMS_EMAIL_ENABLED: the vault's email notes (comms/email.ts)
  // Full search (COMMS_SEARCH_ENABLED): vault transcripts → the FTS index, in resumable batches.
  // A transcript line is the owner's when its sender is one of his configured names.
  const vaultId = resolveVaultEntry(undefined).id;
  startCommsSearchIndexer(undefined, () => new Set(ownerSettings(vaultId).aliases.map(foldSearch).filter(Boolean)));
}

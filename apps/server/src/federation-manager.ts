/**
 * FederationManager — the Parachute-to-Parachute sync bridge. GATED: it does
 * nothing unless config.federationEnabled, and this whole module is imported
 * LAZILY from attachCollab so the @hocuspocus/provider client never loads on the
 * default, non-federation deployment.
 *
 * ── The one-doc model (no double-persist, no loops) ──────────────────────────
 * For each federated note this hub holds a single Y.Doc, served by our own
 * Hocuspocus under the documentName == `space_note_key` (the content-independent
 * id both hubs share). We obtain THAT exact doc via
 * `hocuspocus.openDirectConnection(space_note_key)` and bind a HocuspocusProvider
 * (a CLIENT) to it pointing at the PEER hub's /collab, also named
 * `space_note_key`. Because the provider binds the SAME doc our Hocuspocus
 * serves:
 *   - local edits (our browser clients, our vault reconciler) flow OUT to the peer;
 *   - peer edits land IN our doc → our Hocuspocus onStoreDocument persists them to
 *     MY vault (via federationTarget → local_id). One doc, one persistence path.
 * There is no separate "fed doc", so nothing double-writes the vault note.
 *
 * Loop-safety: Yjs updates are idempotent and the Hocuspocus sync protocol
 * exchanges state vectors, so re-applying or replaying an update converges and
 * never echoes. The provider does not bounce a remote update back to its origin.
 *
 * Kind-pinning: a binding refuses to come up if the local note's actual
 * `noteKind` disagrees with the kind recorded in `federated_notes` at join —
 * better to skip than to seed/persist the wrong structure and corrupt the note.
 *
 * ── What still needs a SECOND live hub+vault to exercise (honest gaps) ───────
 *  1. PEER-URL REGISTRY. The `peers` table has no URL column, so syncSpaces()
 *     takes the peer→collab-WS-URL mapping from the CALLER for now. A small
 *     follow-up adds a `peers.collab_url` (or a separate registry) so the manager
 *     can self-discover endpoints. Until then start() with no endpoints binds
 *     nothing live; call syncSpaces([{ pubkey, url }]) to drive it.
 *  2. CLIENT OPENS FEDERATED NOTES BY space_note_key. For the one-doc model to
 *     hold, this hub's OWN browser clients must open a federated note under its
 *     `space_note_key` (so they share the very doc this bridge binds), not under
 *     the bare local id. The desktop in-app swap (Canvas.tsx COLLAB_TYPES) and
 *     web CollabDoc need to route a federated note to its space_note_key. Until
 *     that lands, local editing still works via local_id but is NOT live-bridged.
 *  3. TWO-HUB CONVERGENCE. Real bidirectional convergence (A⇄B), reconnect/outbox
 *     replay, and conflict behavior can only be validated against a second running
 *     hub. verify-federation.ts covers the in-process invariants (tokens, auth,
 *     kind-pinning, space grants, outbox); live convergence is the next milestone.
 */
import * as Y from "yjs";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import WebSocket from "ws";
import { config } from "./config";
import { hocuspocus, noteKind, PEER_ORIGIN, type CollabKind } from "./collab";
import { signPeerConnToken } from "./auth/peer-conn";
import { vault } from "./parachute";
import { atLeast, type Level } from "./permissions";
import {
  listSpaces,
  federatedNotesForSpace,
  grantsForResource,
  getPeer,
  queueOutbox,
  outboxForPeer,
  clearOutboxItem,
  type FederatedNote,
} from "./db";

/** A peer's collaboration endpoint. Supplied by the caller until a peer-URL
 *  registry exists (see gap #1). `url` is the peer hub's /collab WS URL. */
export interface PeerEndpoint {
  pubkey: string;
  url: string;
}

const bindKey = (spaceNoteKey: string, pubkey: string): string => `${spaceNoteKey}::${pubkey}`;

/**
 * One outbound binding: this hub's doc for a federated note ⇄ one peer hub.
 */
class PeerBinding {
  private direct: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | null = null;
  private provider: HocuspocusProvider | null = null;
  private doc: Y.Doc | null = null;
  private connected = false;
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private stopped = false;

  constructor(
    private readonly fed: FederatedNote,
    private readonly peerPubkey: string,
    private readonly peerUrl: string,
    readonly level: Level,
  ) {}

  async start(): Promise<void> {
    // Kind-pinning guard: never bind a note whose live structure disagrees with
    // the kind recorded at join — that mismatch is exactly how a note gets
    // corrupted (e.g. a canvas re-seeded as a document). Log + skip instead.
    try {
      const note = await vault.getNote(this.fed.local_id);
      const actual: CollabKind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
      if (actual !== this.fed.kind) {
        console.warn(
          `[federation] kind mismatch for ${this.fed.local_id} (space_note_key=${this.fed.space_note_key}): ` +
            `pinned=${this.fed.kind} actual=${actual} — skipping bind to avoid corruption`,
        );
        return;
      }
    } catch (e) {
      console.warn(`[federation] cannot read local note ${this.fed.local_id} — skipping bind:`, e);
      return;
    }

    // The SAME doc our Hocuspocus serves under space_note_key (federationTarget
    // maps it to local_id for vault I/O). Holding a direct connection also keeps
    // the doc loaded so onStoreDocument fires when peer edits arrive.
    this.direct = await hocuspocus.openDirectConnection(this.fed.space_note_key);
    this.doc = this.direct.document;
    if (!this.doc || this.stopped) {
      await this.stop();
      return;
    }

    // Durable offline buffer: while the peer WS is down, record local updates so
    // a multi-restart-while-offline window still converges on reconnect. (When
    // connected, the provider's live state-vector sync already carries edits, so
    // we don't queue.) Skip our own flush re-applies (PEER_ORIGIN).
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (this.connected || origin === PEER_ORIGIN) return;
      queueOutbox(this.fed.space_note_key, this.peerPubkey, update);
    };
    this.doc.on("update", this.updateHandler);

    this.provider = new HocuspocusProvider({
      url: this.peerUrl,
      name: this.fed.space_note_key,
      document: this.doc,
      // Re-minted per (re)connect so an expired token never sticks.
      token: () => signPeerConnToken(this.fed.space_id),
      // Node has no global WebSocket; accepted at runtime by the provider (it is
      // forwarded to the underlying websocket config, which isn't in this type).
      // @ts-expect-error WebSocketPolyfill is accepted at runtime
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        this.connected = true;
        this.flush();
      },
      onStatus: ({ status }) => {
        this.connected = status === WebSocketStatus.Connected;
        if (this.connected) this.flush();
      },
      onDisconnect: () => {
        this.connected = false;
      },
    });
  }

  /** Replay any buffered updates for THIS note→peer, then drain them. Yjs is
   *  idempotent, so replay onto our own doc is a safe no-op merge; the live
   *  provider then carries the state to the peer. */
  private flush(): void {
    if (!this.doc) return;
    for (const item of outboxForPeer(this.peerPubkey)) {
      if (item.space_note_key !== this.fed.space_note_key) continue;
      try {
        Y.applyUpdate(this.doc, item.update_blob, PEER_ORIGIN);
      } catch (e) {
        console.warn(`[federation] failed to replay outbox item ${item.id}:`, e);
      }
      clearOutboxItem(item.id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.updateHandler && this.doc) this.doc.off("update", this.updateHandler);
    this.updateHandler = null;
    this.provider?.destroy();
    this.provider = null;
    try {
      await this.direct?.disconnect();
    } catch {
      /* best-effort */
    }
    this.direct = null;
    this.doc = null;
  }
}

export class FederationManager {
  private bindings = new Map<string, PeerBinding>();
  private started = false;

  /** Bring the manager up. A no-op unless federation is enabled. Binding is
   *  driven by syncSpaces(endpoints) — start() alone binds nothing live until a
   *  peer-URL registry exists (gap #1). */
  start(): void {
    if (!config.federationEnabled) return;
    this.started = true;
  }

  /** Tear down every binding. */
  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.bindings.values()].map((b) => b.stop()));
    this.bindings.clear();
  }

  /**
   * Idempotently reconcile bindings to the current desired set: one per
   * (federated note × paired peer that has a ≥view space grant AND a known URL).
   * Re-callable any time spaces/peers/grants change. `endpoints` supplies peer
   * collab URLs until a registry lands (gap #1); peers without a URL are skipped.
   */
  async syncSpaces(endpoints: PeerEndpoint[] = []): Promise<void> {
    if (!config.federationEnabled) return;
    if (!this.started) this.started = true;
    const urlByPubkey = new Map(endpoints.map((e) => [e.pubkey, e.url]));
    const wanted = new Set<string>();

    for (const space of listSpaces()) {
      const peerGrants = grantsForResource("space", space.id).filter(
        (g) => g.subject_type === "peer" && atLeast(g.level as Level, "view"),
      );
      if (peerGrants.length === 0) continue;
      const feds = federatedNotesForSpace(space.id);
      for (const fed of feds) {
        for (const g of peerGrants) {
          const peer = getPeer(g.subject);
          if (!peer || !peer.paired_at) continue;
          const url = urlByPubkey.get(g.subject);
          if (!url) continue; // no URL known for this peer yet (caller must supply)
          const key = bindKey(fed.space_note_key, g.subject);
          wanted.add(key);
          if (!this.bindings.has(key)) {
            const binding = new PeerBinding(fed, g.subject, url, g.level as Level);
            this.bindings.set(key, binding);
            await binding.start();
          }
        }
      }
    }

    // Drop bindings whose note/peer/grant disappeared.
    for (const [key, binding] of this.bindings) {
      if (!wanted.has(key)) {
        await binding.stop();
        this.bindings.delete(key);
      }
    }
  }

  /** Test/introspection: current bound (space_note_key::pubkey) keys. */
  activeBindings(): string[] {
    return [...this.bindings.keys()];
  }
}

/** Process-wide singleton (mirrors the `hocuspocus` singleton in collab.ts). */
export const federationManager = new FederationManager();

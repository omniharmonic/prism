import { routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import { YServer } from "y-partyserver";

interface Env {
  Document: DurableObjectNamespace;
}

/**
 * One Durable Object per note (room = note id). y-partyserver keeps the
 * authoritative Y.Doc and relays CRDT updates + awareness to all connected
 * peers, persisting the doc in DO storage. Parachute remains the source of
 * truth — the owner's browser persists the editor content back to the vault.
 *
 * NB: y-partyserver and partyserver are co-released and the onMessage payload
 * shape is version-coupled — keep their versions pinned together (see
 * package.json), or relay silently breaks ("Unexpected end of array").
 */
export class Document extends YServer<Env> {
  // Cloudflare delivers binary WebSocket frames to the server as `Blob`
  // (binaryType defaults to "blob"). y-partyserver's message handler only
  // understands ArrayBuffer/Uint8Array, so a Blob decodes to an empty buffer
  // ("Unexpected end of array") and no Yjs update ever relays between clients.
  // Convert Blob → ArrayBuffer before delegating. Per-connection ordering is
  // preserved (awaits resolve FIFO).
  async onMessage(connection: Connection, message: WSMessage | Blob) {
    const msg: WSMessage = message instanceof Blob ? await message.arrayBuffer() : message;
    return super.onMessage(connection, msg);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as never)) ||
      new Response("Prism collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;

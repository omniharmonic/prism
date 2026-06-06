import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";

interface Env {
  Document: DurableObjectNamespace;
}

/**
 * One Durable Object per note (room = note id). y-partyserver keeps the
 * authoritative Y.Doc, relays CRDT updates + awareness to all connected peers,
 * and persists the doc in DO storage while clients are connected — so collab
 * survives reconnects and doesn't depend on peers being simultaneously online
 * (unlike the y-webrtc fallback). Parachute remains the source of truth: the
 * owner's browser persists the editor content back to the vault.
 *
 * Access model (MVP): open — knowing the note id (the room) is access, the same
 * trust level as a share link. Harden later via the provider `params` token +
 * an onConnect check.
 */
export class Document extends YServer<Env> {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as never)) ||
      new Response("Prism collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;

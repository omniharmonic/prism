# B05 pre-sync lifecycle audit

Status: proposed, not implemented. Read-only inspection of installed Hocuspocus provider 4.1.0 and frontend at `d3e817a`. No production changes, lifecycle tests, or enforcement activation are claimed here. Independent command helpers are recorded in B05-COMMAND-HELPERS.md.

## Observed ordering

- `node_modules/@hocuspocus/provider/src/HocuspocusProvider.ts:423`: onOpen emits its callback, awaits sending the token, then starts synchronization before the server authorization response. Callback promises are not a synchronization barrier.
- `sendToken` catches token resolution failures; onOpen can still reach startSync. documentUpdateHandler sends updates without a scope gate.
- `MessageReceiver.ts:71` sends generic encoded responses that can contain SyncStepTwo document updates. Filtering only UpdateMessage misses these.
- `HocuspocusProviderWebsocket.ts:422` flushes the private message queue on the first incoming frame, before processing that frame's authentication result.
- There is no public asynchronous beforeSync veto. onOutgoingMessage is a notification, not an interception point.
- `apps/web/src/collab/CollabDoc.tsx` currently checks note access, hydrates local CRDT state, constructs the provider, and refreshes REST access after authentication. That refresh is too late to gate synchronization.

## Proposed smallest isolated seam

New scopedProvider.ts controller and cacheGeneration.ts helper; leave localDocument.ts unchanged. After proof and review, replace only CollabDoc's connection/persistence effect. Preserve title editing, snapshots, review, outline and ordinary writer behavior.

Construct a supplied websocket with autoConnect:false, construct and explicitly attach the provider, then connect. Use one provider/socket per connection attempt; synchronously stop its automatic reconnect on close and recreate attempts with fresh credentials and normal backoff. Preserve an authorized writer's Y.Doc across ordinary network loss. This isolates stale token promises and private queues from later attempts.

Gate encoded transport frames, including generic synchronization replies. Initially permit only authentication and required connection control. Hold bounded incoming synchronization frames until fresh socket scope, scoped access and generation checks complete. Replay afterward so a server SyncStepOne computes a diff from the correctly hydrated document. Overflow must reconnect while retaining the writer document. Read-only sessions use a fresh uncached document and never transmit SyncStepTwo or Update. Never release an old queue of document frames after authentication; retain edits in Y.Doc and recompute synchronization. Persistent-generation sends and retirement share a cross-tab lock, with current-attempt and durable-generation checks immediately before physical send.

Rejected shortcuts: asynchronous React callbacks, token-only gates, outgoing message class filtering, hydration changes alone, and an authorized probe followed by an unrestricted second connection.

## Generation and recovery contract

Metadata is keyed by authoritative origin/workspace/vault/actor and document identity. Retain original cache bytes. Maintain an active generation plus durable retired-generation records; pass generation-qualified keys into unchanged persistLocalDocument.

Confirmed downgrade freezes edits and transmission immediately, closes persistence, preserves the document snapshot and original cache reference, atomically retires its generation, then creates a fresh read-only document. Broadcast retirement for prompt UI response, but check durable state before reconnect and outgoing updates even when a tab missed the broadcast. Upgrade never automatically hydrates retired bytes. Recovery export requires fresh access to the same note and audience. Ordinary authorized offline writers recover a non-retired generation after renewed socket/access checks.

Storage failure must not make every owner read-only: a fresh online document remains editable with the existing local-save warning. Previously cached state with uncertain retirement remains isolated and recoverable. Local persistence acknowledgement must not imply server save.

Client metadata cannot detect a whole downgrade/upgrade that happened while every client was absent without a server permission generation. Do not claim that stronger guarantee.

## Required proof before wiring or activation

Controlled WebSocket frame capture, followed by an isolated real Hocuspocus browser journey:

- Cached offline sentinel content emits zero SyncStepTwo/Update bytes before scoped authorization, including reconnect.
- Delayed or failed token resolution and an obsolete attempt cannot send through a new attempt.
- Early server SyncStepOne cannot trigger an early update reply.
- Read-only rejects all outgoing update paths, including manually mutated Y.Doc roots.
- Authorized writer recovery survives actual server persistence and reload.
- Downgrade/upgrade never automatically restores retired bytes.
- Two tabs cover missed broadcasts, suspension, reconnect and retirement/send races.
- Storage/locks denial preserves online owner editing and isolates uncertain recovery.
- Account, capability and workspace changes invalidate pending effects.
- Existing editor updates, awareness, anchored comments and replies remain functional.

## Activation dependencies

Existing captureWriteContext locally derives actors and defaults capability workspace/vault to default/primary. It is not authoritative command audience resolution. Socket authorization returns only readonly/read-write. Actor-dependent commands and new durable audience binding require acknowledged server actor/workspace/vault identity and aligned native/capability credentials. If atomic identity binding is required, command POST also needs an expected-actor/audience precondition: client preflight alone cannot guarantee it. Root owns backend coordination. Do not enable enforcement, remove the trusted-collaborator disclosure, or replace existing writer behavior while these dependencies remain unresolved.

# C05 — Authoritative reply envelope needed for automatic Reply all

The current `LiveActionsClient.emailReply` supports a stored note ID, shown `expectTo`, body, and explicit `cc`. The server re-derives Reply-To/From (or original To when replying to its own message), subject and threading. It does not implement a Reply-all mode or return an authorized compose envelope.

The frontend therefore supports **Reply with explicit Cc**. It does not infer all recipients, claim an exact current server From address from historical note metadata, or pass the original entire recipient list as `expectTo` (which would disagree with the existing server contract).

Requested future read contract: an actor/vault/note-scoped compose envelope with verified sending account, reply and reply-all To/Cc sets, current note/envelope revision, and supported attachment capabilities. Submission should compare the chosen displayed envelope and revision, derive threading server-side, and refuse changed targets. Recipient exclusions must use the current sending account identity, not display-name or suffix matching.

No backend/API code is modified by this request. Current explicit Cc changes participate in the retry fingerprint while the body draft remains stable. Read-only document state never grants outward-send authority; LiveActions availability remains required for web/native server sends.

# C07 — Atomic agent policy precondition

The comms draft panel creates a dedicated, note-bound read-only session using existing AgentClient methods. Before generation or local insertion it freshly reads the session and checks its note, effective permission mode, pending mode, archive state, and current authenticated scope. It uses the existing conversation controller for durable output and stream recovery; it never sends an external message.

`sendTurn` currently has no expected permission-mode/policy-version precondition. A permission change performed elsewhere between the fresh read and the accepted turn remains a race the frontend cannot atomically exclude. Requested backend contract: optional expected policy version and required permission mode on turn submission, checked together with session/turn acceptance and idempotent request matching. A mismatch should return a recoverable conflict without starting a turn.

No backend, transport, or shared API contract is changed here. The dedicated draft feature stays hidden when the server does not advertise idempotent requests plus a read-only profile and permission mode. Attachment support remains a separate C07/backend capability requirement; this slice does not claim attachment handling.

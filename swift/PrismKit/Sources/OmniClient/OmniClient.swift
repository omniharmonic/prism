import Foundation
@_exported import PrismModels
import PrismSSE
import PrismTransport

/// What `POST /threads/:id/turns` answered.
public enum TurnStart: Sendable, Equatable {
    /// 202 — a new turn is running.
    case started(turnId: String)
    /// 200 + `Idempotent-Replayed` — this key already started that turn.
    case replayed(turnId: String, status: String)
    /// 409 `conflict` — a turn is already running; attach to it with the thread stream.
    case alreadyRunning(turnId: String)

    public var turnId: String {
        switch self {
        case .started(let id), .replayed(let id, _), .alreadyRunning(let id): return id
        }
    }
}

/// `POST /turns/:id/cancel`: `cancelling` (202) or the ended turn's status (200).
public struct TurnCancellation: Decodable, Sendable, Equatable {
    public let turnId: String
    public let status: String
}

/// What a decision did. Read `approval.status`: `sent`, `failed` (provably not sent;
/// `approval.result` has the executor's error), `unknown` (the executor MAY have acted —
/// check before sending again), `cancelled`, `revised`.
public struct ApprovalDecision: Sendable, Equatable {
    public let approval: Approval
    /// The turn asking the agent for a new draft (`revise` with feedback).
    public let turnId: String?
    /// The server answered the stored outcome of an earlier request with this key —
    /// nothing was executed again.
    public let replayed: Bool
    /// 200 (sent / cancelled / revised / replay), 422 (failed), 502 (unknown).
    public let httpStatus: Int

    public init(approval: Approval, turnId: String? = nil, replayed: Bool = false, httpStatus: Int = 200) {
        self.approval = approval
        self.turnId = turnId
        self.replayed = replayed
        self.httpStatus = httpStatus
    }
}

/// An edit: the NEW pending approval (new digest); the old one is now `revised`.
public struct ApprovalEdit: Decodable, Sendable, Equatable {
    public let approval: Approval
    public let replaced: String
}

public enum OmniError: Error, Sendable, Equatable {
    /// The payload held locally does not hash to the digest the server stated: what is on
    /// screen is not what would be sent. Nothing was sent; re-read the approval.
    case localDigestMismatch(approvalId: String)
    /// `send` refused with nothing executed and the approval still pending:
    /// `executor_disabled` (switched off on the server) or `executor_unavailable` (no
    /// executor wired for this kind).
    case executorNotReady(code: String, executor: String?)
}

/// One item of a thread's live stream.
public enum ThreadStreamUpdate: Sendable, Equatable {
    case connected
    case event(OmniStreamEnvelope)
    /// The connection dropped; a reconnect (resuming after the last persisted event)
    /// starts after `delay`.
    case reconnecting(delay: Duration)
}

/// One item of the owner-wide change channel.
public enum NoticeStreamUpdate: Sendable, Equatable {
    /// (Re)connected. Notices have no ids and are not replayed: after every `connected`
    /// re-read whatever the screen shows.
    case connected
    case notice(OmniNotice)
    case reconnecting(delay: Duration)
}

/// Typed calls for every `/api/omni/*` route docs/omni-module.md documents as BUILT.
/// Owner-only on the server: any other account gets ``PrismError/forbidden(_:)``; a server
/// with `OMNI_ENABLED` off answers 404 (``PrismError/rejected(_:)``) on every route.
///
/// Not built on the server, so not here (docs/omni-module.md § Not built yet):
/// TODO(omni) `/api/omni/push` (Omni-own APNs registration), `/nudges*` (M3),
/// `POST /tasks/:id/dispatch` (M2), voice (M4).
public struct OmniClient: Sendable {
    public let transport: PrismClient
    private static let base = "/api/omni"

    public init(transport: PrismClient) {
        self.transport = transport
    }

    // MARK: Version

    public func version() async throws -> OmniVersion {
        try await transport.send(.get("\(Self.base)/version"))
    }

    // MARK: Threads

    /// Pinned first, then newest. `states` empty = all; archived threads only with
    /// `includeArchived`.
    public func threads(states: [ThreadState] = [], search: String? = nil, includeArchived: Bool = false) async throws -> ThreadList {
        var q: [URLQueryItem] = []
        if !states.isEmpty { q.append(URLQueryItem(name: "state", value: states.map(\.rawValue).joined(separator: ","))) }
        if let search, !search.isEmpty { q.append(URLQueryItem(name: "q", value: search)) }
        if includeArchived { q.append(URLQueryItem(name: "archived", value: "1")) }
        return try await transport.send(.get("\(Self.base)/threads", query: q))
    }

    /// Creates the Hermes session and starts the first turn.
    ///
    /// Not idempotent (the route takes no `Idempotency-Key`): after
    /// ``PrismError/outcomeUnknown(_:)`` list the threads before trying again.
    public func createThread(_ new: NewThread) async throws -> CreatedThread {
        try await transport.send(.json("POST", "\(Self.base)/threads", body: new))
    }

    /// The thread with its messages, cards and approvals. Clears `unread`.
    public func thread(_ id: String) async throws -> ThreadDetail {
        try await transport.send(.get("\(Self.base)/threads/\(try Self.segment(id))"))
    }

    public func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread {
        struct Answer: Decodable { let thread: OmniThread }
        let a: Answer = try await transport.send(.json("PATCH", "\(Self.base)/threads/\(try Self.segment(id))", body: patch))
        return a.thread
    }

    // MARK: Turns

    /// Send a message into a thread. Pass an ``IdempotencyKey`` and RESEND THE SAME KEY
    /// when retrying after ``PrismError/outcomeUnknown(_:)``: the server then answers the
    /// turn it already started instead of starting another.
    public func startTurn(threadID: String, text: String, noteIDs: [String] = [], idempotencyKey: IdempotencyKey? = nil) async throws -> TurnStart {
        struct Body: Encodable {
            let text: String
            let noteIds: [String]?
        }
        struct Answer: Decodable {
            let turnId: String
            let status: String?
        }
        let request = try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/turns", body: Body(text: text, noteIds: noteIDs.isEmpty ? nil : noteIDs), idempotencyKey: idempotencyKey)
        let r = try await transport.sendRaw(request)
        switch r.status {
        case 200..<300:
            let a: Answer = try r.decode()
            return r.isIdempotentReplay ? .replayed(turnId: a.turnId, status: a.status ?? "running") : .started(turnId: a.turnId)
        case 409:
            if let a = try? r.decode(Answer.self) { return .alreadyRunning(turnId: a.turnId) }
            throw PrismClient.error(for: r)
        default:
            throw PrismClient.error(for: r)
        }
    }

    public func cancelTurn(_ turnID: String) async throws -> TurnCancellation {
        try await transport.send(PrismRequest(method: "POST", path: "\(Self.base)/turns/\(try Self.segment(turnID))/cancel"))
    }

    // MARK: Streams

    /// A thread's event stream: replays every persisted event after `after`, then follows
    /// the running turn. The server closes it after the turn's final `status` (or right
    /// after the replay when nothing runs), which ends this sequence.
    ///
    /// A dropped connection is retried with backoff, resuming after the last persisted
    /// event (`?after=` and `Last-Event-ID`); live `text_delta`s have no id and never
    /// move the cursor — the block's final `text` replaces them (see ``TurnTranscript``).
    /// Fatal errors (signed out, forbidden, not found) end the sequence by throwing.
    /// Cancelling the consuming task closes the connection.
    ///
    /// A clean close cannot be told apart from an intermediary ending the response, so
    /// after the sequence ends without a `result`, read the thread (`activeTurnId`) and
    /// attach again if a turn is still running.
    public func threadStream(threadID: String, after: Int = 0, policy: SSERetryPolicy = .default) -> AsyncThrowingStream<ThreadStreamUpdate, any Error> {
        let transport = self.transport
        let path: String
        do { path = "\(Self.base)/threads/\(try Self.segment(threadID))/stream" } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        let seed = after > 0 ? String(after) : nil
        let sse = SSEStream.events(lastEventID: seed, policy: policy, reconnectOnEnd: false, classify: Self.classify) { lastEventID in
            let cursor = lastEventID.flatMap { Int($0) } ?? 0
            var request = PrismRequest.get(path, query: [URLQueryItem(name: "after", value: String(cursor))])
            if cursor > 0 { request.headers["Last-Event-ID"] = String(cursor) }
            return try await transport.openStream(request)
        }
        return Self.map(sse) { item in
            switch item {
            case .connected: return .connected
            case .reconnecting(_, let delay): return .reconnecting(delay: delay)
            case .keepalive: return nil
            case .event(let e): return OmniStreamEnvelope.decode(eventName: e.event, data: e.data).map(ThreadStreamUpdate.event)
            }
        }
    }

    /// The owner-wide change channel (`GET /api/omni/events`): ids-only notices. The
    /// server recycles the connection every 15 minutes; this reconnects on its own.
    public func notices(policy: SSERetryPolicy = .default) -> AsyncThrowingStream<NoticeStreamUpdate, any Error> {
        let transport = self.transport
        let sse = SSEStream.events(policy: policy, reconnectOnEnd: true, classify: Self.classify) { _ in
            try await transport.openStream(.get("\(Self.base)/events"))
        }
        return Self.map(sse) { item in
            switch item {
            case .connected: return .connected
            case .reconnecting(_, let delay): return .reconnecting(delay: delay)
            case .keepalive: return nil
            case .event(let e): return (try? PrismJSON.decoder().decode(OmniNotice.self, from: Data(e.data.utf8))).map(NoticeStreamUpdate.notice)
            }
        }
    }

    /// Which stream failures are worth a reconnect.
    static let classify: SSEStream.Classify = { error in
        guard let e = error as? PrismError else { return .retry }
        switch e {
        case .unreachable, .outcomeUnknown, .unauthorized: return .retry
        case .rejected(let f): return [408, 425, 429].contains(f.status) ? .retry : .fail
        default: return .fail
        }
    }

    private static func map<T: Sendable>(_ source: AsyncThrowingStream<SSEStreamItem, any Error>, _ transform: @escaping @Sendable (SSEStreamItem) -> T?) -> AsyncThrowingStream<T, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await item in source {
                        if let out = transform(item) { continuation.yield(out) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Approvals

    /// `status` nil = every status (newest first, up to 100).
    public func approvals(status: ApprovalStatus? = .pending) async throws -> [Approval] {
        let q = status.map { [URLQueryItem(name: "status", value: $0.rawValue)] } ?? []
        let list: ApprovalList = try await transport.send(.get("\(Self.base)/approvals", query: q))
        return list.approvals
    }

    public func approval(_ id: String) async throws -> Approval {
        struct Answer: Decodable { let approval: Approval }
        let a: Answer = try await transport.send(.get("\(Self.base)/approvals/\(try Self.segment(id))"))
        return a.approval
    }

    /// Replace a pending draft's payload. `shown` is the approval the person edited; its
    /// digest proves which draft that was. Answers the NEW pending approval.
    public func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit {
        struct Body: Encodable {
            let digest: String
            let payload: JSONValue
        }
        return try await transport.send(.json("PUT", "\(Self.base)/approvals/\(try Self.segment(shown.id))", body: Body(digest: shown.digest, payload: payload)))
    }

    /// Decide on the approval THE PERSON SAW.
    ///
    /// - The digest sent is `shown.digest`; first the payload held locally is re-hashed,
    ///   and a mismatch refuses locally (``OmniError/localDigestMismatch(approvalId:)``).
    /// - `idempotencyKey` is required. Create one per press (``IdempotencyKey/random()``),
    ///   keep it, and RESEND THE SAME KEY after ``PrismError/outcomeUnknown(_:)`` or a lost
    ///   answer: the server then answers the stored outcome (`replayed`) and executes
    ///   nothing twice. A different key on a decided approval is
    ///   `conflict(already_decided | in_progress)`.
    /// - `conflict(digest_mismatch)`: the draft changed on the server — show it again.
    /// - `rejected` 410 `expired`; `forbidden(human_origin_required)`.
    /// - This client never sends `X-Prism-Action-Origin`: a decision made through it is a
    ///   human one, so call it only from a person's tap (after the app's own Face ID /
    ///   Touch ID check).
    public func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String? = nil, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision {
        guard shown.digestMatchesPayload else { throw OmniError.localDigestMismatch(approvalId: shown.id) }
        struct Body: Encodable {
            let decision: String
            let digest: String
            let feedback: String?
        }
        struct Answer: Decodable {
            let approval: Approval
            let turnId: String?
        }
        let request = try PrismRequest.json("POST", "\(Self.base)/approvals/\(try Self.segment(shown.id))/decision", body: Body(decision: decision.rawValue, digest: shown.digest, feedback: feedback), idempotencyKey: idempotencyKey)
        let r = try await transport.sendRaw(request)
        // 200 decided/replayed · 422 failed (provably not sent) · 502 unknown — each with {approval}.
        if r.isSuccess || r.status == 422 || r.status == 502, let a = try? r.decode(Answer.self) {
            return ApprovalDecision(approval: a.approval, turnId: a.turnId, replayed: r.isIdempotentReplay, httpStatus: r.status)
        }
        let error = PrismClient.error(for: r)
        if r.status == 503, let code = error.serverCode, code == "executor_disabled" || code == "executor_unavailable" {
            let executor = ((try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any])?["executor"] as? String
            throw OmniError.executorNotReady(code: code, executor: executor)
        }
        if r.isSuccess { throw PrismError.decoding("decision answer without an approval") }
        throw error
    }

    // MARK: Jobs

    public func jobs() async throws -> [OmniJob] {
        let list: JobList = try await transport.send(.get("\(Self.base)/jobs"))
        return list.jobs
    }

    public func createJob(_ new: NewJob) async throws -> OmniJob {
        struct Answer: Decodable { let job: OmniJob }
        let a: Answer = try await transport.send(.json("POST", "\(Self.base)/jobs", body: new))
        return a.job
    }

    /// Pause, resume, or run a job now.
    public func job(_ id: String, _ action: JobAction) async throws -> OmniJob {
        struct Answer: Decodable { let job: OmniJob }
        let a: Answer = try await transport.send(PrismRequest(method: "POST", path: "\(Self.base)/jobs/\(try Self.segment(id))/\(action.rawValue)"))
        return a.job
    }

    // MARK: Today

    /// `date` is `YYYY-MM-DD` in the PERSON's zone (the server would otherwise use its own).
    public func today(date: String) async throws -> OmniToday {
        try await transport.send(.get("\(Self.base)/today", query: [URLQueryItem(name: "date", value: date)]))
    }

    /// Today for a moment in a calendar's time zone (default: the device's).
    public func today(_ now: Date = Date(), calendar: Calendar = .current) async throws -> OmniToday {
        try await today(date: Self.dayString(now, calendar: calendar))
    }

    static func dayString(_ date: Date, calendar: Calendar) -> String {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let c = gregorian.dateComponents([.year, .month, .day], from: date)
        let pad: (Int, Int) -> String = { v, n in
            let s = String(v)
            return String(repeating: "0", count: max(0, n - s.count)) + s
        }
        return "\(pad(c.year ?? 0, 4))-\(pad(c.month ?? 0, 2))-\(pad(c.day ?? 0, 2))"
    }

    // MARK: Helpers

    /// An id that goes into a URL path: one segment of `[A-Za-z0-9_.:-]`, never `.`/`..`.
    static func segment(_ id: String) throws -> String {
        let n = id.utf8.count
        guard n >= 1, n <= 200, id != ".", id != "..", id.utf8.allSatisfy({ c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F || c == 0x2E || c == 0x3A || c == 0x2D
        }) else { throw PrismError.invalidRequest("id refused") }
        return id
    }
}

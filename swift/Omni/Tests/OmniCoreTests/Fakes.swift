import Foundation
import OmniClient
@testable import OmniCore
import PrismAuth
import PrismTransport
import XCTest

// MARK: Gateway-shaped fixtures (built as the JSON the gateway sends, then decoded)

enum Fixture {
    static func decode<T: Decodable>(_ object: [String: Any], as type: T.Type = T.self) -> T {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! PrismJSON.decoder().decode(T.self, from: data)
    }

    static func threadJSON(_ id: String, state: String = "done", title: String? = nil, unread: Int = 0, lastSeq: Int = 0, archived: Bool = false, waitingOn: String? = nil, gone: Bool = false) -> [String: Any] {
        var o: [String: Any] = ["id": id, "state": state, "unread": unread, "pinned": false, "archived": archived, "running": state == "working", "lastSeq": lastSeq, "source": "text", "gone": gone]
        o["title"] = title ?? "Thread \(id)"
        if let waitingOn { o["waitingOn"] = waitingOn }
        return o
    }

    static func thread(_ id: String, state: String = "done", title: String? = nil, unread: Int = 0, lastSeq: Int = 0, archived: Bool = false) -> OmniThread {
        decode(threadJSON(id, state: state, title: title, unread: unread, lastSeq: lastSeq, archived: archived))
    }

    static func list(_ threads: [[String: Any]], hermes: String = "ok") -> ThreadList {
        decode(["threads": threads, "next": NSNull(), "hermes": hermes])
    }

    static var emailPayload: [String: Any] { ["to": ["dana@example.com"], "subject": "Budget call", "body": "Hi Dana, would Tuesday work?"] }

    static func approvalJSON(_ id: String, kind: String = "email", payload: [String: Any] = emailPayload, status: String = "pending", digest: String? = nil, executorEnabled: Bool = true, threadId: String? = "t1", createdAt: String = "2026-10-08T15:00:00.000Z", expiresAt: String = "2099-01-01T00:00:00.000Z", result: [String: Any]? = nil) -> [String: Any] {
        let value: JSONValue = decode(["v": payload], as: [String: JSONValue].self)["v"]!
        var o: [String: Any] = [
            "id": id, "kind": kind, "payload": payload,
            "digest": digest ?? ApprovalDigest.digest(kind: kind, payload: value),
            "summary": "Email Dana", "status": status, "createdAt": createdAt, "expiresAt": expiresAt,
            "executor": ["name": "proton-send", "available": true, "enabled": executorEnabled],
        ]
        if let threadId { o["threadId"] = threadId }
        if let result { o["result"] = result }
        return o
    }

    static func approval(_ id: String, kind: String = "email", payload: [String: Any] = emailPayload, status: String = "pending", digest: String? = nil, executorEnabled: Bool = true, threadId: String? = "t1", expiresAt: String = "2099-01-01T00:00:00.000Z", result: [String: Any]? = nil) -> Approval {
        decode(approvalJSON(id, kind: kind, payload: payload, status: status, digest: digest, executorEnabled: executorEnabled, threadId: threadId, expiresAt: expiresAt, result: result))
    }

    static func message(_ role: String, _ text: String, at: String, id: Int = 0) -> [String: Any] {
        role == "tool" ? ["id": id, "role": role, "toolName": text, "at": at] : ["id": id, "role": role, "text": text, "at": at]
    }

    static func detail(_ id: String = "t1", state: String = "done", lastSeq: Int = 0, messages: [[String: Any]] = [], approvals: [[String: Any]] = [], cards: [[String: Any]] = [], activeTurnId: String? = nil) -> ThreadDetail {
        var o: [String: Any] = ["thread": threadJSON(id, state: activeTurnId == nil ? state : "working", lastSeq: lastSeq), "messages": messages, "cards": cards, "approvals": approvals]
        o["activeTurnId"] = activeTurnId ?? NSNull()
        return decode(o)
    }

    static func today(agenda: [[String: Any]]? = [], tasks: [[String: Any]]? = [], errors: [String: String] = [:]) -> OmniToday {
        decode([
            "date": "2026-10-09", "agenda": agenda as Any? ?? NSNull(), "tasks": tasks as Any? ?? NSNull(), "taskIdentity": "person",
            "needsYou": ["approvals": [] as [Any], "nudges": [] as [Any]], "inFlight": [] as [Any],
            "openLoops": NSNull(), "brief": NSNull(), "errors": errors,
        ])
    }

    static func card(_ noteId: String, op: String = "updated", updatedAt: String? = nil) -> [String: Any] {
        var o: [String: Any] = ["kind": "record", "noteId": noteId, "op": op, "type": "task", "title": "Budget call", "summary": "properties status"]
        if let updatedAt { o["updatedAt"] = updatedAt }
        return o
    }

    static func event(_ seq: Int?, turn: String? = "turn1", _ event: OmniStreamEvent) -> ThreadStreamUpdate {
        .event(OmniStreamEnvelope(seq: seq, turnId: turn, event: event))
    }

    static func failure(_ status: Int, _ code: String? = nil) -> ServerFailure {
        ServerFailure(status: status, code: code, detail: nil, body: Data())
    }

    static let unknownOutcome = PrismError.outcomeUnknown(OutcomeUnknown(status: 502, code: nil, reason: "bad gateway"))
}

// MARK: A scripted gateway

/// Answers from queues (the last answer repeats) and records what was asked.
final class FakeService: OmniService, @unchecked Sendable {
    private let lock = NSLock()
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    struct Queue<T> {
        var items: [Result<T, any Error>] = []
        mutating func next() throws -> T {
            guard let first = items.first else { throw PrismError.invalidRequest("nothing scripted") }
            if items.count > 1 { items.removeFirst() }
            return try first.get()
        }
    }

    private var _lists = Queue<ThreadList>()
    private var _details = Queue<ThreadDetail>()
    private var _created = Queue<CreatedThread>()
    private var _starts = Queue<TurnStart>()
    private var _cancels = Queue<TurnCancellation>()
    private var _pending = Queue<[Approval]>()
    private var _approval = Queue<Approval>()
    private var _edits = Queue<ApprovalEdit>()
    private var _decisions = Queue<ApprovalDecision>()
    private var _jobs = Queue<[OmniJob]>()
    private var _jobActions = Queue<OmniJob>()
    private var _today = Queue<OmniToday>()
    private var _tasks = Queue<OmniTasksPage>()
    private var _taskCursors: [String?] = []
    private var _createdRequests: [NewThread] = []
    private var _patches = Queue<OmniThread>()
    private var _patchCalls: [String] = []
    private var _streams: [[Result<ThreadStreamUpdate, any Error>]] = []
    private var _manualStreams: [AsyncThrowingStream<ThreadStreamUpdate, any Error>] = []
    private var _notices: AsyncThrowingStream<NoticeStreamUpdate, any Error>?

    struct DecideCall: Equatable {
        let id: String
        let decision: ApprovalDecisionKind
        let digest: String
        let feedback: String?
        let key: IdempotencyKey
    }
    private var _searches: [String?] = []
    private var _startKeys: [IdempotencyKey] = []
    private var _startTexts: [String] = []
    private var _streamAfters: [Int] = []
    private var _cancelled: [String] = []
    private var _decides: [DecideCall] = []
    private var _detailReads = 0
    private var _approvalReads: [String] = []
    private var _edited: [JSONValue] = []
    private var _jobCalls: [String] = []
    private var _todayDates: [String] = []
    private var _createdPrompts: [String] = []
    private var _createdSources: [String] = []
    private var _listReads = 0
    private var _pendingReads = 0

    // Scripting
    func lists(_ items: Result<ThreadList, any Error>...) { locked { _lists.items = items } }
    func details(_ items: Result<ThreadDetail, any Error>...) { locked { _details.items = items } }
    func created(_ items: Result<CreatedThread, any Error>...) { locked { _created.items = items } }
    func starts(_ items: Result<TurnStart, any Error>...) { locked { _starts.items = items } }
    func cancels(_ items: Result<TurnCancellation, any Error>...) { locked { _cancels.items = items } }
    func pending(_ items: Result<[Approval], any Error>...) { locked { _pending.items = items } }
    func approvalReads(_ items: Result<Approval, any Error>...) { locked { _approval.items = items } }
    func edits(_ items: Result<ApprovalEdit, any Error>...) { locked { _edits.items = items } }
    func decisions(_ items: Result<ApprovalDecision, any Error>...) { locked { _decisions.items = items } }
    func jobs(_ items: Result<[OmniJob], any Error>...) { locked { _jobs.items = items } }
    func jobActions(_ items: Result<OmniJob, any Error>...) { locked { _jobActions.items = items } }
    func taskPages(_ items: Result<OmniTasksPage, any Error>...) { locked { _tasks.items = items } }
    var taskCursors: [String?] { locked { _taskCursors } }
    var createdRequests: [NewThread] { locked { _createdRequests } }
    func todays(_ items: Result<OmniToday, any Error>...) { locked { _today.items = items } }
    func patches(_ items: Result<OmniThread, any Error>...) { locked { _patches.items = items } }
    /// `"<id> archived=true"` for every `updateThread`.
    var patchCalls: [String] { locked { _patchCalls } }
    /// Each call to `threadStream` plays the next script, then ends (or throws).
    func streams(_ scripts: [Result<ThreadStreamUpdate, any Error>]...) { locked { _streams = scripts } }
    /// A stream the test feeds by hand.
    func manualStream() -> AsyncThrowingStream<ThreadStreamUpdate, any Error>.Continuation {
        let (stream, continuation) = AsyncThrowingStream<ThreadStreamUpdate, any Error>.makeStream()
        locked { _manualStreams.append(stream) }
        return continuation
    }
    func noticeStream() -> AsyncThrowingStream<NoticeStreamUpdate, any Error>.Continuation {
        let (stream, continuation) = AsyncThrowingStream<NoticeStreamUpdate, any Error>.makeStream()
        locked { _notices = stream }
        return continuation
    }

    // Records
    var searches: [String?] { locked { _searches } }
    var startKeys: [IdempotencyKey] { locked { _startKeys } }
    var startTexts: [String] { locked { _startTexts } }
    var streamAfters: [Int] { locked { _streamAfters } }
    var cancelled: [String] { locked { _cancelled } }
    var decides: [DecideCall] { locked { _decides } }
    var detailReads: Int { locked { _detailReads } }
    var approvalReadIDs: [String] { locked { _approvalReads } }
    var editedPayloads: [JSONValue] { locked { _edited } }
    var jobCalls: [String] { locked { _jobCalls } }
    var todayDates: [String] { locked { _todayDates } }
    var createdSources: [String] { locked { _createdSources } }
    var createdPrompts: [String] { locked { _createdPrompts } }
    var listReads: Int { locked { _listReads } }
    var pendingReads: Int { locked { _pendingReads } }

    // OmniService
    func threads(states: [ThreadState], search: String?, includeArchived: Bool) async throws -> ThreadList {
        try locked { () -> Result<ThreadList, any Error> in
            _searches.append(search)
            _listReads += 1
            return Result { try _lists.next() }
        }.get()
    }
    var createGate: (@Sendable () async -> Void)?
    func createThread(_ new: NewThread) async throws -> CreatedThread {
        if let createGate { await createGate() }
        return try locked { () -> Result<CreatedThread, any Error> in
            _createdRequests.append(new)
            _createdPrompts.append(new.prompt)
            _createdSources.append(new.source ?? "text")
            return Result { try _created.next() }
        }.get()
    }
    func thread(_ id: String) async throws -> ThreadDetail {
        try locked { () -> Result<ThreadDetail, any Error> in
            _detailReads += 1
            return Result { try _details.next() }
        }.get()
    }
    func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread {
        try locked { () -> Result<OmniThread, any Error> in
            _patchCalls.append("\(id) archived=\(patch.archived.map(String.init) ?? "nil")")
            return Result { try _patches.next() }
        }.get()
    }
    func startTurn(threadID: String, text: String, idempotencyKey: IdempotencyKey) async throws -> TurnStart {
        try locked { () -> Result<TurnStart, any Error> in
            _startKeys.append(idempotencyKey)
            _startTexts.append(text)
            return Result { try _starts.next() }
        }.get()
    }
    func cancelTurn(_ turnID: String) async throws -> TurnCancellation {
        try locked { () -> Result<TurnCancellation, any Error> in
            _cancelled.append(turnID)
            return Result { try _cancels.next() }
        }.get()
    }
    func threadStream(threadID: String, after: Int) -> AsyncThrowingStream<ThreadStreamUpdate, any Error> {
        let (manual, script): (AsyncThrowingStream<ThreadStreamUpdate, any Error>?, [Result<ThreadStreamUpdate, any Error>]) = locked {
            _streamAfters.append(after)
            if !_manualStreams.isEmpty { return (_manualStreams.removeFirst(), []) }
            return (nil, _streams.isEmpty ? [] : _streams.removeFirst())
        }
        if let manual { return manual }
        return AsyncThrowingStream { continuation in
            for item in script {
                switch item {
                case .success(let update): continuation.yield(update)
                case .failure(let error):
                    continuation.finish(throwing: error)
                    return
                }
            }
            continuation.finish()
        }
    }
    func notices() -> AsyncThrowingStream<NoticeStreamUpdate, any Error> {
        locked { _notices } ?? AsyncThrowingStream { $0.finish() }
    }
    func approvals(status: ApprovalStatus?) async throws -> [Approval] {
        try locked { () -> Result<[Approval], any Error> in
            _pendingReads += 1
            return Result { try _pending.next() }
        }.get()
    }
    func approval(_ id: String) async throws -> Approval {
        try locked { () -> Result<Approval, any Error> in
            _approvalReads.append(id)
            return Result { try _approval.next() }
        }.get()
    }
    func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit {
        try locked { () -> Result<ApprovalEdit, any Error> in
            _edited.append(payload)
            return Result { try _edits.next() }
        }.get()
    }
    func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String?, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision {
        try locked { () -> Result<ApprovalDecision, any Error> in
            _decides.append(DecideCall(id: shown.id, decision: decision, digest: shown.digest, feedback: feedback, key: idempotencyKey))
            return Result { try _decisions.next() }
        }.get()
    }
    func jobs() async throws -> [OmniJob] { try locked { Result { try _jobs.next() } }.get() }
    func job(_ id: String, _ action: JobAction) async throws -> OmniJob {
        try locked { () -> Result<OmniJob, any Error> in
            _jobCalls.append("\(id):\(action.rawValue)")
            return Result { try _jobActions.next() }
        }.get()
    }
    func tasks(cursor: String?) async throws -> OmniTasksPage {
        try locked { () -> Result<OmniTasksPage, any Error> in
            _taskCursors.append(cursor)
            return Result { try _tasks.next() }
        }.get()
    }
    func today(date: String) async throws -> OmniToday {
        try locked { () -> Result<OmniToday, any Error> in
            _todayDates.append(date)
            return Result { try _today.next() }
        }.get()
    }
}

final class FakeAuth: SessionAuth, @unchecked Sendable {
    private let lock = NSLock()
    private var _hasToken: Bool
    private var _signInResult: Result<Void, any Error> = .success(())
    private var _labels: [String] = []
    private var _signOuts = 0
    var signOutResult: SignOutResult = .revoked

    init(hasToken: Bool = false) { _hasToken = hasToken }

    var hasToken: Bool { lock.withLock { _hasToken } }
    var labels: [String] { lock.withLock { _labels } }
    var signOuts: Int { lock.withLock { _signOuts } }
    func failSignIn(_ error: any Error) { lock.withLock { _signInResult = .failure(error) } }
    /// The token is stored, and THEN the attempt reports this error (a late failure).
    func storeTokenThenFail(_ error: any Error) { lock.withLock { _lateFailure = error } }
    private var _lateFailure: (any Error)?
    /// While set, `signIn` waits here (the browser leg) until `releaseSignIn()`.
    private var _gate: CheckedContinuation<Void, Never>?
    private var _gated = false
    func holdSignIn() { lock.withLock { _gated = true } }
    var isWaitingInSignIn: Bool { lock.withLock { _gate != nil } }
    func releaseSignIn() {
        let c = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            defer { _gate = nil }
            _gated = false
            return _gate
        }
        c?.resume()
    }

    func signIn(label: String) async throws {
        let result = lock.withLock { () -> Result<Void, any Error> in
            _labels.append(label)
            return _signInResult
        }
        if lock.withLock({ _gated }) {
            await withCheckedContinuation { c in lock.withLock { _gate = c } }
        }
        try result.get()
        lock.withLock { _hasToken = true }
        if let late = lock.withLock({ _lateFailure }) { throw late }
    }
    func signOut() async -> SignOutResult {
        lock.withLock {
            _signOuts += 1
            _hasToken = false
        }
        return signOutResult
    }
}

final class FakeProbe: ServerProbe, @unchecked Sendable {
    private let lock = NSLock()
    private var results: [ServerProbeResult]
    private var _probed: [String] = []
    init(_ results: ServerProbeResult...) { self.results = results }
    var probed: [String] { lock.withLock { _probed } }
    func probe(_ origin: ServerOrigin) async -> ServerProbeResult {
        lock.withLock {
            _probed.append(origin.value)
            return results.count > 1 ? results.removeFirst() : results[0]
        }
    }
}

final class FakeSettings: SettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String? = nil) { self.value = value }
    func serverURL() -> String? { lock.withLock { value } }
    func setServerURL(_ value: String?) { lock.withLock { self.value = value } }
}

final class FakeConfirmation: SendConfirmation, @unchecked Sendable {
    private let lock = NSLock()
    private var _reasons: [String] = []
    let answer: Bool
    init(_ answer: Bool) { self.answer = answer }
    var reasons: [String] { lock.withLock { _reasons } }
    func confirm(reason: String) async -> Bool {
        lock.withLock { _reasons.append(reason) }
        return answer
    }
}

// MARK: Helpers

/// Counts calls on the main actor (the signed-out signal).
@MainActor
final class Counter {
    var count = 0
    func bump() { count += 1 }
}

/// Let the model's tasks run until `condition` holds (or fail after two seconds).
@MainActor
func eventually(_ what: String = "condition", file: StaticString = #filePath, line: UInt = #line, _ condition: @MainActor () -> Bool) async {
    for _ in 0..<2000 {
        if condition() { return }
        try? await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("timed out waiting for \(what)", file: file, line: line)
}

let noSleep: @Sendable (Duration) async throws -> Void = { _ in await Task.yield() }

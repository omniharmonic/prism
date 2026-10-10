import Foundation
import OmniClient
@testable import OmniCore
import PrismAuth
import PrismTransport

/// A gateway that lives in memory and answers with made-up data, shaped exactly as the
/// real one answers (everything is built as the gateway's JSON and decoded). The Mac
/// snapshots are rendered from it: no server, no vault, nothing private in a picture.
final class SampleService: OmniService, @unchecked Sendable {
    private let lock = NSLock()
    private var threadRows: [[String: Any]] = []
    private var details: [String: [String: Any]] = [:]
    private var approvalRows: [[String: Any]] = []
    private var jobRows: [[String: Any]] = []
    private var liveStreams: [String: [OmniStreamEnvelope]] = [:]

    var todayPartial = false
    var failReads = false
    var agentUnavailable = false
    /// Change one word of every draft after its fingerprint was taken.
    var tamperDrafts = false
    /// What `send` answers: the dev gateway's "sending is switched off".
    var sendRefusal: String? = "executor_disabled"

    static func decode<T: Decodable>(_ object: Any, as type: T.Type = T.self) -> T {
        // swiftlint:disable:next force_try
        try! PrismJSON.decoder().decode(T.self, from: try! JSONSerialization.data(withJSONObject: object))
    }

    private var noAnswer: any Error { PrismError.unreachable("sample") }

    // MARK: Building the sample

    @discardableResult
    func addThread(_ id: String, _ title: String, state: String = "done", preview: String? = nil, unread: Int = 0, gone: Bool = false, waitingOn: String? = nil, messages: [(String, String)] = [], tools: [String] = [], cards: [[String: Any]] = [], approvals: [[String: Any]] = [], live: [OmniStreamEnvelope] = []) -> String {
        var row: [String: Any] = ["id": id, "title": title, "state": state, "unread": unread, "pinned": false, "archived": false, "running": state == "working", "lastSeq": 0, "source": "text", "gone": gone, "lastActivityAt": "2026-10-09T15:0\(threadRows.count % 10):00.000Z"]
        if let preview { row["preview"] = preview }
        if let waitingOn { row["waitingOn"] = waitingOn }
        var stored: [[String: Any]] = []
        for (index, message) in messages.enumerated() {
            stored.append(["id": index * 10, "role": message.0, "text": message.1, "at": "2026-10-09T15:00:\(String(format: "%02d", index * 5)).000Z"])
            if message.0 == "user", index == 0 {
                for (n, tool) in tools.enumerated() { stored.append(["id": index * 10 + n + 1, "role": "tool", "toolName": tool, "at": "2026-10-09T15:00:\(String(format: "%02d", index * 5 + 1)).000Z"]) }
            }
        }
        lock.withLock {
            threadRows.append(row)
            details[id] = ["thread": row, "messages": stored, "cards": cards, "approvals": approvals, "activeTurnId": state == "working" ? "turn-\(id)" : NSNull()]
            approvalRows.append(contentsOf: approvals.filter { $0["status"] as? String == "pending" })
            if !live.isEmpty { liveStreams[id] = live }
        }
        return id
    }

    func addJob(_ id: String, _ name: String, schedule: String, enabled: Bool, lastStatus: String, lastError: String? = nil) {
        var row: [String: Any] = ["id": id, "name": name, "schedule": schedule, "enabled": enabled, "last_status": lastStatus, "last_run_at": "2026-10-08T13:00:00Z", "deliver": "omni", "state": enabled ? "scheduled" : "paused"]
        row["next_run_at"] = enabled ? "2026-10-10T13:00:00Z" : NSNull()
        if let lastError { row["last_error"] = lastError }
        lock.withLock { jobRows.append(row) }
    }

    static func draft(_ id: String, thread: String, kind: String, payload: [String: Any], status: String = "pending", executor: [String: Any] = ["name": "proton-send", "available": true, "enabled": false]) -> [String: Any] {
        let value: JSONValue = decode(["v": payload], as: [String: JSONValue].self)["v"] ?? .null
        return [
            "id": id, "threadId": thread, "kind": kind, "payload": payload, "digest": ApprovalDigest.digest(kind: kind, payload: value),
            "summary": "Draft", "status": status, "createdAt": "2026-10-09T15:01:00.000Z", "expiresAt": "2099-01-01T00:00:00.000Z", "executor": executor,
        ]
    }

    static func event(_ seq: Int?, turn: String, _ fields: [String: Any]) -> OmniStreamEnvelope {
        var object = fields
        object["turnId"] = turn
        if let seq { object["seq"] = seq }
        let data = String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
        guard let envelope = OmniStreamEnvelope.decode(eventName: fields["t"] as? String ?? "", data: data) else { fatalError("bad sample event") }
        return envelope
    }

    private func shown(_ row: [String: Any]) -> Approval {
        var row = row
        if tamperDrafts, row["status"] as? String == "pending", var payload = row["payload"] as? [String: Any] {
            for key in ["body", "text", "description", "purpose"] {
                if let text = payload[key] as? String {
                    payload[key] = text + " (changed on the way)"
                    break
                }
            }
            row["payload"] = payload
        }
        return Self.decode(row)
    }

    // MARK: OmniService

    func threads(states: [ThreadState], search: String?, includeArchived: Bool) async throws -> ThreadList {
        if failReads { throw noAnswer }
        let rows = lock.withLock { threadRows }.filter { row in
            guard row["archived"] as? Bool != true else { return false }
            guard let search, !search.isEmpty else { return true }
            return (row["title"] as? String ?? "").localizedCaseInsensitiveContains(search)
        }
        return Self.decode(["threads": rows, "next": NSNull(), "hermes": agentUnavailable ? "unavailable" : "ok"])
    }

    func createThread(_ new: NewThread) async throws -> CreatedThread { throw PrismError.invalidRequest("sample") }

    func thread(_ id: String) async throws -> ThreadDetail {
        let detail = lock.withLock { details[id] }
        guard var detail, (detail["thread"] as? [String: Any])?["gone"] as? Bool != true else {
            throw PrismError.rejected(ServerFailure(status: 404, code: "not_found", detail: nil, body: Data(#"{"error":"not_found","gone":true}"#.utf8)))
        }
        if tamperDrafts, let approvals = detail["approvals"] as? [[String: Any]] {
            let data = try PrismJSON.encoder().encode(approvals.map(shown))
            detail["approvals"] = try JSONSerialization.jsonObject(with: data)
        }
        return Self.decode(detail)
    }

    func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread {
        let row = lock.withLock { () -> [String: Any]? in
            guard let index = threadRows.firstIndex(where: { $0["id"] as? String == id }) else { return nil }
            if let archived = patch.archived { threadRows[index]["archived"] = archived }
            return threadRows[index]
        }
        guard let row else { throw PrismError.rejected(ServerFailure(status: 404, code: "not_found", detail: nil, body: Data())) }
        return Self.decode(row)
    }

    func startTurn(threadID: String, text: String, idempotencyKey: IdempotencyKey) async throws -> TurnStart { .started(turnId: "turn-\(threadID)") }
    func cancelTurn(_ turnID: String) async throws -> TurnCancellation { throw PrismError.invalidRequest("sample") }

    /// A running turn's events, then silence: the turn stays mid-flight for the picture.
    func threadStream(threadID: String, after: Int) -> AsyncThrowingStream<ThreadStreamUpdate, any Error> {
        let events = lock.withLock { liveStreams[threadID] ?? [] }
        return AsyncThrowingStream { continuation in
            continuation.yield(.connected)
            for event in events { continuation.yield(.event(event)) }
            if events.isEmpty { continuation.finish() }
        }
    }

    func notices() -> AsyncThrowingStream<NoticeStreamUpdate, any Error> {
        AsyncThrowingStream { $0.yield(.connected) }
    }

    func approvals(status: ApprovalStatus?) async throws -> [Approval] {
        if failReads { throw noAnswer }
        return lock.withLock { approvalRows }.map(shown)
    }

    func approval(_ id: String) async throws -> Approval {
        guard let row = lock.withLock({ approvalRows.first { $0["id"] as? String == id } }) else { throw PrismError.rejected(ServerFailure(status: 404, code: "not_found", detail: nil, body: Data())) }
        return shown(row)
    }

    func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit { throw PrismError.invalidRequest("sample") }

    func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String?, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision {
        if decision == .send, let sendRefusal { throw OmniError.executorNotReady(code: sendRefusal, executor: nil) }
        let row = lock.withLock { () -> [String: Any]? in
            guard let index = approvalRows.firstIndex(where: { $0["id"] as? String == shown.id }) else { return nil }
            approvalRows[index]["status"] = decision == .cancel ? "cancelled" : decision == .revise ? "revised" : "sent"
            approvalRows[index]["decidedAt"] = "2026-10-09T15:05:00.000Z"
            return approvalRows[index]
        }
        guard let row else { throw PrismError.invalidRequest("sample") }
        return ApprovalDecision(approval: Self.decode(row))
    }

    func jobs() async throws -> [OmniJob] {
        if failReads { throw noAnswer }
        return Self.decode(lock.withLock { jobRows })
    }

    func job(_ id: String, _ action: JobAction) async throws -> OmniJob {
        let row = lock.withLock { () -> [String: Any]? in
            guard let index = jobRows.firstIndex(where: { $0["id"] as? String == id }) else { return nil }
            let pausing = action == .pause
            jobRows[index]["enabled"] = !pausing
            jobRows[index]["state"] = pausing ? "paused" : "scheduled"
            return jobRows[index]
        }
        guard let row else { throw PrismError.invalidRequest("sample") }
        return Self.decode(row)
    }

    func today(date: String) async throws -> OmniToday {
        if failReads { throw noAnswer }
        let pending = try PrismJSON.encoder().encode(lock.withLock { approvalRows }.filter { $0["status"] as? String == "pending" }.map(shown))
        let running = lock.withLock { threadRows }.filter { $0["running"] as? Bool == true }
        var object: [String: Any] = [
            "date": date,
            "agenda": [
                ["noteId": "a1", "title": "Stand-up", "start": "\(date)T09:30:00-06:00", "end": "\(date)T09:45:00-06:00"],
                ["noteId": "a2", "title": "Buoy spec review with Kevin and the hardware group", "start": "\(date)T11:00:00-06:00", "end": "\(date)T12:00:00-06:00", "location": "Studio B, second floor — or the video link in the invite"],
                ["noteId": "a3", "title": "Walk", "location": "Chautauqua"],
            ],
            "tasks": [
                ["noteId": "t1", "title": "Call Dana about the buoy spec", "status": "open", "due": date],
                ["noteId": "t2", "title": "Send the retreat agenda to the facilitators and ask who can bring a projector", "status": "open", "due": "2026-10-14"],
                ["noteId": "t3", "title": "Renew the domain", "status": "open"],
            ],
            "taskIdentity": "person",
            "needsYou": ["approvals": try JSONSerialization.jsonObject(with: pending), "nudges": [Any]()],
            "inFlight": running.map { ["id": $0["id"] ?? "", "title": $0["title"] ?? "", "state": "working"] },
            "errors": [String: String](),
        ]
        if todayPartial {
            object["agenda"] = NSNull()
            object["errors"] = ["agenda": "vault_error"]
        }
        return Self.decode(object)
    }
}

struct SampleAuth: SessionAuth {
    let hasToken: Bool
    func signIn(label: String) async throws { try await Task.sleep(for: .seconds(3600)) }
    func signOut() async -> SignOutResult { .revoked }
}

struct SampleProbe: ServerProbe {
    let result: ServerProbeResult
    func probe(_ origin: ServerOrigin) async -> ServerProbeResult { result }
}

final class SampleSettings: SettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String?) { self.value = value }
    func serverURL() -> String? { lock.withLock { value } }
    func setServerURL(_ value: String?) { lock.withLock { self.value = value } }
}

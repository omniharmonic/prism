import Foundation
import OmniClient
@testable import OmniCore
import PrismAuth
import PrismTransport

/// A gateway that lives in memory and answers with made-up data, shaped exactly as the
/// real one answers (everything is built as the gateway's JSON and decoded). The Mac
/// snapshots are rendered from it: no server, no vault, nothing private in a picture.
class SampleService: OmniService, @unchecked Sendable {
    private let lock = NSLock()
    private var threadRows: [[String: Any]] = []
    private var details: [String: [String: Any]] = [:]
    private var approvalRows: [[String: Any]] = []
    private var jobRows: [[String: Any]] = []
    private var liveStreams: [String: [OmniStreamEnvelope]] = [:]

    var createDelay: Duration = .zero
    var completeStreamOnResult = false
    var createdVoiceThreadID: String?
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
    func addThread(_ id: String, _ title: String, state: String = "done", preview: String? = nil, unread: Int = 0, gone: Bool = false, waitingOn: String? = nil, messages: [(String, String)] = [], tools: [String] = [], cards: [[String: Any]] = [], approvals: [[String: Any]] = [], itemCards: [OmniCard] = [], live: [OmniStreamEnvelope] = []) -> String {
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
            details[id] = ["thread": row, "messages": stored, "cards": cards, "itemCards": (try? JSONSerialization.jsonObject(with: PrismJSON.encoder().encode(itemCards))) ?? [], "approvals": approvals, "activeTurnId": state == "working" ? "turn-\(id)" : NSNull()]
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

    func createThread(_ new: NewThread) async throws -> CreatedThread {
        if createDelay != .zero { try await Task.sleep(for: createDelay) }
        guard let id = createdVoiceThreadID,
              let row = lock.withLock({ threadRows.first { $0["id"] as? String == id } }) else {
            throw PrismError.invalidRequest("sample")
        }
        return Self.decode(["thread": row, "turnId": "turn-\(id)"])
    }

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
        let events = lock.withLock { () -> [OmniStreamEnvelope] in
            let events = liveStreams[threadID] ?? []
            if completeStreamOnResult, var detail = details[threadID], var row = detail["thread"] as? [String: Any] {
                row["state"] = "done"; row["running"] = false
                detail["thread"] = row; detail["activeTurnId"] = NSNull()
                details[threadID] = detail
                if let index = threadRows.firstIndex(where: { $0["id"] as? String == threadID }) { threadRows[index] = row }
            }
            return events
        }
        return AsyncThrowingStream { continuation in
            continuation.yield(.connected)
            for event in events { continuation.yield(.event(event)) }
            if events.isEmpty || completeStreamOnResult { continuation.finish() }
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

/// The sample gateway with the nudge queue switched on (Needs you then shows its nudge cards).
final class NudgingSampleService: SampleService, NudgeService, @unchecked Sendable {
    var nudgeItems: [OmniNudge] = []
    var laterItems: [OmniNudge] = []
    var audit: NudgeWeeklyAudit?

    /// A nudge as the gateway sends it.
    static func nudge(_ id: String, kind: String, title: String, summary: String, reasons: [String], threadId: String? = nil) -> OmniNudge {
        var object: [String: Any] = [
            "id": id, "updatedAt": 1_760_000_000_000.0, "score": 0.7, "surfaces": 0, "dismissed": false,
            "sourceLink": "https://prism.example.com/page/\(id)",
            "candidate": ["sourceId": "source-\(id)", "sourcePath": "notes/\(id)", "kind": kind, "title": title, "summary": summary, "reasons": reasons],
        ]
        if let threadId { object["threadId"] = threadId }
        return decode(object)
    }

    func nudges(later: Bool) async throws -> [OmniNudge] { later ? laterItems : nudgeItems }
    func nudgeWeeklyAudit() async throws -> NudgeWeeklyAudit? { audit }
    func nudgeSettings() async throws -> NudgeSettings { NudgeSettings() }
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { settings }
    func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge {
        guard let item = nudgeItems.first(where: { $0.id == id }) else { throw PrismError.invalidRequest("sample") }
        return item
    }
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted { throw PrismError.invalidRequest("sample") }
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

/// The sample gateway with item cards (Needs you's three sections, cards inline in a thread).
/// Every name, address and date is made up.
final class CardingSampleService: SampleService, CardService, @unchecked Sendable {
    var cardItems: [OmniCard] = []

    static let t0 = Date(timeIntervalSince1970: 1_792_080_000)
    static let replyDraft = OmniCard.Draft(kind: .emailReply, payload: ["noteId": "01JEXAMPLE0000000000000002", "expectTo": ["sam@example.com"], "body": "Hi Sam,\n\nThursday afternoon works. I'll go through the budget sheet and send comments by 4.\n\nBenjamin"])

    static func proposed() -> OmniCard {
        OmniCard(id: "card-budget", sourceKey: "01JEXAMPLE0000000000000002", kind: .email, state: .proposed,
                 headline: "Sam asks whether you can review the grant budget before Friday",
                 context: [.init(text: "You're free Thu 2–4", source: "calendar"), .init(text: "Grant due Fri 5pm", source: "01JPROJECT"), .init(text: "Last talked Oct 2", source: "01JPERSON")],
                 ask: "Review the budget sheet and reply with comments", urgency: .today,
                 options: [
                    .init(id: "yes-thu", label: "Say yes, Thursday afternoon", plan: "Reply confirming Thursday afternoon", produces: ["email-reply"], draft: replyDraft),
                    .init(id: "monday", label: "Ask to push to Monday", plan: "Reply proposing Monday", produces: ["email-reply"], draft: nil),
                    .init(id: "kevin", label: "Hand to Kevin", plan: "Forward to Kevin with a note", produces: ["email"], draft: nil),
                 ],
                 recommended: "yes-thu", itemRefs: ["01JEXAMPLE0000000000000002"], threadId: "card-thread",
                 createdAt: t0.addingTimeInterval(-7_200), updatedAt: t0, section: .decide)
    }
    static func draftReady() -> OmniCard {
        OmniCard(id: "card-ready", sourceKey: "01JEXAMPLE0000000000000003", kind: .email, state: .draftReady, headline: "Dana asked whether Friday at ten works for the spec review",
                 context: [.init(text: "Friday 10–11 is free", source: "calendar")], urgency: .thisWeek,
                 options: [.init(id: "yes", label: "Say yes", plan: "Confirm Friday at ten", produces: ["email-reply"], draft: replyDraft), .init(id: "later", label: "Ask for the afternoon", plan: "Propose 2pm", produces: ["email-reply"], draft: nil)],
                 recommended: "yes", itemRefs: ["01JEXAMPLE0000000000000003"], threadId: "card-thread", approvalIds: ["apr-card"], chosenOptionId: "yes",
                 createdAt: t0.addingTimeInterval(-3_600), updatedAt: t0, section: .approve)
    }
    static func invite() -> OmniCard {
        OmniCard(id: "card-invite", sourceKey: "01JEXAMPLE0000000000000004", kind: .invite, state: .proposed, headline: "Ana invited you to the retreat planning call on Tuesday at 3",
                 context: [.init(text: "Tuesday 3–4 clashes with the hardware sync", source: "calendar")], urgency: .thisWeek,
                 options: [
                    .init(id: "accept", label: "Accept", plan: "RSVP yes", produces: ["calendar-rsvp"], draft: .init(kind: .calendarRSVP, payload: ["eventId": "evt_example_1", "response": "accepted"])),
                    .init(id: "later-week", label: "Ask Ana for Thursday", plan: "Message Ana proposing Thursday", produces: ["message"], draft: nil),
                 ],
                 recommended: "accept", itemRefs: ["01JEXAMPLE0000000000000004"], threadId: "card-thread-2", createdAt: t0.addingTimeInterval(-86_400), updatedAt: t0, section: .decide)
    }
    static func task() -> OmniCard {
        OmniCard(id: "card-task", sourceKey: "01JEXAMPLE0000000000000005", kind: .task, state: .proposed, headline: "Renewing the domain is due tomorrow",
                 context: [.init(text: "Card on file expires this month", source: "01JEXAMPLE0000000000000005")], urgency: .whenever,
                 options: [.init(id: "friday", label: "Do it Friday morning", plan: "Add a task for Friday 9am", produces: ["task"], draft: nil), .init(id: "kevin", label: "Ask Kevin to renew it", plan: "Message Kevin", produces: ["message"], draft: nil)],
                 recommended: nil, itemRefs: ["01JEXAMPLE0000000000000005"], threadId: "card-thread-3", createdAt: t0.addingTimeInterval(-172_800), updatedAt: t0, section: .decide)
    }
    static func working() -> OmniCard { proposed().with(state: .working, chosenOptionId: "monday", section: .motion) }
    static func waiting() -> OmniCard {
        let c = invite().with(state: .waiting, chosenOptionId: "later-week", section: .motion)
        return OmniCard(id: "card-waiting", sourceKey: c.sourceKey, kind: c.kind, state: c.state, headline: "Scheduling with Ana — waiting on her reply since Tuesday", context: c.context, urgency: c.urgency, options: c.options, recommended: c.recommended, itemRefs: c.itemRefs, threadId: c.threadId, chosenOptionId: c.chosenOptionId, createdAt: c.createdAt, updatedAt: c.updatedAt, section: .motion)
    }
    static func sent() -> OmniCard { draftReady().with(state: .sent, chosenOptionId: "yes", section: nil) }
    static func transitional() -> OmniCard {
        OmniCard(id: "nud-sample", sourceKey: "01JEXAMPLE0000000000000006", kind: .message, state: .proposed, headline: "Kevin is waiting for an answer about the mooring quote",
                 context: [.init(text: "He asked in the hardware room yesterday.", source: nil)], urgency: .thisWeek, itemRefs: ["01JEXAMPLE0000000000000006"],
                 createdAt: t0.addingTimeInterval(-5_400), updatedAt: t0, section: .decide, transitional: true, nudgeId: "nud-sample")
    }
    /// Review Focus 4: a 160-character headline, four 200-character facts, four 80-character options.
    static func long() -> OmniCard {
        let fact = String(repeating: "The venue needs a final head count, the catering order and the deposit before the holiday weekend. ", count: 2).prefix(200)
        return OmniCard(id: "card-long", sourceKey: "01JEXAMPLE0000000000000007", kind: .email, state: .proposed,
                        headline: String("The retreat venue wants the final head count, the dietary list, the room plan and the deposit confirmed before the long weekend, and asks about parking".prefix(160)),
                        context: (0..<4).map { _ in .init(text: String(fact), source: "calendar") }, ask: "Confirm the numbers or ask for more time", urgency: .today,
                        options: (1...4).map { i in .init(id: "o\(i)", label: String("Option \(i): reply with the numbers we have and promise the rest by Thursday noon, sorry".prefix(80)), plan: "Reply", produces: ["email-reply"], draft: i == 1 ? replyDraft : nil) },
                        recommended: "o1", itemRefs: ["01JEXAMPLE0000000000000007"], threadId: "card-thread", createdAt: t0.addingTimeInterval(-600), updatedAt: t0, section: .decide)
    }
    static func gallery() -> [(String, OmniCard)] {
        [("proposed", proposed()), ("draft-ready", draftReady()), ("invite", invite()), ("task", task()), ("working", working()), ("waiting", waiting()), ("sent", sent()), ("transitional", transitional())]
    }
    /// Everything at once, plus the draft's approval and the card thread with a card inline.
    static func carding() -> CardingSampleService {
        let service = CardingSampleService()
        service.addThread("card-thread", "Sam's grant budget", state: "waiting", preview: "I drafted a reply for you to review.",
                          messages: [("assistant", "Sam asked whether you can review the grant budget before Friday. I prepared three ways to answer.")],
                          approvals: [SampleService.draft("apr-card", thread: "card-thread", kind: "email-reply", payload: ["noteId": "01JEXAMPLE0000000000000002", "expectTo": ["sam@example.com"], "body": "Hi Sam,\n\nThursday afternoon works. I'll go through the budget sheet and send comments by 4.\n\nBenjamin"])],
                          itemCards: [proposed()])
        service.cardItems = [proposed(), draftReady(), invite(), task(), working(), waiting(), transitional()]
        return service
    }

    func cards(section: CardSection?) async throws -> CardList {
        if failReads { throw PrismError.unreachable("sample") }
        let open = cardItems.filter { $0.section != nil }
        return CardList(cards: open, counts: .init(decide: open.filter { $0.section == .decide }.count, approve: open.filter { $0.section == .approve }.count, motion: open.filter { $0.section == .motion }.count))
    }
    func card(_ id: String) async throws -> OmniCard {
        if failReads { throw PrismError.unreachable("sample") }
        guard let found = cardItems.first(where: { $0.id == id }) else { throw PrismError.invalidRequest("sample") }
        return found
    }
    func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult { throw PrismError.invalidRequest("sample") }
    func instructCard(_ id: String, text: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult { throw PrismError.invalidRequest("sample") }
    func snoozeCard(_ id: String, until: Date) async throws -> OmniCard { throw PrismError.invalidRequest("sample") }
    func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard { throw PrismError.invalidRequest("sample") }
}

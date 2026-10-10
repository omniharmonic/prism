import Foundation
import OmniClient
import PrismAuth
import PrismSSE
import PrismTestSupport
import PrismTransport
import XCTest

/// A small in-memory imitation of the gateway's approval rules (docs/omni-module.md
/// § Approvals, `routes/omni.ts` `decide`): digest check, idempotent replay, one execution.
final class FakeApprovalGate: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var status = "pending"
    private(set) var decidedKey: String?
    private(set) var executions = 0
    let id = "apr_0123456789abcdef01234567"
    let kind = "email"
    let payload: JSONValue = ["to": ["kevin@example.com"], "subject": "Buoy spec", "body": "Hi Kevin,\n\nHere is the spec.\n\nBenjamin"]
    var digest: String { ApprovalDigest.digest(kind: kind, payload: payload) }
    var executorEnabled = true
    var outcome = "sent"

    func approvalJSON(status: String? = nil, digest: String? = nil) -> String {
        let wire: JSONValue = [
            "id": .string(id), "threadId": "omni_abc", "kind": .string(kind), "payload": payload, "digest": .string(digest ?? self.digest), "summary": "Email Kevin",
            "status": .string(status ?? self.status), "createdAt": "2026-10-08T15:04:00.000Z", "expiresAt": "2026-10-09T15:04:00.000Z", "decidedAt": nil,
            "result": nil, "supersededBy": nil, "revises": nil, "executor": ["name": "proton-send", "available": true, "enabled": .bool(executorEnabled)],
        ]
        return String(decoding: try! PrismJSON.encoder().encode(wire), as: UTF8.self)
    }

    func decide(_ r: SeenRequest) -> StubAnswer {
        lock.lock()
        defer { lock.unlock() }
        guard let key = r.header("Idempotency-Key"), key.count >= 8 else { return .json(400, #"{"error":"bad_request","detail":"Idempotency-Key header"}"#) }
        guard let body = try? JSONDecoder().decode(JSONValue.self, from: r.body), let decision = body["decision"]?.stringValue, let digest = body["digest"]?.stringValue else {
            return .json(400, #"{"error":"bad_request"}"#)
        }
        if status != "pending" {
            if decidedKey == key { return .json(200, #"{"approval":\#(approvalJSON())}"#, headers: ["Idempotent-Replayed": "true"]) }
            return .json(409, #"{"error":"\#(status == "approved" ? "in_progress" : "already_decided")","status":"\#(status)"}"#)
        }
        if digest != self.digest { return .json(409, #"{"error":"digest_mismatch","detail":"the draft changed since it was shown — review it again"}"#) }
        if decision == "cancel" {
            status = "cancelled"
            decidedKey = key
            return .json(200, #"{"approval":\#(approvalJSON()),"turnId":null}"#)
        }
        if decision == "revise" {
            status = "revised"
            decidedKey = key
            return .json(200, #"{"approval":\#(approvalJSON()),"turnId":"turn_rev1"}"#)
        }
        if !executorEnabled { return .json(503, #"{"error":"executor_disabled","executor":"proton-send","detail":"switched off"}"#) }
        executions += 1
        status = outcome
        decidedKey = key
        return .json(outcome == "sent" ? 200 : outcome == "failed" ? 422 : 502, #"{"approval":\#(approvalJSON())}"#)
    }
}

final class OmniClientTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (OmniClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (OmniClient(transport: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    let threadJSON = #"{"id":"omni_abc","title":"Call Dana","state":"working","objective":null,"taskNoteId":null,"lastActivityAt":"2026-10-08T15:04:00.000Z","unread":0,"pinned":false,"archived":false,"nextCheckAt":null,"waitingOn":null,"model":null,"preview":null,"messageCount":null,"running":true,"lastSeq":1,"source":"text"}"#

    // MARK: version / threads / turns

    func testVersion() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"api":1,"minClient":"1.0"}"#) }
        let v = try await omni.version()
        XCTAssertEqual(v, try PrismJSON.decoder().decode(OmniVersion.self, from: Data(#"{"api":1,"minClient":"1.0"}"#.utf8)))
        XCTAssertEqual(server.requests[0].method, "GET")
        XCTAssertEqual(server.requests[0].path, "/api/omni/version")
    }

    func testDisabledModuleAndNonOwnerAreTypedErrors() async throws {
        let (off, _) = try make { _ in .json(404, #"{"error":"not_found"}"#) }
        do { _ = try await off.version(); XCTFail() } catch { XCTAssertEqual((error as? PrismError)?.serverCode, "not_found") }
        let (other, _) = try make { _ in .json(403, #"{"error":"forbidden"}"#) }
        do { _ = try await other.threads(); XCTFail() } catch {
            guard case PrismError.forbidden = error else { return XCTFail("\(error)") }
        }
    }

    func testThreadListQuery() async throws {
        let json = threadJSON
        let (omni, server) = try make { _ in .json(200, #"{"threads":[\#(json)],"next":null,"hermes":"unavailable"}"#) }
        let list = try await omni.threads(states: [.working, .needsYou], search: "dana & co", includeArchived: true)
        XCTAssertEqual(list.threads.map(\.id), ["omni_abc"])
        XCTAssertFalse(list.hermesAvailable)
        XCTAssertEqual(server.requests[0].query, ["state": "working,needs-you", "q": "dana & co", "archived": "1"])
        _ = try await omni.threads()
        XCTAssertEqual(server.requests[1].url.absoluteString, "https://prism.example.com/api/omni/threads")
    }

    func testCreateReadAndPatchThread() async throws {
        let json = threadJSON
        let (omni, server) = try make { r in
            switch (r.method, r.path) {
            case ("POST", "/api/omni/threads"): return .json(201, #"{"thread":\#(json),"turnId":"turn_1"}"#)
            case ("GET", "/api/omni/threads/omni_abc"): return .json(200, #"{"thread":\#(json),"messages":[],"cards":[],"approvals":[],"activeTurnId":"turn_1"}"#)
            case ("PATCH", "/api/omni/threads/omni_abc"): return .json(200, #"{"thread":\#(json)}"#)
            default: return .json(404, "{}")
            }
        }
        let created = try await omni.createThread(NewThread(prompt: "Call Dana Friday", noteIds: ["01JNOTE"], source: "text"))
        XCTAssertEqual(created.turnId, "turn_1")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: server.requests[0].body), ["prompt": "Call Dana Friday", "noteIds": ["01JNOTE"], "source": "text"])
        let detail = try await omni.thread("omni_abc")
        XCTAssertEqual(detail.activeTurnId, "turn_1")
        let patched = try await omni.updateThread("omni_abc", ThreadPatch(archived: true))
        XCTAssertEqual(patched.id, "omni_abc")
        XCTAssertEqual(server.requests[2].bodyString, #"{"archived":true}"#)
        XCTAssertEqual(server.requests[2].header("Content-Type"), "application/json")
    }

    func testIdsThatCouldReshapeThePathAreRefusedLocally() async throws {
        let (omni, server) = try make { _ in .json(200, "{}") }
        for bad in ["", "..", "a/b", "a?b", "a b", "omni_abc/../../auth/me", "a%2Fb", String(repeating: "x", count: 201)] {
            do {
                _ = try await omni.thread(bad)
                XCTFail("accepted \(bad)")
            } catch {
                XCTAssertEqual(error as? PrismError, .invalidRequest("id refused"), bad)
            }
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testStartTurnOutcomes() async throws {
        let (omni, server) = try make { r in
            switch r.header("Idempotency-Key") {
            case "key-new-0001": return .json(202, #"{"turnId":"turn_1","status":"running"}"#)
            case "key-replay-01": return .json(200, #"{"turnId":"turn_1","status":"done"}"#, headers: ["Idempotent-Replayed": "true"])
            default: return .json(409, #"{"error":"conflict","detail":"a turn is already running","turnId":"turn_9"}"#)
            }
        }
        var out = try await omni.startTurn(threadID: "omni_abc", text: "and email her", noteIDs: ["01J"], idempotencyKey: IdempotencyKey("key-new-0001"))
        XCTAssertEqual(out, .started(turnId: "turn_1"))
        out = try await omni.startTurn(threadID: "omni_abc", text: "and email her", idempotencyKey: IdempotencyKey("key-replay-01"))
        XCTAssertEqual(out, .replayed(turnId: "turn_1", status: "done"))
        out = try await omni.startTurn(threadID: "omni_abc", text: "another")
        XCTAssertEqual(out, .alreadyRunning(turnId: "turn_9"))
        XCTAssertEqual(out.turnId, "turn_9")
        XCTAssertEqual(server.requests[0].path, "/api/omni/threads/omni_abc/turns")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: server.requests[0].body), ["text": "and email her", "noteIds": ["01J"]])
        XCTAssertEqual(server.requests[1].bodyString, #"{"text":"and email her"}"#)
        XCTAssertNil(server.requests[2].header("Idempotency-Key"))
    }

    func testCancelTurn() async throws {
        let (omni, server) = try make { _ in .json(202, #"{"turnId":"turn_1","status":"cancelling"}"#) }
        let c = try await omni.cancelTurn("turn_1")
        XCTAssertEqual(c.status, "cancelling")
        XCTAssertEqual(server.requests[0].path, "/api/omni/turns/turn_1/cancel")
        XCTAssertEqual(server.requests[0].bodyString, "{}")
    }

    // MARK: approvals

    func testApprovalsListAndRead() async throws {
        let gate = FakeApprovalGate()
        let (omni, server) = try make { r in
            r.path == "/api/omni/approvals" ? .json(200, #"{"approvals":[\#(gate.approvalJSON())]}"#) : .json(200, #"{"approval":\#(gate.approvalJSON())}"#)
        }
        let pending = try await omni.approvals()
        XCTAssertEqual(server.requests[0].query, ["status": "pending"])
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].payload["to"]?.stringArrayValue, ["kevin@example.com"])
        XCTAssertTrue(pending[0].digestMatchesPayload)
        _ = try await omni.approvals(status: nil)
        XCTAssertEqual(server.requests[1].query, [:])
        let one = try await omni.approval(gate.id)
        XCTAssertEqual(one.id, gate.id)
        XCTAssertEqual(server.requests[2].path, "/api/omni/approvals/\(gate.id)")
    }

    func testDecideSendsTheDigestShownAndReplaysIdempotently() async throws {
        let gate = FakeApprovalGate()
        let (omni, server) = try make { r in r.path.hasSuffix("/decision") ? gate.decide(r) : .json(200, #"{"approval":\#(gate.approvalJSON())}"#) }
        let shown = try await omni.approval(gate.id)
        let key = IdempotencyKey.random()

        let first = try await omni.decide(shown: shown, .send, idempotencyKey: key)
        XCTAssertEqual(first.approval.status, .sent)
        XCTAssertFalse(first.replayed)
        XCTAssertEqual(first.httpStatus, 200)
        let sent = server.requests[1]
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/omni/approvals/\(gate.id)/decision")
        XCTAssertEqual(sent.header("Idempotency-Key"), key.value)
        XCTAssertNil(sent.header("X-Prism-Action-Origin"))
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: sent.body), ["decision": "send", "digest": .string(shown.digest)])

        // The answer was lost (or the person tapped twice): the SAME key replays the stored
        // outcome — the server executes nothing again.
        let again = try await omni.decide(shown: shown, .send, idempotencyKey: key)
        XCTAssertTrue(again.replayed)
        XCTAssertEqual(again.approval.status, .sent)
        XCTAssertEqual(server.requests[2].header("Idempotency-Key"), key.value)
        XCTAssertEqual(server.requests[2].bodyString, sent.bodyString, "a replay is byte-identical")
        XCTAssertEqual(gate.executions, 1)

        // A different key on a decided approval is a conflict, not a second send.
        do {
            _ = try await omni.decide(shown: shown, .send, idempotencyKey: .random())
            XCTFail("expected already_decided")
        } catch {
            guard case PrismError.conflict(let f) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(f.code, "already_decided")
        }
        XCTAssertEqual(gate.executions, 1)
    }

    func testDecideAfterAnUnknownTransportOutcomeIsSafeToRetryWithTheSameKey() async throws {
        let gate = FakeApprovalGate()
        let calls = Counter()
        let (omni, _) = try make { r in
            guard r.path.hasSuffix("/decision") else { return .json(200, #"{"approval":\#(gate.approvalJSON())}"#) }
            calls.increment()
            let answer = gate.decide(r) // the server acts…
            return calls.value == 1 ? .failure(.networkConnectionLost) : answer // …but the first answer never arrives
        }
        let shown = try await omni.approval(gate.id)
        let key = IdempotencyKey.random()
        do {
            _ = try await omni.decide(shown: shown, .send, idempotencyKey: key)
            XCTFail("expected outcome-unknown")
        } catch {
            guard case PrismError.outcomeUnknown = error else { return XCTFail("\(error)") }
        }
        let retry = try await omni.decide(shown: shown, .send, idempotencyKey: key)
        XCTAssertTrue(retry.replayed)
        XCTAssertEqual(retry.approval.status, .sent)
        XCTAssertEqual(gate.executions, 1, "one send, however many times the same key is presented")
    }

    func testAStaleDraftIsRefusedByTheServerAndATamperedOneLocally() async throws {
        let gate = FakeApprovalGate()
        let stale = String(repeating: "0", count: 64)
        let (omni, server) = try make { r in
            if r.path.hasSuffix("/decision") { return gate.decide(r) }
            // The screen holds a draft whose (self-consistent) digest the server has since replaced.
            return .json(200, #"{"approval":\#(gate.approvalJSON())}"#)
        }
        let current = try await omni.approval(gate.id)

        // (a) What is on screen does not hash to the digest it carries: refused before any request.
        let tamperedJSON = gate.approvalJSON(digest: stale)
        let tampered = try PrismJSON.decoder().decode(Approval.self, from: Data(tamperedJSON.utf8))
        XCTAssertFalse(tampered.digestMatchesPayload)
        let before = server.requests.count
        do {
            _ = try await omni.decide(shown: tampered, .send, idempotencyKey: .random())
            XCTFail("expected a local refusal")
        } catch {
            XCTAssertEqual(error as? OmniError, .localDigestMismatch(approvalId: gate.id))
        }
        XCTAssertEqual(server.requests.count, before, "nothing was sent")

        // (b) A self-consistent but OLD draft (edited on the server since): digest_mismatch.
        let oldPayload: JSONValue = ["to": ["kevin@example.com"], "subject": "Buoy spec", "body": "an earlier draft"]
        var oldWire = try JSONDecoder().decode(JSONValue.self, from: Data(gate.approvalJSON().utf8)).objectValue!
        oldWire["payload"] = oldPayload
        oldWire["digest"] = .string(ApprovalDigest.digest(kind: "email", payload: oldPayload))
        let old = try PrismJSON.decoder().decode(Approval.self, from: PrismJSON.encoder().encode(JSONValue.object(oldWire)))
        XCTAssertTrue(old.digestMatchesPayload)
        do {
            _ = try await omni.decide(shown: old, .send, idempotencyKey: .random())
            XCTFail("expected digest_mismatch")
        } catch {
            XCTAssertEqual((error as? PrismError)?.serverCode, "digest_mismatch")
        }
        XCTAssertEqual(gate.executions, 0)
        XCTAssertEqual(gate.status, "pending")
        _ = current
    }

    func testDecideOutcomes() async throws {
        // failed (422) and unknown (502) both carry the approval; neither throws.
        for (outcome, http, status) in [("failed", 422, ApprovalStatus.failed), ("unknown", 502, ApprovalStatus.unknown)] {
            let gate = FakeApprovalGate()
            gate.outcome = outcome
            let (omni, _) = try make { r in r.path.hasSuffix("/decision") ? gate.decide(r) : .json(200, #"{"approval":\#(gate.approvalJSON())}"#) }
            let d = try await omni.decide(shown: try await omni.approval(gate.id), .send, idempotencyKey: .random())
            XCTAssertEqual(d.approval.status, status)
            XCTAssertEqual(d.httpStatus, http)
        }
        // A switched-off executor: nothing executed, the approval stays pending.
        let off = FakeApprovalGate()
        off.executorEnabled = false
        let (omniOff, _) = try make { r in r.path.hasSuffix("/decision") ? off.decide(r) : .json(200, #"{"approval":\#(off.approvalJSON())}"#) }
        do {
            _ = try await omniOff.decide(shown: try await omniOff.approval(off.id), .send, idempotencyKey: .random())
            XCTFail("expected executor_disabled")
        } catch {
            XCTAssertEqual(error as? OmniError, .executorNotReady(code: "executor_disabled", executor: "proton-send"))
        }
        XCTAssertEqual(off.status, "pending")
        // cancel, and revise with feedback (a new turn).
        let c = FakeApprovalGate()
        let (omniC, serverC) = try make { r in r.path.hasSuffix("/decision") ? c.decide(r) : .json(200, #"{"approval":\#(c.approvalJSON())}"#) }
        let cancelled = try await omniC.decide(shown: try await omniC.approval(c.id), .cancel, idempotencyKey: .random())
        XCTAssertEqual(cancelled.approval.status, .cancelled)
        XCTAssertNil(cancelled.turnId)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: serverC.requests[1].body)["decision"], "cancel")
        let rv = FakeApprovalGate()
        let (omniR, serverR) = try make { r in r.path.hasSuffix("/decision") ? rv.decide(r) : .json(200, #"{"approval":\#(rv.approvalJSON())}"#) }
        let revised = try await omniR.decide(shown: try await omniR.approval(rv.id), .revise, feedback: "shorter", idempotencyKey: .random())
        XCTAssertEqual(revised.approval.status, .revised)
        XCTAssertEqual(revised.turnId, "turn_rev1")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: serverR.requests[1].body)["feedback"], "shorter")
        // Other refusals keep their server code.
        for (status, code) in [(410, "expired"), (403, "human_origin_required"), (502, "hermes_unavailable")] {
            let g = FakeApprovalGate()
            let (o, _) = try make { r in r.path.hasSuffix("/decision") ? .json(status, #"{"error":"\#(code)"}"#) : .json(200, #"{"approval":\#(g.approvalJSON())}"#) }
            do {
                _ = try await o.decide(shown: try await o.approval(g.id), .send, idempotencyKey: .random())
                XCTFail("expected \(code)")
            } catch {
                XCTAssertEqual((error as? PrismError)?.serverCode, code)
            }
        }
    }

    func testEditApproval() async throws {
        let gate = FakeApprovalGate()
        let (omni, server) = try make { r in
            r.method == "PUT" ? .json(201, #"{"approval":\#(gate.approvalJSON()),"replaced":"apr_old"}"#) : .json(200, #"{"approval":\#(gate.approvalJSON())}"#)
        }
        let shown = try await omni.approval(gate.id)
        let edit = try await omni.editApproval(shown: shown, payload: ["to": ["kevin@example.com"], "subject": "Buoy spec v2", "body": "new"])
        XCTAssertEqual(edit.replaced, "apr_old")
        let body = try JSONDecoder().decode(JSONValue.self, from: server.requests[1].body)
        XCTAssertEqual(body["digest"]?.stringValue, shown.digest, "the digest of the draft that was edited")
        XCTAssertEqual(body["payload"]?["subject"], "Buoy spec v2")
        XCTAssertEqual(server.requests[1].path, "/api/omni/approvals/\(gate.id)")
    }

    // MARK: jobs / today

    func testJobs() async throws {
        let job = #"{"id":"0123456789ab","name":"brief","schedule":"0 7 * * *","enabled":true}"#
        let (omni, server) = try make { r in
            r.method == "GET" ? .json(200, #"{"jobs":[\#(job)]}"#) : .json(r.path == "/api/omni/jobs" ? 201 : 200, #"{"job":\#(job)}"#)
        }
        let jobs = try await omni.jobs()
        XCTAssertEqual(jobs.map(\.id), ["0123456789ab"])
        _ = try await omni.createJob(NewJob(name: "brief", schedule: "0 7 * * *", prompt: "morning brief"))
        for action in [JobAction.pause, .resume, .run] { _ = try await omni.job("0123456789ab", action) }
        XCTAssertEqual(server.requests.map { "\($0.method) \($0.path)" }, [
            "GET /api/omni/jobs", "POST /api/omni/jobs", "POST /api/omni/jobs/0123456789ab/pause", "POST /api/omni/jobs/0123456789ab/resume", "POST /api/omni/jobs/0123456789ab/run",
        ])
        XCTAssertEqual(server.requests[2].bodyString, "{}")
    }

    func testTodaySendsThePersonsDate() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"date":"2026-10-08","agenda":[],"tasks":[],"taskIdentity":"unset","needsYou":{"approvals":[],"nudges":[]},"inFlight":[],"openLoops":null,"brief":null,"errors":{}}"#) }
        var denver = Calendar(identifier: .gregorian)
        denver.timeZone = TimeZone(identifier: "America/Denver")!
        // 2026-10-09 03:30 UTC is still the 8th in Denver.
        let now = try XCTUnwrap(PrismJSON.parseDate("2026-10-09T03:30:00Z"))
        let today = try await omni.today(now, calendar: denver)
        XCTAssertEqual(today.date, "2026-10-08")
        XCTAssertEqual(server.requests[0].query, ["date": "2026-10-08"])
        _ = try await omni.today(date: "2026-01-02")
        XCTAssertEqual(server.requests[1].query, ["date": "2026-01-02"])
    }

    func testTasksUsesOnlyOpaqueCursorAndDecodesPaginationLimits() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"tasks":[{"noteId":"task1","title":"Task"}],"next":"nextPage","total":51,"limited":true,"truncated":false,"identity":"person"}"#) }
        let page = try await omni.tasks(cursor: "cursor+/=")
        XCTAssertEqual(server.requests[0].query, ["cursor": "cursor+/="])
        XCTAssertEqual(page.next, "nextPage"); XCTAssertEqual(page.total, 51)
        XCTAssertTrue(page.limited); XCTAssertFalse(page.truncated)
        XCTAssertEqual(page.tasks.first?.noteId, "task1")
        _ = try await omni.tasks()
        XCTAssertEqual(server.requests[1].query, [:])
    }

    // MARK: streams (over the stubbed URL loading system)

    func testThreadStreamReplaysResumesAndFoldsDeltas() async throws {
        let (omni, server) = try make { r in
            switch r.query["after"] {
            case "0":
                // Persisted 1–2, a live delta, then the connection is lost mid-turn.
                return .response(status: 200, headers: ["Content-Type": "text/event-stream"], chunks: [
                    Data("event: status\ndata: {\"seq\":1,\"turnId\":\"turn_1\",\"t\":\"status\",\"state\":\"working\"}\nid: 1\n\n".utf8),
                    Data("event: init\r\ndata: {\"seq\":2,\"turnId\":\"turn_1\",\"t\":\"init\",\"runId\":\"run_1\"}\r\nid: 2\r\n\r\n: ping\n\n".utf8),
                    Data("event: text_delta\ndata: {\"turnId\":\"turn_1\",\"t\":\"text_delta\",\"blockId\":\"turn_1:b0\",\"text\":\"Hel\"}\n\nevent: text_delta\ndata: {\"turnId\":\"turn_1\",\"t\":\"text_del".utf8),
                ])
            case "2":
                // The replay after seq 2: the final text REPLACES the deltas; then the turn ends.
                return .sse([
                    "event: text\ndata: {\"seq\":3,\"turnId\":\"turn_1\",\"t\":\"text\",\"blockId\":\"turn_1:b0\",\"text\":\"Hello world.\"}\nid: 3\n\n",
                    "event: result\ndata: {\"seq\":4,\"turnId\":\"turn_1\",\"t\":\"result\",\"ok\":true,\"durationMs\":1200}\nid: 4\n\n",
                    "event: status\ndata: {\"seq\":5,\"turnId\":\"turn_1\",\"t\":\"status\",\"state\":\"done\"}\nid: 5\n\n",
                ])
            default:
                return .json(404, #"{"error":"not_found"}"#)
            }
        }
        // The first response ends after its chunks; the stream treats that clean end as final
        // (reconnectOnEnd is false for a thread), so drive the "lost connection" explicitly:
        // attach, fold, then re-attach from the transcript's cursor as the app does.
        var transcript = TurnTranscript()
        var updates: [ThreadStreamUpdate] = []
        for try await u in omni.threadStream(threadID: "omni_abc", policy: SSERetryPolicy(initialDelay: .milliseconds(1), jitter: 0)) {
            updates.append(u)
            if case .event(let e) = u { transcript.apply(e) }
        }
        XCTAssertEqual(updates.first, .connected)
        XCTAssertEqual(transcript.lastSeq, 2)
        XCTAssertEqual(transcript.items, [.text(blockId: "turn_1:b0", text: "Hel", isFinal: false)], "the half-received delta is not shown")
        XCTAssertNil(transcript.result)

        for try await u in omni.threadStream(threadID: "omni_abc", after: transcript.lastSeq) {
            if case .event(let e) = u { transcript.apply(e) }
        }
        XCTAssertEqual(transcript.items, [.text(blockId: "turn_1:b0", text: "Hello world.", isFinal: true)])
        XCTAssertEqual(transcript.result?.ok, true)
        XCTAssertEqual(transcript.state, .done)
        XCTAssertEqual(transcript.lastSeq, 5)

        XCTAssertEqual(server.requests.map(\.path), ["/api/omni/threads/omni_abc/stream", "/api/omni/threads/omni_abc/stream"])
        XCTAssertEqual(server.requests[0].header("Accept"), "text/event-stream")
        XCTAssertEqual(server.requests[0].header("Authorization"), "Bearer \(TestTokens.device)")
        XCTAssertNil(server.requests[0].header("Last-Event-ID"))
        XCTAssertEqual(server.requests[1].query["after"], "2")
        XCTAssertEqual(server.requests[1].header("Last-Event-ID"), "2")
    }

    func testThreadStreamReconnectsAfterADropWithLastEventID() async throws {
        let attempts = Counter()
        let (omni, server) = try make { r in
            attempts.increment()
            switch attempts.value {
            case 1: return .failure(.networkConnectionLost)
            case 2: return .json(502, #"{"error":"hermes_unavailable"}"#)
            default:
                return .sse(["event: status\ndata: {\"seq\":8,\"turnId\":\"turn_1\",\"t\":\"status\",\"state\":\"done\"}\nid: 8\n\n"])
            }
        }
        var events: [OmniStreamEnvelope] = []
        var reconnects = 0
        for try await u in omni.threadStream(threadID: "omni_abc", after: 7, policy: SSERetryPolicy(initialDelay: .milliseconds(1), jitter: 0)) {
            switch u {
            case .event(let e): events.append(e)
            case .reconnecting: reconnects += 1
            case .connected: break
            }
        }
        XCTAssertEqual(reconnects, 2)
        XCTAssertEqual(events, [OmniStreamEnvelope(seq: 8, turnId: "turn_1", event: .status(state: .done, reason: nil))])
        XCTAssertEqual(server.requests.count, 3)
        for r in server.requests {
            XCTAssertEqual(r.query["after"], "7")
            XCTAssertEqual(r.header("Last-Event-ID"), "7")
        }
    }

    func testThreadStreamFatalErrors() async throws {
        for (answer, check): (StubAnswer, @Sendable (any Error) -> Bool) in [
            (.json(404, #"{"error":"not_found"}"#), { ($0 as? PrismError)?.serverCode == "not_found" }),
            (.json(403, #"{"error":"forbidden"}"#), { if case PrismError.forbidden = $0 { return true } else { return false } }),
            (.redirect(status: 302, to: "https://evil.example.net/s"), { ($0 as? PrismError) == .redirectRefused(status: 302) }),
        ] {
            let (omni, server) = try make { _ in answer }
            do {
                for try await _ in omni.threadStream(threadID: "omni_abc") {}
                XCTFail("expected a fatal error")
            } catch {
                XCTAssertTrue(check(error), "\(error)")
            }
            XCTAssertEqual(server.requests.count, 1, "no retry for a fatal answer")
        }
        // A dead token: the stream ends signed-out and the token is gone.
        let (omni, server) = try make { _ in .json(401, "{}") }
        do {
            for try await _ in omni.threadStream(threadID: "omni_abc") {}
            XCTFail("expected signedOut")
        } catch {
            XCTAssertEqual(error as? PrismError, .signedOut)
        }
        XCTAssertEqual(server.requests.map(\.path), ["/api/omni/threads/omni_abc/stream", "/auth/me"])
    }

    func testNoticesReconnectWhenTheChannelIsRecycled() async throws {
        let attempts = Counter()
        let (omni, server) = try make { _ in
            attempts.increment()
            return attempts.value == 1
                ? .sse([": connected\n\n", "event: thread\ndata: {\"type\":\"thread\",\"id\":\"omni_abc\",\"op\":\"working\"}\n\n"])
                : .sse([": connected\n\nevent: approval\ndata: {\"type\":\"approval\",\"id\":\"apr_1\",\"op\":\"pending\",\"threadId\":\"omni_abc\"}\n\n: ping\n\n"])
        }
        var notices: [OmniNotice] = []
        var connected = 0
        for try await u in omni.notices(policy: SSERetryPolicy(initialDelay: .milliseconds(1), jitter: 0)) {
            if case .connected = u { connected += 1 }
            if case .notice(let n) = u {
                notices.append(n)
                if notices.count == 2 { break }
            }
        }
        XCTAssertEqual(connected, 2)
        XCTAssertEqual(notices.map(\.id), ["omni_abc", "apr_1"])
        XCTAssertEqual(notices[1].threadId, "omni_abc")
        XCTAssertEqual(server.requests.map(\.path), ["/api/omni/events", "/api/omni/events"])
        XCTAssertNil(server.requests[1].header("Last-Event-ID"), "notices have no ids to resume from")
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func increment() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

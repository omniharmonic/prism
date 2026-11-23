import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Omni in Comms (Phase 4): the client's three calls and how it reads their answers.
final class CommsOmniTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    static let digest = ApprovalDigest.digest(kind: "message", payload: .object(["commsThreadId": .string("th_1"), "roomId": .string("!r:x"), "body": .string("Thursday works")]))
    static let state = """
    {"enabled":true,"drafting":false,
     "turn":{"id":"turn_1","kind":"draft","status":"done","startedAt":"2026-11-22T10:00:00.000Z","endedAt":"2026-11-22T10:00:05.000Z","errorCode":null},
     "reply":{"text":"Drafted a reply.","at":"2026-11-22T10:00:05.000Z"},
     "drafts":[
      {"id":"apr_1","threadId":"omni-comms-x","kind":"message","payload":{"commsThreadId":"th_1","roomId":"!r:x","body":"Thursday works"},
       "digest":"\(digest)","summary":"Reply to Alex","status":"pending","createdAt":"2026-11-22T10:00:04.000Z","expiresAt":"2026-11-23T10:00:04.000Z",
       "decidedAt":null,"decidedVia":null,"result":null,"supersededBy":null,"revises":null,"executor":{"name":"comms-send","available":true,"enabled":true},"originalRecipients":null},
      {"id":"apr_bad","kind":42}
     ]}
    """

    func testStateDecodesDraftsAndSkipsUnreadableOnes() async throws {
        let (comms, server) = try make { _ in .json(200, Self.state) }
        let s = try await comms.omni(threadID: "th_1")
        XCTAssertEqual(server.requests[0].path, "/api/comms/threads/th_1/omni")
        XCTAssertEqual(s.turn?.kind, .draft)
        XCTAssertEqual(s.reply?.text, "Drafted a reply.")
        XCTAssertEqual(s.drafts.map(\.id), ["apr_1"], "the unreadable draft is left out")
        let d = try XCTUnwrap(s.pendingDrafts.first)
        XCTAssertTrue(d.digestMatchesPayload, "the digest is the server's own over the exact text")
        XCTAssertEqual(CommsDraft(d), CommsDraft(threadID: "th_1", body: "Thursday works"))
        XCTAssertEqual(d.executor?.name, "comms-send")
    }

    func testAssistPostsInstructionAndPickedMessages() async throws {
        let (comms, server) = try make { _ in .json(202, #"{"omniThreadId":"omni-comms-x","turnId":"turn_2","kind":"draft"}"#) }
        let key = IdempotencyKey("press-0000001")!
        let r = try await comms.assist(threadID: "th_1", instruction: "  Say yes  ", messageIDs: ["$m1"], idempotencyKey: key)
        XCTAssertEqual(r, CommsOmniStart(omniThreadId: "omni-comms-x", turnId: "turn_2", kind: .draft))
        let req = server.requests[0]
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/api/comms/threads/th_1/assist")
        XCTAssertEqual(req.header("Idempotency-Key"), "press-0000001")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: req.body) as? [String: Any])
        XCTAssertEqual(body["instruction"] as? String, "Say yes")
        XCTAssertEqual(body["messageIds"] as? [String], ["$m1"])

        _ = try await comms.catchUp(threadID: "th_1")
        XCTAssertEqual(server.requests[1].path, "/api/comms/threads/th_1/catch-up")
    }

    func testAssistRefusesEmptyLocally() async throws {
        let (comms, server) = try make { _ in .json(202, "{}") }
        do { _ = try await comms.assist(threadID: "th_1", instruction: "   "); XCTFail() } catch {
            guard case CommsOmniError.invalid = error else { return XCTFail("\(error)") }
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testErrorsMapToCommsOmniError() async throws {
        let cases: [(Int, String, CommsOmniError)] = [
            (404, #"{"error":"omni_disabled"}"#, .disabled),
            (409, #"{"error":"busy","turnId":"turn_9"}"#, .busy(turnID: "turn_9")),
            (403, #"{"error":"device_required"}"#, .deviceRequired),
            (429, #"{"error":"rate_limited"}"#, .rateLimited),
            (502, #"{"error":"omni_unavailable"}"#, .unavailable),
        ]
        for (status, body, want) in cases {
            let (comms, _) = try make { _ in .json(status, body) }
            do { _ = try await comms.assist(threadID: "th_1", instruction: "x"); XCTFail("\(status)") } catch {
                XCTAssertEqual(error as? CommsOmniError, want, "\(status)")
            }
        }
    }

    func testCapabilitiesReadOmniFlag() throws {
        let on = try PrismJSON.decoder().decode(CommsCapabilities.self, from: Data(#"{"integration":"comms","clientId":"comms-native","restricted":true,"schemaVersions":[1],"operations":[],"networks":[],"omni":{"enabled":true}}"#.utf8))
        XCTAssertTrue(on.omniEnabled)
        let old = try PrismJSON.decoder().decode(CommsCapabilities.self, from: Data(#"{"integration":"comms","clientId":"comms-native","restricted":true,"schemaVersions":[1],"operations":[],"networks":[]}"#.utf8))
        XCTAssertFalse(old.omniEnabled)
    }
}

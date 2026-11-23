import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Phase 2b: GET /recipients and POST /conversations (server-2b-report.md §1–2).
final class CommsRecipientsTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    let clientID = "6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6"
    static let thread = #"{"id":"th_ann","title":"Ann Lee","titleSource":"person","avatar":null,"kind":"dm","networks":["imessage"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"pinned":false,"muted":false,"channels":[]}"#

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func testRecipientsDecodesPeopleThreadsAndHandleLeniently() async throws {
        let body = """
        {"query":"ann","handle":{"kind":"phone","value":"+15551230001","threadId":"th_ann"},
         "people":[{"id":"p_n1","personId":"n1","name":"Ann Lee","avatar":{"monogram":"AL"},
                    "phones":[{"value":"+15551230001","threadId":"th_ann"},{"bad":1}],"emails":[{"value":"ann@example.test"}],"source":"person"},
                   {"id":"c_ab","name":"Annie","avatar":null,"phones":[],"emails":[],"source":"contact"},
                   {"broken":true}],
         "threads":[\(Self.thread),{"nope":1}],"partial":false}
        """
        let (comms, server) = try make { _ in .json(200, body) }
        let r = try await comms.recipients(query: "  ann ", limit: 50)
        let req = server.requests[0]
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.path, "/api/comms/recipients")
        XCTAssertEqual(req.query["q"], "ann")
        XCTAssertEqual(req.query["limit"], "20", "clamped to the server's 1…20")
        XCTAssertEqual(r.handle, CommsRecipientHandle(kind: .phone, value: "+15551230001", threadId: "th_ann"))
        XCTAssertEqual(r.people.map(\.id), ["p_n1", "c_ab"], "a broken person is skipped")
        XCTAssertEqual(r.people[0].phones, [.init(value: "+15551230001", threadId: "th_ann")])
        XCTAssertEqual(r.people[0].emails.map(\.value), ["ann@example.test"])
        XCTAssertNil(r.people[1].personId)
        XCTAssertEqual(r.threads.map(\.id), ["th_ann"])
        XCTAssertFalse(r.partial)
    }

    func testRecipientsRefusesAnEmptyQueryLocally() async throws {
        let (comms, server) = try make { _ in .json(200, "{}") }
        do { _ = try await comms.recipients(query: "   "); XCTFail() } catch {}
        do { _ = try await comms.recipients(query: String(repeating: "a", count: 101)); XCTFail() } catch {}
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testStartConversationPostsExactlyTheFourKeys() async throws {
        let (comms, server) = try make { _ in
            .json(200, #"{"existing":false,"threadId":"th_ann","clientId":"6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6","eventId":"p:0/GUID","status":"sent","pending":false,"thread":\#(Self.thread)}"#)
        }
        let r = try await comms.startConversation(clientID: clientID.uppercased(), handle: " +1 555 123 0001 ", network: .imessage, text: "Hi Ann")
        XCTAssertFalse(r.existing)
        XCTAssertEqual(r.threadId, "th_ann")
        XCTAssertEqual(r.thread?.title, "Ann Lee")
        XCTAssertEqual(r.eventId, "p:0/GUID")
        let req = server.requests[0]
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/api/comms/conversations")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: req.body) as? [String: String])
        XCTAssertEqual(body, ["clientId": clientID, "handle": "+1 555 123 0001", "network": "imessage", "text": "Hi Ann"])
    }

    func testExistingAndPendingAnswersDecode() async throws {
        let (comms, _) = try make { r in
            r.body.count > 0 && String(decoding: r.body, as: UTF8.self).contains("first")
                ? .json(200, #"{"existing":true,"threadId":"th_ann","thread":\#(Self.thread)}"#)
                : .json(200, #"{"existing":false,"threadId":"th_new","clientId":"x","eventId":"g","status":"sent","pending":true,"handle":{"kind":"email","value":"ann@example.test"}}"#)
        }
        let existing = try await comms.startConversation(clientID: clientID, handle: "ann@example.test", network: .imessage, text: "first")
        XCTAssertTrue(existing.existing)
        XCTAssertEqual(existing.thread?.id, "th_ann")
        let pending = try await comms.startConversation(clientID: clientID, handle: "ann@example.test", network: .imessage, text: "second")
        XCTAssertTrue(pending.pending)
        XCTAssertNil(pending.thread)
        XCTAssertEqual(pending.threadId, "th_new")
        XCTAssertEqual(pending.handle, CommsRecipientHandle(kind: .email, value: "ann@example.test"))
        XCTAssertNil(existing.handle, "absent on an older server")
    }

    func testStartConversationErrorsAndLocalRefusals() async throws {
        let cases: [(Int, String, CommsSendFailure.Reason, Bool)] = [
            (422, #"{"error":"invalid_handle","message":"That isn't a phone number with a country code or an email address."}"#, .invalid, false),
            (403, #"{"error":"send_disabled"}"#, .sendDisabled, false),
            (403, #"{"error":"device_required"}"#, .deviceRequired, false),
            (409, #"{"error":"unsupported_network"}"#, .unsupportedNetwork, false),
            (429, #"{"error":"rate_limited"}"#, .rateLimited, false),
            (502, #"{"error":"send_failed","maybeSent":true}"#, .sendFailed, true),
        ]
        for (status, body, reason, maybe) in cases {
            let (comms, _) = try make { _ in .json(status, body) }
            do { _ = try await comms.startConversation(clientID: clientID, handle: "+15551230001", network: .sms, text: "x"); XCTFail() } catch {
                guard case CommsError.sendFailed(let f) = error else { return XCTFail("\(status): \(error)") }
                XCTAssertEqual(f.reason, reason, "\(status)")
                XCTAssertEqual(f.maybeSent, maybe, "\(status)")
                if status == 422 { XCTAssertEqual(f.message, "That isn't a phone number with a country code or an email address.") }
            }
        }
        let (comms, server) = try make { _ in .json(200, "{}") }
        for (id, handle, network, text) in [("nope", "+1555", CommsClient.NewConversationNetwork.imessage, "x"),
                                            (clientID, "a@b.test", .sms, "x"),
                                            (clientID, " ", .imessage, "x"),
                                            (clientID, "+1555", .imessage, "  ")] {
            do { _ = try await comms.startConversation(clientID: id, handle: handle, network: network, text: text); XCTFail() } catch {
                guard case CommsError.sendFailed(let f) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(f.reason, .invalid)
            }
        }
        XCTAssertTrue(server.requests.isEmpty)
    }
}

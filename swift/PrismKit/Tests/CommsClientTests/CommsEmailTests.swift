import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Email in Comms (PRD §5.8): the reply echo, the new-email body, "View full email", the wire models.
final class CommsEmailTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    let clientID = "6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6"

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func testReplyEchoesTheHeaderTheComposerShowed() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"clientId":"6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6","eventId":"email-sent:apr_1","status":"sent"}"#) }
        let echo = CommsEmailDetail.Reply(to: ["ann@x.test"], cc: ["bob@x.test"], subject: "Re: Plan")
        _ = try await comms.sendText(threadID: "th_e", clientID: clientID, text: "Works for me.", email: echo)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[0].body) as? [String: Any])
        let email = try XCTUnwrap(body["email"] as? [String: Any])
        XCTAssertEqual(email["to"] as? [String], ["ann@x.test"])
        XCTAssertEqual(email["cc"] as? [String], ["bob@x.test"])
        XCTAssertEqual(email["subject"] as? String, "Re: Plan")
        XCTAssertNil(body["replyTo"])
    }

    func testTargetChangedAndNotPlainTextSurfaceTheServerSentence() async throws {
        let (comms, _) = try make { _ in .json(409, #"{"error":"target_changed","message":"The recipients or subject changed."}"#) }
        do { _ = try await comms.sendText(threadID: "th_e", clientID: clientID, text: "x", email: .init(to: ["a@x.test"], subject: "Re: s")); XCTFail() } catch CommsError.sendFailed(let f) {
            XCTAssertEqual(f.reason, .other("target_changed"))
            XCTAssertEqual(f.message, "The recipients or subject changed.")
            XCTAssertFalse(f.maybeSent)
        }
        let (c2, _) = try make { _ in .json(422, #"{"error":"not_plain_text","message":"Email is sent as plain text."}"#) }
        do { _ = try await c2.sendText(threadID: "th_e", clientID: clientID, text: "**x**", email: .init(to: ["a@x.test"], subject: "Re: s")); XCTFail() } catch CommsError.sendFailed(let f) {
            XCTAssertEqual(f.reason, .invalid)
            XCTAssertEqual(f.message, "Email is sent as plain text.")
        }
    }

    func testNewEmailNeedsAnAddressAndASubject() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"existing":false,"threadId":"th_n","clientId":"6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6","eventId":"email-sent:apr_2","status":"sent","pending":false}"#) }
        let r = try await comms.startConversation(clientID: clientID, handle: "dana@example.test", network: .email, text: "Hi", subject: "Hello")
        XCTAssertEqual(r.threadId, "th_n")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[0].body) as? [String: String])
        XCTAssertEqual(body["network"], "email")
        XCTAssertEqual(body["subject"], "Hello")
        for (h, s) in [("+15550001", "Hello"), ("dana@example.test", " ")] {
            do { _ = try await comms.startConversation(clientID: clientID, handle: h, network: .email, text: "Hi", subject: s); XCTFail() } catch CommsError.sendFailed(let f) {
                XCTAssertEqual(f.reason, .invalid)
            }
        }
        XCTAssertEqual(server.requests.count, 1, "refused locally, nothing sent")
        // iMessage keeps no subject on the wire.
        _ = try await comms.startConversation(clientID: clientID, handle: "+15550001", network: .imessage, text: "Hi", subject: "ignored")
        let im = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[1].body) as? [String: Any])
        XCTAssertNil(im["subject"])
    }

    func testEmailOriginalAndDetailDecode() async throws {
        let (comms, server) = try make { req in
            if req.path.hasSuffix("/original") { return .json(200, #"{"subject":"Plan","from":"Ann <ann@x.test>","to":"owner@x.test","cc":"","date":"2026-11-20T10:00:00.000Z","text":"Body","html":"<p>Body</p>"}"#) }
            return .json(200, #"{"thread":{"id":"th_e","title":"Ann","titleSource":"email","avatar":null,"kind":"dm","networks":["email"],"lastMessage":{"text":"Body","subject":"Plan","senderName":"Ann","isSelf":false,"sentAt":"2026-11-20T10:00:00.000Z"},"lastActivityAt":"2026-11-20T10:00:00.000Z","unread":{"count":1,"trusted":true},"folder":"inbox","urgency":null,"status":"unclassified","pinned":false,"muted":false,"channels":[{"network":"email","accountLabel":"owner@x.test"}]},"capabilities":null,"members":[],"email":{"account":"owner@x.test","reply":{"to":["ann@x.test"],"cc":[],"subject":"Re: Plan"},"replyAll":{"to":["ann@x.test"],"cc":["bob@x.test"],"subject":"Re: Plan"}}}"#)
        }
        let o = try await comms.emailOriginal(threadID: "th_e", messageID: "n/1")
        XCTAssertEqual(o.html, "<p>Body</p>")
        XCTAssertTrue(server.requests[0].path.hasSuffix("/messages/n%2F1/original"))
        let d = try await comms.thread(id: "th_e")
        XCTAssertEqual(d.email?.reply, .init(to: ["ann@x.test"], cc: [], subject: "Re: Plan"))
        XCTAssertEqual(d.email?.replyAll, .init(to: ["ann@x.test"], cc: ["bob@x.test"], subject: "Re: Plan"))
        XCTAssertEqual(d.thread.lastMessage?.subject, "Plan")
    }
}

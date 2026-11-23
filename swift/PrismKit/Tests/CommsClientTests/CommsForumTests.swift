import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Telegram forums: one thread, topics listed in the detail, messages tagged with their topic,
/// `?topic=` views, and sends that name a topic (`topic_required` otherwise).
final class CommsForumTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    static let thread = #"{"id":"th_f","title":"Treegens DAO","titleSource":"room","avatar":null,"kind":"group","networks":["telegram"],"lastActivityAt":"2026-11-22T10:00:00.000Z","unread":{"count":3,"trusted":true},"folder":"inbox","urgency":null,"status":"unclassified","pinned":false,"muted":false,"channels":[{"network":"telegram","accountLabel":null}],"forum":{"topicCount":21}}"#
    static let message = #"{"id":"$m1","threadId":"th_f","channel":{"network":"telegram","accountLabel":null},"source":{"network":"telegram","eventId":"$m1","ref":"$m1"},"sender":{"id":"@a:hs","name":"Ann","avatar":null,"isSelf":false,"isOmni":false},"sentAt":"2026-11-22T10:00:00.000Z","body":{"plain":"gm","spans":[{"t":"text","text":"gm"}]},"attachments":[],"linkPreviews":[],"reactions":[],"delivery":null,"redacted":false,"topic":{"id":"tp_dev","title":"Dev"}}"#

    func testForumThreadTopicsAndMessages() async throws {
        let (comms, server) = try make { r in
            switch r.path {
            case "/api/comms/threads/th_f":
                return .json(200, #"{"thread":\#(Self.thread),"capabilities":null,"members":[],"topics":[{"id":"tp_dev","title":"Dev","lastActivityAt":"2026-11-22T10:00:00.000Z","unread":2},{"id":"tp_gen","title":"General","lastActivityAt":"2026-11-21T10:00:00.000Z","unread":0,"lastMessage":{"text":"hi","senderName":"Bo","isSelf":false,"sentAt":"2026-11-21T10:00:00.000Z"}},{"bad":true}]}"#)
            case "/api/comms/threads/th_f/messages":
                return .json(200, #"{"messages":[\#(Self.message)],"before":"tc_abcdefghijklmnopqrstuvwx","hasMore":true}"#)
            default: return .json(404, #"{"error":"thread_unavailable"}"#)
            }
        }
        let d = try await comms.thread(id: "th_f")
        XCTAssertEqual(d.thread.forum?.topicCount, 21)
        XCTAssertEqual(d.topics?.map(\.title), ["Dev", "General"], "a topic that does not decode is dropped, not the thread")
        XCTAssertEqual(d.topics?.first?.unread, 2)
        XCTAssertEqual(d.topics?.last?.ref, CommsTopicRef(id: "tp_gen", title: "General"))

        let all = try await comms.messages(threadID: "th_f", before: nil, limit: 30)
        XCTAssertEqual(all.messages.first?.topic, CommsTopicRef(id: "tp_dev", title: "Dev"))
        XCTAssertNil(URLComponents(url: server.requests[1].url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "topic" }, "All topics = no topic")
        _ = try await comms.messages(threadID: "th_f", before: nil, limit: 30, topic: "tp_dev")
        XCTAssertEqual(URLComponents(url: server.requests[2].url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "topic" }?.value, "tp_dev")
    }

    func testSendNamesTheTopicAndMapsTopicRequired() async throws {
        let (comms, server) = try make { r in
            let body = (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]) ?? [:]
            if r.path == "/api/comms/threads/th_f/messages", body["topic"] == nil { return .json(422, #"{"error":"topic_required","message":"Choose the topic to send to."}"#) }
            if r.path.hasSuffix("/read") { return .json(200, #"{"thread":null,"receipt":"nothing"}"#) }
            if r.path.hasSuffix("/reactions") { return .json(200, #"{"clientId":"\#(body["clientId"] ?? "")","eventId":"$r","status":"sent"}"#) }
            return .json(200, #"{"clientId":"\#(body["clientId"] ?? "")","eventId":"$s","status":"sent"}"#)
        }
        let id = UUID().uuidString.lowercased()
        do {
            _ = try await comms.sendText(threadID: "th_f", clientID: id, text: "hi")
            XCTFail("expected topic_required")
        } catch let CommsError.sendFailed(f) {
            XCTAssertEqual(f.reason, .topicRequired)
            XCTAssertFalse(f.maybeSent)
        }
        _ = try await comms.sendText(threadID: "th_f", clientID: id, text: "hi", topic: "tp_dev")
        XCTAssertEqual((try JSONSerialization.jsonObject(with: server.requests[1].body) as? [String: Any])?["topic"] as? String, "tp_dev")
        _ = try await comms.sendAttachment(threadID: "th_f", clientID: UUID().uuidString.lowercased(), kind: .file, data: Data("x".utf8), mime: "text/plain", filename: "a.txt", topic: "tp_dev")
        XCTAssertEqual(URLComponents(url: server.requests[2].url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "topic" }?.value, "tp_dev")
        _ = try await comms.addReaction(threadID: "th_f", messageID: "$m1", clientID: UUID().uuidString.lowercased(), key: "👍", topic: "tp_dev")
        _ = try await comms.markRead(threadID: "th_f", upTo: nil, topic: "tp_dev")
        XCTAssertEqual((try JSONSerialization.jsonObject(with: server.requests[4].body) as? [String: Any])?["topic"] as? String, "tp_dev")
        XCTAssertEqual((try JSONSerialization.jsonObject(with: server.requests[3].body) as? [String: Any])?["topic"] as? String, "tp_dev")
    }
}

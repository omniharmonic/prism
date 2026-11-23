import CommsClient
import Foundation
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

/// `POST/DELETE /api/comms/threads/:id/messages/:messageId/reactions[/:key]` (send-server-report.md, Reactions).
final class CommsReactionTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    let clientID = "6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6"

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    let ok: StubServer.Handler = { r in
        r.method == "DELETE" ? .json(200, #"{"status":"removed"}"#)
            : .json(200, #"{"clientId":"6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6","eventId":"$react1","status":"sent"}"#)
    }

    /// The raw (still percent-encoded) path the server saw.
    func rawPath(_ r: SeenRequest) -> String {
        URLComponents(url: r.url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
    }

    func testAddReactionPostsClientIDAndKeyWithEncodedMessageID() async throws {
        let (comms, server) = try make(ok)
        let result = try await comms.addReaction(threadID: "th_1", messageID: "$abc/DEF+g=:example.test", clientID: clientID, key: "❤️")
        XCTAssertEqual(result, CommsSendResult(clientId: clientID, eventId: "$react1"))
        let r = server.requests[0]
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(rawPath(r), "/api/comms/threads/th_1/messages/%24abc%2FDEF%2Bg%3D%3Aexample.test/reactions")
        XCTAssertEqual(r.path, "/api/comms/threads/th_1/messages/$abc/DEF+g=:example.test/reactions", "decodes back to the id")
        XCTAssertEqual(r.header("Content-Type"), "application/json")
        XCTAssertEqual(r.header("Authorization"), "Bearer \(TestTokens.device)")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: r.body) as? [String: String])
        XCTAssertEqual(body, ["clientId": clientID, "key": "❤️"], "only the contract's two keys")
    }

    func testRemoveReactionDeletesEncodedKey() async throws {
        let (comms, server) = try make(ok)
        try await comms.removeReaction(threadID: "th_1", messageID: "$ev1", key: "👍🏽")
        try await comms.removeReaction(threadID: "th_1", messageID: "$ev1", key: "a/b")
        let r = server.requests[0]
        XCTAssertEqual(r.method, "DELETE")
        XCTAssertEqual(rawPath(r), "/api/comms/threads/th_1/messages/%24ev1/reactions/%F0%9F%91%8D%F0%9F%8F%BD")
        XCTAssertEqual(rawPath(server.requests[1]), "/api/comms/threads/th_1/messages/%24ev1/reactions/a%2Fb", "a slash stays inside the key segment")
    }

    func testRefusesLocallyWhatTheServerWould() async throws {
        let (comms, server) = try make(ok)
        let bad: [(String, String, String)] = [
            ("cm_1", clientID, "❤️"), // not an event id
            ("$", clientID, "❤️"),
            ("$a b", clientID, "❤️"),
            ("$a/../b", clientID, "❤️"), // path-like ids: refused even though each character is legal
            ("$a//b", clientID, "❤️"),
            ("$a/", clientID, "❤️"),
            ("$a/.b", clientID, "❤️"),
            ("$..", clientID, "❤️"),
            ("$ev", "not-a-uuid", "❤️"),
            ("$ev", clientID, ""),
            ("$ev", clientID, "a\nb"),
            ("$ev", clientID, String(repeating: "x", count: 65)),
        ]
        for (message, id, key) in bad {
            do { _ = try await comms.addReaction(threadID: "th_1", messageID: message, clientID: id, key: key); XCTFail("sent \(message) \(key)") } catch {
                guard case CommsError.sendFailed(let f) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(f.reason, .invalid)
                XCTAssertFalse(f.maybeSent)
            }
        }
        do { try await comms.removeReaction(threadID: "../x", messageID: "$ev", key: "❤️"); XCTFail() } catch {
            XCTAssertEqual(error as? PrismError, .invalidRequest("id refused"))
        }
        _ = try await comms.addReaction(threadID: "th_1", messageID: "$ev", clientID: clientID, key: String(repeating: "x", count: 64))
        XCTAssertEqual(server.requests.count, 1, "only the valid one reached the server")
    }

    func testReactionErrorMapping() async throws {
        let cases: [(StubAnswer, CommsSendFailure.Reason, Bool)] = [
            (.json(409, #"{"error":"already_reacted","message":"x"}"#), .alreadyReacted, false),
            (.json(404, #"{"error":"not_found","message":"x"}"#), .notFound, false),
            (.json(403, #"{"error":"send_disabled","message":"x"}"#), .sendDisabled, false),
            (.json(403, #"{"error":"device_required","message":"x"}"#), .deviceRequired, false),
            (.json(409, #"{"error":"unsupported_network","message":"x"}"#), .unsupportedNetwork, false),
            (.json(409, #"{"error":"encrypted_room","message":"x"}"#), .encryptedRoom, false),
            (.json(409, #"{"error":"in_progress","message":"x"}"#), .inProgress, true),
            (.json(422, #"{"error":"invalid","message":"x"}"#), .invalid, false),
            (.json(429, #"{"error":"rate_limited","message":"x"}"#, headers: ["Retry-After": "30"]), .rateLimited, false),
            (.json(502, #"{"error":"send_failed","message":"x","maybeSent":false}"#), .sendFailed, false),
            (.json(502, #"{"error":"send_failed","message":"x","maybeSent":true}"#), .sendFailed, true),
            (.json(503, #"{"error":"source_unavailable","message":"x"}"#), .sourceUnavailable, false),
            (.failure(.timedOut), .outcomeUnknown, true),
            (.failure(.cannotConnectToHost), .unreachable, false),
        ]
        for (answer, reason, maybeSent) in cases {
            let (comms, _) = try make { _ in answer }
            for remove in [false, true] {
                do {
                    if remove { try await comms.removeReaction(threadID: "th_1", messageID: "$ev", key: "❤️") } else {
                        _ = try await comms.addReaction(threadID: "th_1", messageID: "$ev", clientID: clientID, key: "❤️")
                    }
                    XCTFail("expected \(reason)")
                } catch {
                    guard case CommsError.sendFailed(let f) = error else { XCTFail("\(reason): \(error)"); continue }
                    XCTAssertEqual(f.reason, reason, "remove: \(remove)")
                    XCTAssertEqual(f.maybeSent, maybeSent, "\(reason)")
                }
            }
        }
        let (scope, _) = try make { _ in .json(403, #"{"error":"client_scope"}"#) }
        do { try await scope.removeReaction(threadID: "th_1", messageID: "$ev", key: "❤️") } catch { XCTAssertEqual(error as? CommsError, .clientScope) }
    }

    func testReactionModelsHavePublicInitsAndDecode() throws {
        let r = CommsReaction(key: "❤️", count: 2, mine: true, senders: [.init(id: "@me:x", name: "Me", eventId: "$r"), .init(id: "@a:x", name: "Alex")])
        let data = try PrismJSON.encoder().encode(r)
        XCTAssertEqual(try PrismJSON.decoder().decode(CommsReaction.self, from: data), r)
    }

    func testPercentEncodedPathKeepsEscapesAndRefusesTraversal() throws {
        let o = try ServerOrigin("https://prism.example.com")
        XCTAssertEqual(try o.url(path: "/a/%24b%2Fc", percentEncoded: true).absoluteString, "https://prism.example.com/a/%24b%2Fc")
        XCTAssertEqual(try o.url(path: "/a/%24b").absoluteString, "https://prism.example.com/a/%2524b", "plain paths still escape %")
        for bad in ["/a/%2E%2E/b", "/a/%2e", "/a/%zz", "/a/%2", "/a/%5C"] {
            XCTAssertThrowsError(try o.url(path: bad, percentEncoded: true), bad)
        }
    }
}

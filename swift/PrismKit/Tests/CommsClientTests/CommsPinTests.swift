import CommsClient
import Foundation
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

/// Sprint Task 8: pins (`GET/PUT /api/comms/pins`, `POST/DELETE /api/comms/threads/:id/pin`)
/// and the read-receipt fields on a message.
final class CommsPinTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    static func thread(_ id: String, order: Int?) -> String {
        let pin = order.map { #","pinOrder":\#($0)"# } ?? ""
        return #"{"id":"\#(id)","title":"T","titleSource":"room","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-22T10:00:00.000Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"status":"unclassified","pinned":\#(order != nil)\#(pin),"muted":false,"channels":[{"network":"whatsapp","accountLabel":null}]}"#
    }

    func testPinUnpinListAndReorder() async throws {
        let (comms, server) = try make { r in
            switch (r.method, r.path) {
            case ("GET", "/api/comms/pins"): return .json(200, #"{"threads":[\#(Self.thread("th_a", order: 0)),\#(Self.thread("th_b", order: 1))]}"#)
            case ("POST", "/api/comms/threads/th_c/pin"): return .json(200, #"{"thread":\#(Self.thread("th_c", order: 2))}"#)
            case ("DELETE", "/api/comms/threads/th_c/pin"): return .json(200, #"{"thread":\#(Self.thread("th_c", order: nil))}"#)
            case ("PUT", "/api/comms/pins"): return .json(200, #"{"threads":[\#(Self.thread("th_b", order: 0)),\#(Self.thread("th_a", order: 1))]}"#)
            default: return .json(404, #"{"error":"not_found"}"#)
            }
        }
        let pins = try await comms.pins()
        XCTAssertEqual(pins.map(\.id), ["th_a", "th_b"])
        XCTAssertEqual(pins.map(\.pinOrder), [0, 1])
        let pinned = try await comms.pin(threadID: "th_c")
        XCTAssertTrue(pinned.pinned)
        XCTAssertEqual(pinned.pinOrder, 2)
        let unpinned = try await comms.unpin(threadID: "th_c")
        XCTAssertFalse(unpinned.pinned)
        XCTAssertNil(unpinned.pinOrder)
        let reordered = try await comms.reorderPins(["th_b", "th_a"])
        XCTAssertEqual(reordered.map(\.id), ["th_b", "th_a"])
        let put = try XCTUnwrap(server.requests.first { $0.method == "PUT" })
        XCTAssertEqual(put.header("Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: put.body) as? [String: [String]])
        XCTAssertEqual(body, ["threadIds": ["th_b", "th_a"]])
    }

    func testNamedFailures() async throws {
        let (comms, _) = try make { r in
            switch r.path {
            case "/api/comms/threads/th_full/pin": return .json(409, #"{"error":"pin_limit","max":9}"#)
            case "/api/comms/pins": return r.method == "PUT" ? .json(409, #"{"error":"pins_changed","threadIds":[]}"#) : .json(404, #"{"error":"pins_disabled"}"#)
            default: return .json(404, #"{"error":"thread_unavailable"}"#)
            }
        }
        do { _ = try await comms.pin(threadID: "th_full"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .pinLimit) }
        do { _ = try await comms.reorderPins(["th_a"]); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .pinsChanged) }
        do { _ = try await comms.pins(); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .pinsDisabled) }
        do { _ = try await comms.unpin(threadID: "th_gone"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .threadUnavailable) }
        do { _ = try await comms.pin(threadID: "../x"); XCTFail() } catch { XCTAssertEqual(error as? PrismError, .invalidRequest("id refused")) }
    }

    func testMessageDecodesReadState() throws {
        let json = #"{"id":"$m","threadId":"t","channel":{"network":"whatsapp","accountLabel":null},"source":{"network":"whatsapp","eventId":"$m","ref":"$m"},"sender":{"id":"@me:hs","name":"Me","avatar":null,"isSelf":true,"isOmni":false},"sentAt":"2026-11-22T10:00:00.000Z","body":null,"attachments":[],"linkPreviews":[],"reactions":[],"delivery":"read","readAt":"2026-11-22T14:14:00.000Z","readBy":[{"id":"@whatsapp_a:hs","name":"Alex","readAt":"2026-11-22T14:14:00.000Z"}],"redacted":false}"#
        let page = try PrismResponse(status: 200, headers: [:], body: Data(#"{"messages":[\#(json)],"before":null,"hasMore":false}"#.utf8)).decode(CommsMessagePage.self)
        let m = try XCTUnwrap(page.messages.first)
        XCTAssertEqual(m.delivery, .read)
        XCTAssertEqual(m.readBy?.map(\.name), ["Alex"])
        XCTAssertNotNil(m.readAt)
        XCTAssertEqual(m.readBy?.first?.readAt, m.readAt)
    }
}

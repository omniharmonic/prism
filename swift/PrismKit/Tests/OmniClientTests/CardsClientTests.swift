import Foundation
import OmniClient
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

final class CardsClientTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    static let card = #"{"id":"card_1","sourceKey":"mail1","kind":"email","state":"proposed","headline":"Sam asks about the budget","context":[],"urgency":"today","options":[{"id":"a","label":"Say yes","plan":"Reply yes","produces":["email-reply"],"draft":null},{"id":"b","label":"Later","plan":"Nothing","produces":["nothing"],"draft":null}],"recommended":null,"itemRefs":["mail1"],"threadId":"omni-proactive-1","approvalIds":[],"chosenOptionId":null,"section":"decide","transitional":false}"#

    func make(_ handler: @escaping StubServer.Handler) throws -> (OmniClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (OmniClient(transport: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func testListingBySection() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"cards":[\#(Self.card)],"counts":{"decide":1,"approve":0,"motion":0}}"#) }
        let list = try await omni.cards(section: .decide)
        XCTAssertEqual(list.cards.map(\.id), ["card_1"])
        XCTAssertEqual(list.counts.decide, 1)
        XCTAssertEqual(server.requests[0].path, "/api/omni/cards")
        XCTAssertEqual(server.requests[0].query, ["section": "decide"])
        _ = try await omni.cards()
        XCTAssertEqual(server.requests[1].query, [:])
    }

    func testOneMalformedCardDoesNotBlankTheList() async throws {
        let bad = #"{"id":"card_bad","state":42}"#
        let (omni, _) = try make { _ in .json(200, #"{"cards":[\#(Self.card),\#(bad),\#(Self.card.replacingOccurrences(of: "card_1", with: "card_2"))],"counts":{"decide":2,"approve":0,"motion":0}}"#) }
        let list = try await omni.cards()
        XCTAssertEqual(list.cards.map(\.id), ["card_1", "card_2"])
        XCTAssertEqual(list.counts.decide, 2)
    }

    func testChooseAndInstructSendTheKeyAndBody() async throws {
        let (omni, server) = try make { _ in .json(202, #"{"card":\#(Self.card),"approval":null,"threadId":"omni-proactive-1","turnId":"turn_1"}"#) }
        let key = IdempotencyKey("choose-press-0001")!
        let chosen = try await omni.chooseCardOption("card_1", optionID: "b", cardVersion: "3fd35d7265d5bd63", idempotencyKey: key)
        XCTAssertEqual(chosen.turnId, "turn_1")
        XCTAssertNil(chosen.approval)
        XCTAssertEqual(server.requests[0].method, "POST")
        XCTAssertEqual(server.requests[0].path, "/api/omni/cards/card_1/choose")
        XCTAssertEqual(server.requests[0].header("Idempotency-Key"), "choose-press-0001")
        XCTAssertEqual(try Self.body(server.requests[0].bodyString), ["optionId": "b", "cardVersion": "3fd35d7265d5bd63"])
        _ = try await omni.instructCard("card_1", text: "Ask for the PDF first", cardVersion: "3fd35d7265d5bd63", idempotencyKey: IdempotencyKey("instruct-press-01")!)
        XCTAssertEqual(server.requests[1].path, "/api/omni/cards/card_1/instruct")
        XCTAssertEqual(server.requests[1].header("Idempotency-Key"), "instruct-press-01")
        XCTAssertEqual(try Self.body(server.requests[1].bodyString), ["text": "Ask for the PDF first", "cardVersion": "3fd35d7265d5bd63"])
    }

    /// A JSON object body as string pairs (key order is not part of the contract).
    private static func body(_ text: String?) throws -> [String: String] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data((text ?? "").utf8)) as? [String: String])
    }

    func testAChangedCardIsAConflictTheAppCanName() async throws {
        let (omni, _) = try make { _ in .json(409, #"{"error":"card_changed","detail":"the card was updated since it was shown"}"#) }
        do {
            _ = try await omni.chooseCardOption("card_1", optionID: "a", cardVersion: "0000000000000000", idempotencyKey: .random())
            XCTFail("expected an error")
        } catch let e as PrismError {
            XCTAssertEqual(e.serverCode, "card_changed")
        }
    }

    func testGetOneCardUnwrapsTheAnswer() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"card":\#(Self.card)}"#) }
        let card = try await omni.card("card_1")
        XCTAssertEqual(card.id, "card_1")
        XCTAssertEqual(server.requests[0].path, "/api/omni/cards/card_1")
    }

    func testSnoozeSendsMillisecondsAndDismissSendsTheReason() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"card":\#(Self.card)}"#) }
        _ = try await omni.snoozeCard("card_1", until: Date(timeIntervalSince1970: 1_792_080_000))
        XCTAssertEqual(server.requests[0].path, "/api/omni/cards/card_1/snooze")
        XCTAssertEqual(server.requests[0].bodyString, #"{"until":1792080000000}"#)
        _ = try await omni.dismissCard("card_1", reason: .notNeeded)
        XCTAssertEqual(server.requests[1].path, "/api/omni/cards/card_1/dismiss")
        XCTAssertEqual(server.requests[1].bodyString, #"{"reason":"not-needed"}"#)
    }

    func testAnUnclearChooseIsOutcomeUnknownAndAnIdThatReshapesThePathIsRefused() async throws {
        let (omni, server) = try make { _ in .json(502, #"{"error":"internal_error"}"#) }
        do {
            _ = try await omni.chooseCardOption("card_1", optionID: "a", cardVersion: "3fd35d7265d5bd63", idempotencyKey: .random())
            XCTFail("expected an error")
        } catch let e as PrismError {
            guard case .outcomeUnknown = e else { return XCTFail("expected outcomeUnknown, got \(e)") }
        }
        await XCTAssertThrowsErrorAsync { _ = try await omni.card("../threads") }
        await XCTAssertThrowsErrorAsync { _ = try await omni.card("a/b") }
        XCTAssertEqual(server.requests.count, 1)
    }
}

/// `XCTAssertThrowsError` for async code.
func XCTAssertThrowsErrorAsync(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
    do { try await body(); XCTFail("expected an error", file: file, line: line) } catch {}
}

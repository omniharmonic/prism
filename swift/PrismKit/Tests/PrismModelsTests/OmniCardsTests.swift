import Foundation
import PrismModels
import XCTest

final class OmniCardsTests: XCTestCase {
    private func fixture(_ name: String) throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "omni-cards", withExtension: "json", subdirectory: "Fixtures"))
        let all = try PrismJSON.decoder().decode(JSONValue.self, from: Data(contentsOf: url))
        return try XCTUnwrap(all.objectValue?[name])
    }
    private func card(_ name: String) throws -> OmniCard {
        try PrismJSON.decoder().decode(OmniCard.self, from: PrismJSON.encoder().encode(try fixture(name)))
    }
    private func json(_ name: String) throws -> String { String(decoding: try PrismJSON.encoder().encode(try fixture(name)), as: UTF8.self) }

    func testAProposedCardFromTheServersShape() throws {
        let c = try card("proposed")
        XCTAssertEqual(c.state, .proposed)
        XCTAssertEqual(c.kind, .email)
        XCTAssertEqual(c.urgency, .thisWeek)
        XCTAssertEqual(c.section, .decide)
        XCTAssertEqual(c.options.map(\.id), ["a", "b"])
        XCTAssertEqual(c.recommendedOption?.id, "a")
        XCTAssertEqual(c.recommendedOption?.draft?.kind, .emailReply)
        XCTAssertEqual(c.recommendedOption?.draft?.payload["expectTo"], ["sam@example.com"])
        XCTAssertNil(c.options[1].draft)
        XCTAssertEqual(c.contextLine, "You have Thu 2–4 free · Grant deadline is Fri 5pm")
        XCTAssertEqual(c.createdAt, PrismJSON.parseDate("2026-10-15T16:00:00Z"))
        XCTAssertFalse(c.transitional)
        XCTAssertNil(c.latestApprovalID)
    }

    func testADraftReadyCardNamesItsApproval() throws {
        let c = try card("draftReady")
        XCTAssertEqual(c.state, .draftReady)
        XCTAssertEqual(c.section, .approve)
        XCTAssertEqual(c.chosenOptionId, "a")
        XCTAssertEqual(c.latestApprovalID, "apr_fixture")
    }

    func testATransitionalNudgeCardHasNoOptions() throws {
        let c = try card("transitional")
        XCTAssertTrue(c.transitional)
        XCTAssertEqual(c.nudgeId, "nud_fixture")
        XCTAssertTrue(c.options.isEmpty)
        XCTAssertNil(c.threadId)
        XCTAssertEqual(c.context, [OmniCard.Fact(text: "She asked whether the barn is free on the 24th.", source: nil)])
    }

    func testUnknownStateKindAndMissingFieldsStillDecode() throws {
        let c = try PrismJSON.decoder().decode(OmniCard.self, from: Data(#"{"id":"card_x","state":"delivered","kind":"fax","headline":"Something new"}"#.utf8))
        XCTAssertEqual(c.state.rawValue, "delivered")
        XCTAssertEqual(c.kind.rawValue, "fax")
        XCTAssertEqual(c.urgency, .whenever)
        XCTAssertTrue(c.options.isEmpty)
        XCTAssertNil(c.section)
    }

    func testTheStreamCarriesItemCardsAndTheTranscriptKeepsTheLatest() throws {
        let first = try XCTUnwrap(OmniStreamEnvelope.decode(eventName: "item_card", data: #"{"seq":3,"turnId":null,"t":"item_card","card":\#(try json("proposed"))}"#))
        guard case .itemCard(let c) = first.event else { return XCTFail("not an item card: \(first.event)") }
        XCTAssertEqual(c.id, "card_fixture")
        let second = try XCTUnwrap(OmniStreamEnvelope.decode(eventName: "item_card", data: #"{"seq":4,"turnId":null,"t":"item_card","card":\#(try json("draftReady"))}"#))
        var t = TurnTranscript()
        t.apply(first)
        t.apply(second)
        XCTAssertEqual(t.itemCards.map(\.state), [.draftReady])
        XCTAssertTrue(t.items.isEmpty, "item cards are kept beside the transcript items")
        XCTAssertEqual(t.lastSeq, 4)
    }

    func testThreadDetailWithAndWithoutItemCards() throws {
        let base = #""thread":{"id":"omni_a","state":"waiting","unread":0,"pinned":false,"archived":false,"running":false,"lastSeq":2},"messages":[],"cards":[],"approvals":[],"activeTurnId":null"#
        XCTAssertTrue(try PrismJSON.decoder().decode(ThreadDetail.self, from: Data("{\(base)}".utf8)).itemCards.isEmpty)
        let with = try PrismJSON.decoder().decode(ThreadDetail.self, from: Data("{\(base),\"itemCards\":[\(try json("proposed"))]}".utf8))
        XCTAssertEqual(with.itemCards.map(\.id), ["card_fixture"])
    }

    func testOptimisticCopyChangesOnlyStateChoiceAndSection() throws {
        let c = try card("proposed")
        let working = c.with(state: .working, chosenOptionId: "b", section: .motion)
        XCTAssertEqual(working.state, .working)
        XCTAssertEqual(working.chosenOptionId, "b")
        XCTAssertEqual(working.section, .motion)
        XCTAssertEqual(working.options, c.options)
        XCTAssertEqual(working.headline, c.headline)
    }
}

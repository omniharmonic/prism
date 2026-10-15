import XCTest
import OmniClient
import PrismTransport
@testable import OmniCore

private func sample(_ id: String, urgency: CardUrgency = .thisWeek, created: TimeInterval, draft: Bool = true, transitional: Bool = false) -> OmniCard {
    OmniCard(id: id, sourceKey: "src-\(id)", kind: .email, state: .proposed, headline: "Sam asks about \(id)",
             context: [.init(text: "You're free Thu 2–4", source: "calendar")], urgency: urgency,
             options: transitional ? [] : [
                .init(id: "a", label: "Say yes", plan: "Reply yes", produces: ["email-reply"],
                      draft: draft ? .init(kind: .emailReply, payload: ["noteId": "src", "expectTo": ["sam@example.com"], "body": "Yes."]) : nil),
                .init(id: "b", label: "Ask for Monday", plan: "Reply proposing Monday", produces: ["email-reply"], draft: nil),
             ],
             recommended: transitional ? nil : "a", itemRefs: ["src-\(id)"], threadId: "t-\(id)",
             createdAt: Date(timeIntervalSince1970: created), updatedAt: Date(timeIntervalSince1970: created),
             section: .decide, transitional: transitional, nudgeId: transitional ? "nud-\(id)" : nil)
}

private let pendingApproval: Approval = try! JSONDecoder().decode(Approval.self, from: Data(#"{"id":"apr_1","threadId":"t-c1","kind":"email-reply","payload":{"noteId":"src","expectTo":["sam@example.com"],"body":"Yes."},"digest":"\#(String(repeating: "a", count: 64))","summary":"Say yes","status":"pending"}"#.utf8))

private actor CardFake: CardService {
    var list: [OmniCard]
    var chooseKeys: [IdempotencyKey] = []
    var chooseFailures: [any Error] = []
    var snoozes = 0
    init(_ list: [OmniCard]) { self.list = list }
    func failNextChoose(_ errors: [any Error]) { chooseFailures = errors }
    func cards(section: CardSection?) async throws -> CardList {
        CardList(cards: list, counts: .init(decide: list.filter { $0.section == .decide }.count, approve: list.filter { $0.section == .approve }.count, motion: list.filter { $0.section == .motion }.count))
    }
    func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        chooseKeys.append(idempotencyKey)
        if !chooseFailures.isEmpty { throw chooseFailures.removeFirst() }
        let card = list.first { $0.id == id }!
        let option = card.options.first { $0.id == optionID }!
        let next = option.draft != nil
            ? card.with(state: .draftReady, chosenOptionId: optionID, section: .approve)
            : card.with(state: .working, chosenOptionId: optionID, section: .motion)
        return CardActionResult(card: next, approval: option.draft != nil ? pendingApproval : nil, threadId: card.threadId, turnId: option.draft == nil ? "turn_1" : nil)
    }
    func instructCard(_ id: String, text: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        let card = list.first { $0.id == id }!
        return CardActionResult(card: card.with(state: .working, chosenOptionId: nil, section: .motion), approval: nil, threadId: card.threadId, turnId: "turn_2")
    }
    func snoozeCard(_ id: String, until: Date) async throws -> OmniCard {
        snoozes += 1
        return list.first { $0.id == id }!.with(state: .snoozed, chosenOptionId: nil, section: nil)
    }
    func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard {
        list.first { $0.id == id }!.with(state: .dismissed, chosenOptionId: nil, section: nil)
    }
}

private actor NudgeRecorder: NudgeService {
    var actions: [String] = []
    func nudges(later: Bool) async throws -> [OmniNudge] { [] }
    func nudgeSettings() async throws -> NudgeSettings { .init() }
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { settings }
    func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge {
        actions.append("\(id):\(action.rawValue)")
        throw URLError(.cancelled)
    }
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted {
        try JSONDecoder().decode(NudgeStarted.self, from: Data(#"{"threadId":"thread-from-nudge","turnId":"turn9"}"#.utf8))
    }
}

@MainActor final class CardsTests: XCTestCase {
    fileprivate func model(_ cards: [OmniCard], nudges: NudgeCenter? = nil) -> (CardsModel, CardFake) {
        let fake = CardFake(cards)
        return (CardsModel(service: fake, nudges: nudges, sink: ErrorSink(onSignedOut: {})), fake)
    }

    func testSectionsOrderUrgencyFirstThenTheOldest() async {
        let (cards, _) = model([sample("c1", urgency: .whenever, created: 1), sample("c2", urgency: .today, created: 3), sample("c3", urgency: .today, created: 2)])
        await cards.refresh()
        XCTAssertEqual(cards.phase, .loaded)
        XCTAssertEqual(cards.decide.map(\.id), ["c3", "c2", "c1"])
        XCTAssertTrue(cards.approve.isEmpty)
    }

    func testUnclearChooseKeepsTheKeyRevertsTheOptimisticStateAndARetryMakesOneApproval() async {
        let (cards, fake) = model([sample("c1", created: 1)])
        await cards.refresh()
        await fake.failNextChoose([URLError(.timedOut)])
        var arrived: [String] = []
        cards.approvalDidArrive = { arrived.append($0.id) }
        let first = await cards.choose("c1", optionID: "a")
        XCTAssertNil(first)
        XCTAssertEqual(cards.card(for: "c1")?.state, .proposed, "back as it was: the server may or may not have it")
        XCTAssertNotNil(cards.notice(for: "c1"))
        let retry = await cards.choose("c1", optionID: "a")
        XCTAssertEqual(retry?.card.state, .draftReady)
        let keys = await fake.chooseKeys
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1], "the same press, the same key")
        XCTAssertEqual(arrived, ["apr_1"])
        XCTAssertEqual(cards.approve.map(\.id), ["c1"])
        XCTAssertNil(cards.notice(for: "c1"))
        XCTAssertTrue(cards.busy.isEmpty)
    }

    func testADefiniteRefusalDropsTheKey() async {
        let (cards, fake) = model([sample("c1", created: 1)])
        await cards.refresh()
        await fake.failNextChoose([PrismError.conflict(ServerFailure(status: 409, code: "card_not_open", detail: nil, body: Data()))])
        _ = await cards.choose("c1", optionID: "a")
        _ = await cards.choose("c1", optionID: "a")
        let keys = await fake.chooseKeys
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testAPlanOptionMovesTheCardIntoMotionAndInstructDoesToo() async {
        let (cards, _) = model([sample("c1", created: 1), sample("c2", created: 2)])
        await cards.refresh()
        let result = await cards.choose("c1", optionID: "b")
        XCTAssertEqual(result?.turnId, "turn_1")
        XCTAssertEqual(cards.inMotion.map(\.id), ["c1"])
        let empty = await cards.instruct("c2", text: "   ")
        XCTAssertNil(empty, "an empty instruction is not sent")
        let instructed = await cards.instruct("c2", text: "Ask for the PDF first")
        XCTAssertEqual(instructed?.card.state, .working)
        XCTAssertTrue(cards.decide.isEmpty)
    }

    func testIngestOfAClosedCardRemovesItAndAnOlderCopyIsIgnored() async {
        let (cards, _) = model([sample("c1", created: 10)])
        await cards.refresh()
        let older = sample("c1", created: 5).with(state: .working, chosenOptionId: "b", section: .motion)
        cards.ingest([older])
        XCTAssertEqual(cards.card(for: "c1")?.state, .proposed)
        let sent = OmniCard(id: "c1", sourceKey: "src-c1", kind: .email, state: .sent, headline: "Sam asks about c1", updatedAt: Date(timeIntervalSince1970: 20), section: nil)
        cards.ingest([sent])
        XCTAssertTrue(cards.items.isEmpty)
        XCTAssertEqual(cards.card(for: "c1")?.state, .sent, "still known for its thread")
    }

    func testATransitionalCardActsThroughItsNudge() async {
        let recorder = NudgeRecorder()
        let nudges = NudgeCenter(service: recorder, sink: ErrorSink(onSignedOut: {}))
        let (cards, fake) = model([sample("n1", created: 1, transitional: true)], nudges: nudges)
        await cards.refresh()
        await cards.later("n1", until: Date(timeIntervalSince1970: 100))
        await cards.notNeeded("n1")
        let actions = await recorder.actions
        XCTAssertEqual(actions, ["nud-n1:snooze", "nud-n1:noise"])
        let snoozes = await fake.snoozes
        XCTAssertEqual(snoozes, 0, "a nudge card never calls the card routes")
        let thread = await cards.openTransitional("n1")
        XCTAssertEqual(thread, "t-n1", "it already has a thread")
    }

    func testCardWords() {
        XCTAssertEqual(CardText.kindLabel(.invite), "Invite")
        XCTAssertEqual(CardText.kindLabel(CardKind(rawValue: "fax")), "Item")
        XCTAssertEqual(CardText.urgencyLabel(.today), "Today")
        XCTAssertNil(CardText.urgencyLabel(.whenever))
        XCTAssertEqual(CardText.age(Date(timeIntervalSince1970: 0), now: Date(timeIntervalSince1970: 7_200)), "2h")
        XCTAssertEqual(CardText.age(Date(timeIntervalSince1970: 0), now: Date(timeIntervalSince1970: 3 * 86_400)), "3d")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Denver")!
        let noonThursday = Date(timeIntervalSince1970: 1_792_087_200) // 2026-10-15 12:00 in Denver, a Thursday
        let presets = CardText.laterPresets(now: noonThursday, calendar: calendar)
        XCTAssertEqual(presets.map(\.label), ["This evening", "Tomorrow morning", "Next week"])
        XCTAssertTrue(presets.allSatisfy { $0.until > noonThursday && $0.until < noonThursday.addingTimeInterval(30 * 86_400) })
    }

    func testTheSessionCountsDecideApproveAndUnlinkedDraftsAndFollowsItemCardNotices() async throws {
        let service = FakeService()
        service.cardList = [sample("c1", created: 1)]
        let session = SessionModel(service: service, sleep: { _ in }) {}
        XCTAssertNotNil(session.cards)
        let notice = try JSONDecoder().decode(OmniNotice.self, from: Data(#"{"type":"item-card","id":"c1","op":"created"}"#.utf8))
        await session.handle(notice)
        XCTAssertEqual(session.cards?.decide.map(\.id), ["c1"])
        XCTAssertEqual(session.needsYouCount, 1)
    }
}

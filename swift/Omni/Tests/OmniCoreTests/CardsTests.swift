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
    var served: OmniCard?
    var duringChoose: (@Sendable () async -> Void)?
    var duringList: (@Sendable () async -> Void)?
    func setDuringList(_ hook: (@Sendable () async -> Void)?) { duringList = hook }
    init(_ list: [OmniCard]) { self.list = list }
    func serve(_ card: OmniCard?) { served = card }
    func setDuringChoose(_ hook: (@Sendable () async -> Void)?) { duringChoose = hook }
    func card(_ id: String) async throws -> OmniCard { served ?? list.first { $0.id == id }! }
    func replaceList(_ cards: [OmniCard]) { list = cards }
    func failNextChoose(_ errors: [any Error]) { chooseFailures = errors }
    func cards(section: CardSection?) async throws -> CardList {
        if let hook = duringList { await hook() }
        return CardList(cards: list, counts: .init(decide: list.filter { $0.section == .decide }.count, approve: list.filter { $0.section == .approve }.count, motion: list.filter { $0.section == .motion }.count))
    }
    func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        chooseKeys.append(idempotencyKey)
        if let hook = duringChoose { await hook() }
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
        await fake.failNextChoose([PrismError.conflict(ServerFailure(status: 409, code: "turn_running", detail: nil, body: Data()))])
        _ = await cards.choose("c1", optionID: "a")
        XCTAssertEqual(cards.card(for: "c1")?.state, .proposed, "rolled back")
        XCTAssertNotNil(cards.notice(for: "c1"))
        _ = await cards.choose("c1", optionID: "a")
        let keys = await fake.chooseKeys
        XCTAssertNotEqual(keys[0], keys[1])
    }

    func testCardNotOpenShowsTheCardAsItIsNowNotTheStaleSnapshot() async {
        let (cards, fake) = model([sample("c1", created: 1)])
        await cards.refresh()
        let now = sample("c1", created: 1).with(state: .working, chosenOptionId: "b", section: .motion)
        await fake.serve(now)
        await fake.failNextChoose([PrismError.conflict(ServerFailure(status: 409, code: "card_not_open", detail: nil, body: Data()))])
        let result = await cards.choose("c1", optionID: "a")
        XCTAssertNil(result)
        XCTAssertEqual(cards.card(for: "c1")?.state, .working)
        XCTAssertEqual(cards.inMotion.map(\.id), ["c1"])
        XCTAssertEqual(cards.notice(for: "c1"), "This was already handled.")
    }

    func testAnUnclearAnswerNeverRollsBackOverNewerServerData() async {
        let base = sample("c1", created: 1)
        let fake = CardFake([base])
        let model = CardsModel(service: fake, nudges: nil, sink: ErrorSink(onSignedOut: {}))
        await model.refresh()
        let newer = OmniCard(id: "c1", sourceKey: "src-c1", kind: .email, state: .draftReady, headline: "Sam asks about c1", options: base.options,
                             approvalIds: ["apr_1"], chosenOptionId: "a", createdAt: base.createdAt, updatedAt: Date(timeIntervalSince1970: 50), section: .approve)
        await fake.replaceList([newer])
        await fake.setDuringChoose { await model.refresh() }
        await fake.failNextChoose([URLError(.timedOut)])
        let first = await model.choose("c1", optionID: "a")
        XCTAssertNil(first)
        XCTAssertEqual(model.card(for: "c1")?.state, .draftReady, "the refresh saw the server's newer copy; the failed tap must not undo it")
        XCTAssertEqual(model.approve.map(\.id), ["c1"])
        XCTAssertEqual(model.linkedApprovalIDs, ["apr_1"])
        await fake.setDuringChoose(nil)
        _ = await model.choose("c1", optionID: "a")
        let keys = await fake.chooseKeys
        XCTAssertEqual(keys.count, 1, "a draft-ready card is no longer choosable, so nothing is sent again")
        XCTAssertNotNil(model.notice(for: "c1"))
    }

    func testAFailedNudgeActionKeepsTheCardAndSaysSo() async {
        let recorder = NudgeRecorder()
        let nudges = NudgeCenter(service: recorder, sink: ErrorSink(onSignedOut: {}))
        let (cards, _) = model([sample("n1", created: 1, transitional: true)], nudges: nudges)
        await cards.refresh()
        await cards.later("n1", until: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(cards.decide.map(\.id), ["n1"])
        XCTAssertNotNil(cards.notice(for: "n1"))
        let (bare, _) = model([sample("n2", created: 1, transitional: true)])
        await bare.refresh()
        await bare.notNeeded("n2")
        XCTAssertEqual(bare.decide.map(\.id), ["n2"], "no nudge centre, no request: the card stays")
        XCTAssertNotNil(bare.notice(for: "n2"))
    }

    func testARefreshDuringARefreshRunsAgain() async {
        let (cards, fake) = model([sample("c1", created: 1)])
        async let first: Void = cards.refresh()
        async let second: Void = cards.refresh()
        _ = await (first, second)
        await fake.replaceList([sample("c1", created: 1), sample("c2", created: 2)])
        await cards.refresh()
        XCTAssertEqual(cards.items.count, 2)
    }

    func testAWokenSnoozedCardInDecideCanBeChosen() async {
        let woken = sample("c1", created: 1).with(state: .snoozed, chosenOptionId: nil, section: .decide)
        let (cards, fake) = model([woken])
        await cards.refresh()
        XCTAssertEqual(cards.decide.map(\.id), ["c1"])
        let result = await cards.choose("c1", optionID: "a")
        XCTAssertEqual(result?.card.state, .draftReady)
        let keys = await fake.chooseKeys
        XCTAssertEqual(keys.count, 1)
        XCTAssertEqual(cards.approve.map(\.id), ["c1"])
        let instructed = await model([woken]).0.instruct("c1", text: "x")
        XCTAssertNil(instructed, "not loaded in that model: no card, no send")
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
        let linked = OmniCard(id: "c2", sourceKey: "src-c2", kind: .email, state: .draftReady, headline: "h", approvalIds: ["apr_linked"], createdAt: Date(timeIntervalSince1970: 2), updatedAt: Date(timeIntervalSince1970: 2), section: .approve)
        service.cardList = [sample("c1", created: 1), linked]
        service.pending(.success([Fixture.approval("apr_linked"), Fixture.approval("apr_free")]))
        await session.approvals.refresh()
        await session.cards?.refresh()
        XCTAssertEqual(session.needsYouCount, 3, "one decision, one draft ready, one draft that belongs to no card")
    }
}

@MainActor
final class NeedsYouRulesTests: XCTestCase {
    private func card(_ id: String, state: CardState, section: CardSection?, approvals: [String]) -> OmniCard {
        OmniCard(id: id, sourceKey: "src-\(id)", kind: .email, state: state, headline: "Sam asks about \(id)",
                 options: [.init(id: "a", label: "Yes", plan: "Yes", produces: [], draft: nil), .init(id: "b", label: "No", plan: "No", produces: [], draft: nil)],
                 recommended: "a", itemRefs: ["src-\(id)"], threadId: "t-\(id)", approvalIds: approvals,
                 createdAt: Date(timeIntervalSince1970: 1), updatedAt: Date(timeIntervalSince1970: 1), section: section)
    }

    func testAnEmptyListIsClearOnlyOnceBothHaveLoaded() {
        XCTAssertEqual(NeedsYouState.of(cards: .idle, approvals: .loaded, isEmpty: true), .loading)
        XCTAssertEqual(NeedsYouState.of(cards: .loaded, approvals: .loading, isEmpty: true), .loading)
        XCTAssertEqual(NeedsYouState.of(cards: .loaded, approvals: .idle, isEmpty: true), .loading)
        XCTAssertEqual(NeedsYouState.of(cards: .loaded, approvals: .loaded, isEmpty: true), .clear)
        XCTAssertEqual(NeedsYouState.of(cards: .failed("x"), approvals: .loaded, isEmpty: true), .items, "a failure is shown, never the all-clear")
        XCTAssertEqual(NeedsYouState.of(cards: .loading, approvals: .loading, isEmpty: false), .items)
    }

    func testOnlyTheLatestApprovalOfAShownCardIsLinked() {
        let model = CardsModel(service: CardFake([]), nudges: nil, sink: ErrorSink(onSignedOut: {}))
        model.ingest([
            card("shown", state: .draftReady, section: .approve, approvals: ["old", "latest"]),
            card("snoozed", state: .snoozed, section: .motion, approvals: ["on-snoozed"]),
            card("working", state: .working, section: .motion, approvals: ["on-working"]),
        ])
        XCTAssertEqual(model.linkedApprovalIDs, ["latest"], "an older approval, and one on a snoozed or working card, stay lone drafts")
        XCTAssertTrue(model.isShown("shown"))
        XCTAssertTrue(model.isShown("working"))
        XCTAssertFalse(model.isShown("not-loaded-yet"))
    }

    func testAThreadPlacesItsCardInlineByTime() throws {
        let card = sample("c1", created: 1_792_080_030)
        let detail = try PrismJSON.decoder().decode(ThreadDetail.self, from: Data("""
        {"thread":{"id":"t-c1","state":"waiting","unread":0,"pinned":false,"archived":false,"running":false,"lastSeq":2},
         "messages":[{"id":"m1","role":"assistant","text":"Sam asked about the budget.","at":"2026-10-15T16:00:00.000Z"},
                     {"id":"m2","role":"user","text":"Thanks","at":"2026-10-15T16:01:00.000Z"}],
         "cards":[],"approvals":[],"activeTurnId":null,"itemCards":[]}
        """.utf8))
        let withCard = ThreadDetail(thread: detail.thread, messages: detail.messages, cards: [], approvals: [], activeTurnId: nil, itemCards: [card])
        let rows = ThreadTimeline.history(withCard)
        XCTAssertEqual(rows.map(\.id), ["m:0-m1", "ic:c1", "m:1-m2"])
    }

    func testABackgroundRefreshKeepsTheLoadedPhaseButAFirstLoadShowsLoading() async {
        let fake = CardFake([sample("c1", created: 1)])
        let cards = CardsModel(service: fake, nudges: nil, sink: ErrorSink(onSignedOut: {}))
        let seen = PhaseLog()
        await fake.setDuringList { await MainActor.run { seen.phases.append(cards.phase) } }
        await cards.refresh()
        XCTAssertEqual(seen.phases, [.loading], "a first load is loading")
        await cards.refresh()
        XCTAssertEqual(seen.phases, [.loading, .loaded], "a refresh after a load never flips back to loading")
        XCTAssertEqual(cards.phase, .loaded)
    }

    func testAnItemCardEventForACardInTheThreadUpdatesItInPlace() throws {
        let model = CardsModel(service: CardFake([]), nudges: nil, sink: ErrorSink(onSignedOut: {}))
        let first = sample("c1", created: 1_792_080_030)
        model.ingest([first])
        model.ingest([first.with(state: .working, chosenOptionId: "a", section: .motion)])
        XCTAssertEqual(model.card(for: "c1")?.state, .working)
        XCTAssertEqual((model.decide + model.approve + model.inMotion).map(\.id), ["c1"], "one card, never two")
        let detail = ThreadDetail(thread: try PrismJSON.decoder().decode(ThreadDetail.self, from: Data(#"{"thread":{"id":"t","state":"waiting","unread":0,"pinned":false,"archived":false,"running":false,"lastSeq":1},"messages":[],"cards":[],"approvals":[],"activeTurnId":null}"#.utf8)).thread, messages: [], cards: [], approvals: [], activeTurnId: nil, itemCards: [first])
        XCTAssertEqual(ThreadTimeline.history(detail).map(\.id), ["ic:c1"])
    }
}

@MainActor private final class PhaseLog { var phases: [LoadPhase] = [] }

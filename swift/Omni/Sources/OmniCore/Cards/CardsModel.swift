import Foundation
import Observation
import OmniClient
import PrismTransport

/// The item-card routes the app calls. `LiveOmniService` is the real one; tests and the sample
/// gallery use fakes.
public protocol CardService: Sendable {
    func cards(section: CardSection?) async throws -> CardList
    func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult
    func instructCard(_ id: String, text: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult
    func snoozeCard(_ id: String, until: Date) async throws -> OmniCard
    func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard
}

extension LiveOmniService: CardService {
    public func cards(section: CardSection?) async throws -> CardList { try await client.cards(section: section) }
    public func chooseCardOption(_ id: String, optionID: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        try await client.chooseCardOption(id, optionID: optionID, idempotencyKey: idempotencyKey)
    }
    public func instructCard(_ id: String, text: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        try await client.instructCard(id, text: text, idempotencyKey: idempotencyKey)
    }
    public func snoozeCard(_ id: String, until: Date) async throws -> OmniCard { try await client.snoozeCard(id, until: until) }
    public func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard { try await client.dismissCard(id, reason: reason) }
}

/// Needs you's cards — Decide, Approve, In motion — and every card a thread shows (the same
/// object everywhere). A tap changes the card at once (optimistic) and is put back if the server
/// refuses; after an unclear answer the next tap of the same option reuses the same key, so the
/// server replays instead of acting twice.
@MainActor @Observable
public final class CardsModel {
    public private(set) var items: [OmniCard] = []
    public private(set) var phase: LoadPhase = .idle
    public private(set) var busy: Set<String> = []
    public private(set) var notices: [String: String] = [:]
    /// A notification tap: Needs you scrolls to and outlines this card.
    public var focusedCardID: String?
    /// A chosen draft became a pending approval: the approval center holds it (Send lives there).
    @ObservationIgnored public var approvalDidArrive: (@MainActor (Approval) -> Void)?

    private var known: [String: OmniCard] = [:]
    private let service: any CardService
    private let nudges: NudgeCenter?
    private let sink: ErrorSink
    @ObservationIgnored private var keys: [String: IdempotencyKey] = [:]

    public init(service: any CardService, nudges: NudgeCenter?, sink: ErrorSink) {
        self.service = service
        self.nudges = nudges
        self.sink = sink
    }

    public var decide: [OmniCard] { Self.ordered(items.filter { $0.section == .decide }) }
    public var approve: [OmniCard] { Self.ordered(items.filter { $0.section == .approve }) }
    public var inMotion: [OmniCard] { Self.ordered(items.filter { $0.section == .motion }) }
    /// Drafts that belong to a card are shown inside it, not again on their own.
    public var linkedApprovalIDs: Set<String> { Set(known.values.flatMap(\.approvalIds)) }
    public func card(for id: String) -> OmniCard? { known[id] }
    public func isBusy(_ id: String) -> Bool { busy.contains(id) }
    public func notice(for id: String) -> String? { notices[id] }
    public func focus(_ id: String?) { focusedCardID = id }

    static func ordered(_ cards: [OmniCard]) -> [OmniCard] {
        cards.sorted { a, b in
            if a.urgency.rank != b.urgency.rank { return a.urgency.rank < b.urgency.rank }
            return (a.createdAt ?? .distantFuture) < (b.createdAt ?? .distantFuture)
        }
    }

    public func refresh() async {
        guard phase != .loading else { return }
        phase = .loading
        do {
            let list = try await service.cards(section: nil)
            items = list.cards
            for card in list.cards { known[card.id] = card }
            phase = .loaded
        } catch {
            phase = .failed(sink.describe(error, reading: true) ?? "Couldn’t load what needs you")
        }
    }

    /// Cards from a thread's detail or its stream. Never steps back to an older copy.
    public func ingest(_ cards: [OmniCard]) {
        for card in cards {
            if let current = known[card.id], let a = current.updatedAt, let b = card.updatedAt, b < a { continue }
            put(card)
        }
    }

    private func put(_ card: OmniCard) {
        known[card.id] = card
        if let i = items.firstIndex(where: { $0.id == card.id }) {
            if card.section == nil { items.remove(at: i) } else { items[i] = card }
        } else if card.section != nil {
            items.append(card)
        }
    }

    private func fail(_ cardID: String, token: String, _ error: any Error) {
        if PlainLanguage.outcomeIsUnknown(error) {
            notices[cardID] = "Not sure that went through. Tap it again — it won’t happen twice."
        } else {
            keys[token] = nil
            notices[cardID] = sink.describe(error)
        }
    }

    /// One tap on an option. A draft becomes a pending approval (handed to `approvalDidArrive`);
    /// a plan starts Omni working in the card's thread. Nothing is sent.
    @discardableResult
    public func choose(_ cardID: String, optionID: String) async -> CardActionResult? {
        guard let card = known[cardID], !card.transitional, let option = card.options.first(where: { $0.id == optionID }), busy.insert(cardID).inserted else { return nil }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        let token = "choose:\(cardID):\(optionID)"
        let key = keys[token] ?? .random()
        keys[token] = key
        put(option.draft != nil ? card.with(state: .draftReady, chosenOptionId: optionID, section: .approve) : card.with(state: .working, chosenOptionId: optionID, section: .motion))
        do {
            let result = try await service.chooseCardOption(cardID, optionID: optionID, idempotencyKey: key)
            keys[token] = nil
            put(result.card)
            if let approval = result.approval { approvalDidArrive?(approval) }
            return result
        } catch {
            put(card)
            fail(cardID, token: token, error)
            return nil
        }
    }

    /// "Something else…": his own words start Omni working on the card.
    @discardableResult
    public func instruct(_ cardID: String, text: String) async -> CardActionResult? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let card = known[cardID], !card.transitional, !words.isEmpty, busy.insert(cardID).inserted else { return nil }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        let token = "instruct:\(cardID):\(words)"
        let key = keys[token] ?? .random()
        keys[token] = key
        put(card.with(state: .working, chosenOptionId: nil, section: .motion))
        do {
            let result = try await service.instructCard(cardID, text: words, idempotencyKey: key)
            keys[token] = nil
            put(result.card)
            return result
        } catch {
            put(card)
            fail(cardID, token: token, error)
            return nil
        }
    }

    /// Later. A card that is still a nudge snoozes the nudge.
    public func later(_ cardID: String, until: Date) async {
        guard let card = known[cardID], busy.insert(cardID).inserted else { return }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        if card.transitional, let nudgeID = card.nudgeId {
            await nudges?.act(nudgeID, .snooze, until: until)
            put(card.with(state: .snoozed, chosenOptionId: nil, section: nil))
            return
        }
        put(card.with(state: .snoozed, chosenOptionId: card.chosenOptionId, section: nil))
        do { put(try await service.snoozeCard(cardID, until: until)) } catch { put(card); notices[cardID] = sink.describe(error) }
    }

    /// Not needed: it leaves Needs you, and the sweep learns from it.
    public func notNeeded(_ cardID: String) async {
        guard let card = known[cardID], busy.insert(cardID).inserted else { return }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        if card.transitional, let nudgeID = card.nudgeId {
            await nudges?.act(nudgeID, .noise)
            put(card.with(state: .dismissed, chosenOptionId: nil, section: nil))
            return
        }
        put(card.with(state: .dismissed, chosenOptionId: card.chosenOptionId, section: nil))
        do { put(try await service.dismissCard(cardID, reason: .notNeeded)) } catch { put(card); notices[cardID] = sink.describe(error) }
    }

    /// Open on a card that is still a nudge: its conversation, or start one (the nudge's own route).
    public func openTransitional(_ cardID: String) async -> String? {
        guard let card = known[cardID], card.transitional, let nudgeID = card.nudgeId else { return nil }
        if let thread = card.threadId { return thread }
        return await nudges?.start(nudgeID, .startWorking)
    }
}

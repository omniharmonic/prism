import Foundation
import Observation
import OmniClient
import PrismTransport

/// The item-card routes the app calls. `LiveOmniService` is the real one; tests and the sample
/// gallery use fakes.
public protocol CardService: Sendable {
    func cards(section: CardSection?) async throws -> CardList
    func card(_ id: String) async throws -> OmniCard
    func chooseCardOption(_ id: String, optionID: String, cardVersion: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult
    func instructCard(_ id: String, text: String, cardVersion: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult
    func snoozeCard(_ id: String, until: Date) async throws -> OmniCard
    func dismissCard(_ id: String, reason: CardDismissReason) async throws -> OmniCard
}

extension LiveOmniService: CardService {
    public func cards(section: CardSection?) async throws -> CardList { try await client.cards(section: section) }
    public func card(_ id: String) async throws -> OmniCard { try await client.card(id) }
    public func chooseCardOption(_ id: String, optionID: String, cardVersion: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        try await client.chooseCardOption(id, optionID: optionID, cardVersion: cardVersion, idempotencyKey: idempotencyKey)
    }
    public func instructCard(_ id: String, text: String, cardVersion: String, idempotencyKey: IdempotencyKey) async throws -> CardActionResult {
        try await client.instructCard(id, text: text, cardVersion: cardVersion, idempotencyKey: idempotencyKey)
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
    private var dirty = false
    private var refreshing = false
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
    /// Drafts a card shows inside itself, so they are not listed again on their own: ONLY the latest
    /// approval of a card that is currently in Decide or Approve. Every other pending approval
    /// (a snoozed or working card's, an older one of a card) stays a lone draft, so none is hidden.
    public var linkedApprovalIDs: Set<String> { Set((decide + approve).compactMap(\.latestApprovalID)) }
    /// True when the card is in a loaded section (Decide, Approve or In motion).
    public func isShown(_ id: String) -> Bool { items.contains { $0.id == id && $0.section != nil } }
    public func card(for id: String) -> OmniCard? { known[id] }
    public func isBusy(_ id: String) -> Bool { busy.contains(id) }
    public func notice(for id: String) -> String? { notices[id] }
    public func focus(_ id: String?) { focusedCardID = id }

    /// The states the server accepts a choice from (a woken snoozed card is still `snoozed`).
    static func isChoosable(_ card: OmniCard) -> Bool { card.state == .proposed || card.state == .snoozed }
    /// …and an instruction ("Something else…"): also a draft-ready card, whose waiting draft it retires.
    static func isInstructable(_ card: OmniCard) -> Bool { isChoosable(card) || card.state == .draftReady }

    static func ordered(_ cards: [OmniCard]) -> [OmniCard] {
        cards.sorted { a, b in
            if a.urgency.rank != b.urgency.rank { return a.urgency.rank < b.urgency.rank }
            // A card with no creation time sorts first, as on the server.
            return (a.createdAt ?? .distantPast) < (b.createdAt ?? .distantPast)
        }
    }

    public func refresh() async {
        if refreshing { dirty = true; return }
        refreshing = true
        defer { refreshing = false }
        repeat {
            dirty = false
            // Stale-while-refresh: once loaded, a background refresh keeps the last phase so
            // Needs you never flashes "Checking what needs you…". A first load shows loading.
            if phase != .loaded { phase = .loading }
            do {
                let list = try await service.cards(section: nil)
                merge(list.cards)
                phase = .loaded
            } catch {
                phase = .failed(sink.describe(error, reading: true) ?? "Couldn’t load what needs you")
            }
        } while dirty
    }

    /// A server list never steps back to an older copy, and never overwrites a card mid-tap
    /// with a copy that is not newer than the tap's starting point.
    private func merge(_ cards: [OmniCard]) {
        var next: [OmniCard] = []
        var seen: Set<String> = []
        for card in cards {
            seen.insert(card.id)
            var chosen = card
            if let current = known[card.id], let a = current.updatedAt, let b = card.updatedAt {
                if b < a || (b == a && busy.contains(card.id)) { chosen = current }
            }
            known[card.id] = chosen
            if chosen.section != nil { next.append(chosen) }
        }
        // A card being tapped right now stays where the tap put it.
        for card in items where busy.contains(card.id) && !seen.contains(card.id) { next.append(card) }
        items = next
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
        if card.section == nil {
            for token in keys.keys where token.hasPrefix("choose:\(card.id):") || token.hasPrefix("instruct:\(card.id):") { keys[token] = nil }
        }
        if let i = items.firstIndex(where: { $0.id == card.id }) {
            if card.section == nil { items.remove(at: i) } else { items[i] = card }
        } else if card.section != nil {
            items.append(card)
        }
    }

    /// Put the card back as it was, but only if nothing newer has replaced the tap's own copy.
    private func rollBack(_ original: OmniCard, optimistic: OmniCard) {
        if known[original.id] == optimistic { put(original) }
    }

    private func failure(_ error: any Error) -> (code: String?, unclear: Bool) {
        if case .conflict(let f)? = error as? PrismError { return (f.code, false) }
        return (nil, PlainLanguage.outcomeIsUnknown(error) || error is CancellationError)
    }

    private func fail(_ cardID: String, token: String, original: OmniCard, optimistic: OmniCard, _ error: any Error) async {
        let (code, unclear) = failure(error)
        if unclear {
            rollBack(original, optimistic: optimistic)
            notices[cardID] = "Not sure that went through. Tap it again — it won’t happen twice."
            return
        }
        keys[token] = nil
        switch code {
        case "card_not_open":
            // Someone else (or the sweep) already moved it: show what it is now, not the stale snapshot.
            if let fresh = try? await service.card(cardID) { put(fresh) } else {
                // A refresh already running will be re-run; its copy replaces the optimistic one.
                let coalesced = refreshing
                await refresh()
                if !coalesced { rollBack(original, optimistic: optimistic) }
            }
            notices[cardID] = CardText.alreadyHandled
        case "card_changed":
            // New options or a new message since this copy was loaded: show the new version; he chooses again.
            if let fresh = try? await service.card(cardID) { put(fresh) } else {
                let coalesced = refreshing
                await refresh()
                if !coalesced { rollBack(original, optimistic: optimistic) }
            }
            notices[cardID] = CardText.cardChanged
        case "idempotency_conflict":
            rollBack(original, optimistic: optimistic)
            await refresh()
            notices[cardID] = sink.describe(error)
        default:
            rollBack(original, optimistic: optimistic)
            notices[cardID] = sink.describe(error)
        }
    }

    /// One tap on an option. A draft becomes a pending approval (handed to `approvalDidArrive`);
    /// a plan starts Omni working in the card's thread. Nothing is sent.
    @discardableResult
    public func choose(_ cardID: String, optionID: String) async -> CardActionResult? {
        guard let card = known[cardID], !card.transitional, let option = card.options.first(where: { $0.id == optionID }), !busy.contains(cardID) else { return nil }
        guard Self.isChoosable(card) else { notices[cardID] = CardText.alreadyHandled; return nil }
        busy.insert(cardID)
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        let token = "choose:\(cardID):\(optionID)"
        let key = keys[token] ?? .random()
        keys[token] = key
        let optimistic = option.draft != nil ? card.with(state: .draftReady, chosenOptionId: optionID, section: .approve) : card.with(state: .working, chosenOptionId: optionID, section: .motion)
        put(optimistic)
        do {
            let result = try await service.chooseCardOption(cardID, optionID: optionID, cardVersion: card.version ?? "", idempotencyKey: key)
            keys[token] = nil
            put(result.card)
            if let approval = result.approval { approvalDidArrive?(approval) }
            return result
        } catch {
            await fail(cardID, token: token, original: card, optimistic: optimistic, error)
            return nil
        }
    }

    /// "Something else…": his own words start Omni working on the card.
    @discardableResult
    public func instruct(_ cardID: String, text: String) async -> CardActionResult? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let card = known[cardID], !card.transitional, !words.isEmpty, !busy.contains(cardID) else { return nil }
        guard Self.isInstructable(card) else { notices[cardID] = CardText.alreadyHandled; return nil }
        busy.insert(cardID)
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        let token = "instruct:\(cardID):\(words)"
        let key = keys[token] ?? .random()
        keys[token] = key
        let optimistic = card.with(state: .working, chosenOptionId: nil, section: .motion)
        put(optimistic)
        do {
            let result = try await service.instructCard(cardID, text: words, cardVersion: card.version ?? "", idempotencyKey: key)
            keys[token] = nil
            put(result.card)
            return result
        } catch {
            await fail(cardID, token: token, original: card, optimistic: optimistic, error)
            return nil
        }
    }

    /// Later. A card that is still a nudge snoozes the nudge; a real card uses the card route.
    public func later(_ cardID: String, until: Date) async {
        guard let card = known[cardID], busy.insert(cardID).inserted else { return }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        if card.transitional {
            await viaNudge(card, .snooze, until: until, closed: card.with(state: .snoozed, chosenOptionId: nil, section: nil))
            return
        }
        let optimistic = card.with(state: .snoozed, chosenOptionId: card.chosenOptionId, section: nil)
        put(optimistic)
        do { put(try await service.snoozeCard(cardID, until: until)) } catch { rollBack(card, optimistic: optimistic); notices[cardID] = sink.describe(error) ?? CardText.couldNotDo }
    }

    /// Not needed: it leaves Needs you, and the sweep learns from it.
    public func notNeeded(_ cardID: String) async {
        guard let card = known[cardID], busy.insert(cardID).inserted else { return }
        defer { busy.remove(cardID) }
        notices[cardID] = nil
        if card.transitional {
            await viaNudge(card, .noise, until: nil, closed: card.with(state: .dismissed, chosenOptionId: nil, section: nil))
            return
        }
        let optimistic = card.with(state: .dismissed, chosenOptionId: card.chosenOptionId, section: nil)
        put(optimistic)
        do { put(try await service.dismissCard(cardID, reason: .notNeeded)) } catch { rollBack(card, optimistic: optimistic); notices[cardID] = sink.describe(error) ?? CardText.couldNotDo }
    }

    /// A card that is still a nudge acts through the nudge; it only leaves once the nudge took it.
    private func viaNudge(_ card: OmniCard, _ action: NudgeAction, until: Date?, closed: OmniCard) async {
        guard let nudges, let nudgeID = card.nudgeId else { notices[card.id] = CardText.couldNotDo; return }
        if await nudges.act(nudgeID, action, until: until) { put(closed) } else { notices[card.id] = nudges.failure ?? CardText.couldNotDo }
    }

    /// Open on a card that is still a nudge: its conversation, or start one (the nudge's own route).
    public func openTransitional(_ cardID: String) async -> String? {
        guard let card = known[cardID], card.transitional, let nudgeID = card.nudgeId else { return nil }
        if let thread = card.threadId { return thread }
        return await nudges?.start(nudgeID, .startWorking)
    }
}


/// What Needs you may say about an empty list. "You're clear" only after BOTH the cards and the
/// approvals have really loaded; before that the answer is "loading", never the all-clear.
public enum NeedsYouState: Equatable, Sendable {
    case loading, clear, items

    public static func of(cards: LoadPhase, approvals: LoadPhase, isEmpty: Bool) -> NeedsYouState {
        guard isEmpty else { return .items }
        if cards.failure != nil || approvals.failure != nil { return .items }
        return cards == .loaded && approvals == .loaded ? .clear : .loading
    }
}

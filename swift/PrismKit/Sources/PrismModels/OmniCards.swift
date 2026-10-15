import Foundation
import os

// MARK: - Item cards (`/api/omni/cards`, stream `item_card`; docs/omni-module.md § Item cards)

/// What kind of item a card is about. A value this build does not know still decodes.
public struct CardKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let email = CardKind(rawValue: "email")
    public static let message = CardKind(rawValue: "message")
    public static let invite = CardKind(rawValue: "invite")
    public static let task = CardKind(rawValue: "task")
    public static let scheduling = CardKind(rawValue: "scheduling")
    public static let other = CardKind(rawValue: "other")
}

/// `proposed → working → draft-ready → sent`, with `waiting`, `snoozed`, `dismissed`, `done`.
public struct CardState: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let proposed = CardState(rawValue: "proposed")
    public static let working = CardState(rawValue: "working")
    public static let draftReady = CardState(rawValue: "draft-ready")
    public static let sent = CardState(rawValue: "sent")
    public static let waiting = CardState(rawValue: "waiting")
    public static let snoozed = CardState(rawValue: "snoozed")
    public static let dismissed = CardState(rawValue: "dismissed")
    public static let done = CardState(rawValue: "done")
}

public struct CardUrgency: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let today = CardUrgency(rawValue: "today")
    public static let thisWeek = CardUrgency(rawValue: "this-week")
    public static let whenever = CardUrgency(rawValue: "whenever")
    /// Sort order: today first.
    public var rank: Int { self == .today ? 0 : self == .thisWeek ? 1 : 2 }
}

/// Where Needs you shows a card: Decide (proposed), Approve (draft ready), In motion (working, waiting).
public struct CardSection: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let decide = CardSection(rawValue: "decide")
    public static let approve = CardSection(rawValue: "approve")
    public static let motion = CardSection(rawValue: "motion")
}

/// Omni's understanding of one item plus what to do about it. `transitional` = a nudge that has no
/// card yet (no options; its actions go through the nudge routes, `nudgeId`).
public struct OmniCard: Codable, Sendable, Equatable, Identifiable {
    public struct Fact: Codable, Sendable, Equatable, Hashable {
        public let text: String
        /// Where the fact comes from: `calendar` or a note id. Nil for a nudge's summary.
        public let source: String?
        public init(text: String, source: String?) { self.text = text; self.source = source }
    }
    /// An exact outward payload in an existing approval kind. Choosing the option turns it into a
    /// PENDING approval; nothing is sent until Send on that approval.
    public struct Draft: Codable, Sendable, Equatable {
        public let kind: ApprovalKind
        public let payload: JSONValue
        public init(kind: ApprovalKind, payload: JSONValue) { self.kind = kind; self.payload = payload }
    }
    public struct Option: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let plan: String
        public let produces: [String]
        public let draft: Draft?
        public init(id: String, label: String, plan: String, produces: [String], draft: Draft?) {
            self.id = id; self.label = label; self.plan = plan; self.produces = produces; self.draft = draft
        }
    }

    public let id: String
    public let sourceKey: String
    public let kind: CardKind
    public let state: CardState
    public let headline: String
    public let context: [Fact]
    public let ask: String?
    public let urgency: CardUrgency
    public let options: [Option]
    public let recommended: String?
    public let itemRefs: [String]
    public let threadId: String?
    public let approvalIds: [String]
    public let chosenOptionId: String?
    public let createdAt: Date?
    public let updatedAt: Date?
    public let snoozedUntil: Date?
    public let section: CardSection?
    public let transitional: Bool
    public let nudgeId: String?

    public init(id: String, sourceKey: String, kind: CardKind, state: CardState, headline: String, context: [Fact] = [], ask: String? = nil,
                urgency: CardUrgency = .whenever, options: [Option] = [], recommended: String? = nil, itemRefs: [String] = [], threadId: String? = nil,
                approvalIds: [String] = [], chosenOptionId: String? = nil, createdAt: Date? = nil, updatedAt: Date? = nil, snoozedUntil: Date? = nil,
                section: CardSection? = nil, transitional: Bool = false, nudgeId: String? = nil) {
        self.id = id; self.sourceKey = sourceKey; self.kind = kind; self.state = state; self.headline = headline; self.context = context
        self.ask = ask; self.urgency = urgency; self.options = options; self.recommended = recommended; self.itemRefs = itemRefs
        self.threadId = threadId; self.approvalIds = approvalIds; self.chosenOptionId = chosenOptionId; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.snoozedUntil = snoozedUntil; self.section = section; self.transitional = transitional; self.nudgeId = nudgeId
    }

    enum CodingKeys: String, CodingKey {
        case id, sourceKey, kind, state, headline, context, ask, urgency, options, recommended, itemRefs, threadId, approvalIds
        case chosenOptionId, createdAt, updatedAt, snoozedUntil, section, transitional, nudgeId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sourceKey = try c.decodeIfPresent(String.self, forKey: .sourceKey) ?? ""
        kind = try c.decodeIfPresent(CardKind.self, forKey: .kind) ?? .other
        state = try c.decode(CardState.self, forKey: .state)
        headline = try c.decode(String.self, forKey: .headline)
        context = try c.decodeIfPresent([Fact].self, forKey: .context) ?? []
        ask = try c.decodeIfPresent(String.self, forKey: .ask)
        urgency = try c.decodeIfPresent(CardUrgency.self, forKey: .urgency) ?? .whenever
        options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
        recommended = try c.decodeIfPresent(String.self, forKey: .recommended)
        itemRefs = try c.decodeIfPresent([String].self, forKey: .itemRefs) ?? []
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
        approvalIds = try c.decodeIfPresent([String].self, forKey: .approvalIds) ?? []
        chosenOptionId = try c.decodeIfPresent(String.self, forKey: .chosenOptionId)
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(Date.self, forKey: .updatedAt)
        snoozedUntil = try? c.decodeIfPresent(Date.self, forKey: .snoozedUntil)
        section = try c.decodeIfPresent(CardSection.self, forKey: .section)
        transitional = try c.decodeIfPresent(Bool.self, forKey: .transitional) ?? false
        nudgeId = try c.decodeIfPresent(String.self, forKey: .nudgeId)
    }

    /// Decodes an array of cards, dropping elements that fail. Logs ONE line with the count dropped
    /// (never the card content). A missing key is an empty list; a non-array value still throws.
    private struct Slot: Decodable {
        let card: OmniCard?
        init(from decoder: any Decoder) throws { card = try? OmniCard(from: decoder) }
    }

    public static func decodeSkippingBad<K: CodingKey>(from container: KeyedDecodingContainer<K>, forKey key: K) throws -> [OmniCard] {
        guard container.contains(key) else { return [] }
        let slots = try container.decode([Slot].self, forKey: key)
        let cards = slots.compactMap(\.card)
        let dropped = slots.count - cards.count
        if dropped > 0 {
            Logger(subsystem: "PrismModels", category: "cards").error("skipped \(dropped, privacy: .public) undecodable card(s) of \(slots.count, privacy: .public)")
        }
        return cards
    }

    public var recommendedOption: Option? { options.first { $0.id == recommended } }
    /// One line built from the context facts ("You're free Thu 2–4 · Grant due Fri 5pm").
    public var contextLine: String { context.map(\.text).joined(separator: " · ") }
    /// The draft Send acts on (an Edit adds a newer one).
    public var latestApprovalID: String? { approvalIds.last }

    /// The same card in another state — the app's optimistic step before the server answers.
    public func with(state: CardState, chosenOptionId: String?, section: CardSection?) -> OmniCard {
        OmniCard(id: id, sourceKey: sourceKey, kind: kind, state: state, headline: headline, context: context, ask: ask, urgency: urgency,
                 options: options, recommended: recommended, itemRefs: itemRefs, threadId: threadId, approvalIds: approvalIds,
                 chosenOptionId: chosenOptionId, createdAt: createdAt, updatedAt: updatedAt, snoozedUntil: snoozedUntil,
                 section: section, transitional: transitional, nudgeId: nudgeId)
    }
}

/// `GET /api/omni/cards`: real cards and transitional nudge cards, urgency first then oldest.
public struct CardList: Decodable, Sendable, Equatable {
    public struct Counts: Decodable, Sendable, Equatable {
        public let decide: Int
        public let approve: Int
        public let motion: Int
        public init(decide: Int, approve: Int, motion: Int) { self.decide = decide; self.approve = approve; self.motion = motion }
    }
    public let cards: [OmniCard]
    public let counts: Counts
    public init(cards: [OmniCard], counts: Counts) { self.cards = cards; self.counts = counts }

    enum CodingKeys: String, CodingKey { case cards, counts }

    /// Element-wise: a card this build cannot decode is skipped, so one bad card never blanks Needs you.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cards = try OmniCard.decodeSkippingBad(from: c, forKey: .cards)
        counts = try c.decode(Counts.self, forKey: .counts)
    }
}

/// The answer to choose / instruct: the card, the pending approval a draft became (or nil), and the turn.
public struct CardActionResult: Decodable, Sendable, Equatable {
    public let card: OmniCard
    public let approval: Approval?
    public let threadId: String?
    public let turnId: String?
    public init(card: OmniCard, approval: Approval?, threadId: String?, turnId: String?) {
        self.card = card; self.approval = approval; self.threadId = threadId; self.turnId = turnId
    }
}

public enum CardDismissReason: String, Codable, Sendable {
    case notNeeded = "not-needed"
    case done
}

import Foundation
import os

// MARK: - Speaker reviews (`/api/omni/speaker-reviews`; docs/omni-module.md § Speaker reviews)

/// After a meeting Omni names the speakers it is sure of and asks about the rest: one review per
/// meeting. `auto` rows are already named; `ask` rows wait for the owner's answer.
public struct SpeakerReview: Codable, Sendable, Equatable, Identifiable {
    public struct Person: Codable, Sendable, Equatable, Hashable {
        public let name: String
        public let email: String?
        public init(name: String, email: String? = nil) { self.name = name; self.email = email }
    }

    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public enum Kind: String, Codable, Sendable { case auto, ask }
        public let id: String
        public let label: String
        /// Seconds this speaker spoke in the meeting.
        public let seconds: Int
        public let kind: Kind
        /// `high` / `medium` / `low` (a value this build does not know still decodes).
        public let confidence: String
        public let guess: Person?
        public let reasons: [String]
        public let quote: String?
        public let hasClip: Bool
        public init(id: String, label: String, seconds: Int, kind: Kind, confidence: String, guess: Person?, reasons: [String] = [], quote: String? = nil, hasClip: Bool = false) {
            self.id = id; self.label = label; self.seconds = seconds; self.kind = kind; self.confidence = confidence
            self.guess = guess; self.reasons = reasons; self.quote = quote; self.hasClip = hasClip
        }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            label = try c.decode(String.self, forKey: .label)
            seconds = Int((try c.decode(Double.self, forKey: .seconds)).rounded())
            kind = try c.decode(Kind.self, forKey: .kind)
            confidence = try c.decode(String.self, forKey: .confidence)
            guess = try c.decodeIfPresent(Person.self, forKey: .guess)
            reasons = try c.decodeIfPresent([String].self, forKey: .reasons) ?? []
            quote = try c.decodeIfPresent(String.self, forKey: .quote)
            hasClip = try c.decodeIfPresent(Bool.self, forKey: .hasClip) ?? false
        }
        /// Whole minutes spoken, at least 1 for anyone who spoke at all.
        public var minutes: Int { seconds <= 0 ? 0 : max(1, Int((Double(seconds) / 60).rounded())) }
        /// "Probably Alex Chen" (medium), "Maybe Alex Chen" (low) or "Not sure" (no guess).
        public var guessLine: String {
            guard let guess else { return "Not sure" }
            switch confidence {
            case "high": return guess.name
            case "medium": return "Probably \(guess.name)"
            default: return "Maybe \(guess.name)"
            }
        }
    }

    public enum Choice: String, Codable, Sendable { case confirm, other, skip }

    public struct Answer: Codable, Sendable, Equatable {
        public let choice: Choice
        public let name: String?
        public let email: String?
        public let at: Date?
        public init(choice: Choice, name: String? = nil, email: String? = nil, at: Date? = nil) {
            self.choice = choice; self.name = name; self.email = email; self.at = at
        }
        /// What the row shows once answered: "Alex Chen", or "Skipped".
        public var summary: String { choice == .skip ? "Skipped" : (name ?? "Answered") }
    }

    /// `open`, `done` or `expired` (display only: answers are still taken for 7 days).
    public let id: String
    public let title: String
    public let heldAt: Date?
    public let status: String
    public let createdAt: Date?
    public let rows: [Row]
    public let candidates: [Person]
    public let answers: [String: Answer]
    /// How many `ask` rows have no answer yet.
    public let pending: Int

    public init(id: String, title: String, heldAt: Date? = nil, status: String = "open", createdAt: Date? = nil, rows: [Row], candidates: [Person] = [], answers: [String: Answer] = [:], pending: Int? = nil) {
        self.id = id; self.title = title; self.heldAt = heldAt; self.status = status; self.createdAt = createdAt
        self.rows = rows; self.candidates = candidates; self.answers = answers
        self.pending = pending ?? rows.filter { $0.kind == .ask && answers[$0.id] == nil }.count
    }

    public var askRows: [Row] { rows.filter { $0.kind == .ask } }
    public var autoRows: [Row] { rows.filter { $0.kind == .auto } }
    public var isOpen: Bool { status == "open" }

    /// The same review with one more (or a replaced) answer — the app's optimistic step.
    public func with(answer: Answer, for rowID: String) -> SpeakerReview {
        var next = answers
        next[rowID] = answer
        return SpeakerReview(id: id, title: title, heldAt: heldAt, status: status, createdAt: createdAt, rows: rows, candidates: candidates, answers: next)
    }
}

public struct SpeakerReviewList: Decodable, Sendable, Equatable {
    public let reviews: [SpeakerReview]
    public init(reviews: [SpeakerReview]) { self.reviews = reviews }
    enum CodingKeys: String, CodingKey { case reviews }
    private struct Slot: Decodable {
        let review: SpeakerReview?
        init(from decoder: any Decoder) throws { review = try? SpeakerReview(from: decoder) }
    }
    /// Element-wise: a review this build cannot decode is skipped, so one never blanks the rest.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let slots = try c.decodeIfPresent([Slot].self, forKey: .reviews) ?? []
        let decoded = slots.compactMap(\.review)
        let dropped = slots.count - decoded.count
        if dropped > 0 {
            Logger(subsystem: "PrismModels", category: "speakers").error("skipped \(dropped, privacy: .public) undecodable review(s)")
        }
        reviews = decoded
    }
}

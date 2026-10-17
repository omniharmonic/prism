import Foundation
import OmniClient

/// The words cards use. One place, so Needs you, threads and notifications say the same thing.
public enum CardText {
    public static let alreadyHandled = "This was already handled."
    public static let couldNotDo = "Couldn’t do that just now. Try again."
    /// choose / instruct answered `card_changed`: the card on screen is now the new version.
    public static let cardChanged = "This card was updated — here’s the new version."
    /// A new message on the item after he chose: on the card and on its inline approval.
    public static let sourceChanged = "Something new arrived since this draft — review before sending."
    /// A draft recipient who was not on the original item (the approval view's label).
    public static let newRecipient = "New recipient"

    /// What happened to the card's last draft, when it is back in Decide because of it. Nil otherwise.
    public static func lastDraftLine(_ card: OmniCard) -> String? {
        guard card.state == .proposed || card.state == .snoozed, let last = card.lastOutcome else { return nil }
        switch (last.action, last.detail) {
        case ("draft-expired", _): return "The last draft expired before it was sent. Choose again."
        case ("draft-failed", "unknown"): return "The last draft may have been sent — check Sent before choosing again."
        case ("draft-failed", _): return "The last draft didn’t send. Choose again."
        default: return nil
        }
    }

    public static func kindLabel(_ kind: CardKind) -> String {
        switch kind {
        case .email: return "Email"
        case .message: return "Message"
        case .invite: return "Invite"
        case .task: return "Task"
        case .scheduling: return "Scheduling"
        default: return "Item"
        }
    }
    public static func kindSymbol(_ kind: CardKind) -> String {
        switch kind {
        case .email: return "envelope"
        case .message: return "bubble.left"
        case .invite: return "calendar"
        case .task: return "checklist"
        case .scheduling: return "calendar.badge.clock"
        default: return "tray"
        }
    }
    public static func urgencyLabel(_ urgency: CardUrgency) -> String? {
        switch urgency {
        case .today: return "Today"
        case .thisWeek: return "This week"
        default: return nil
        }
    }
    /// How long the item has waited: "5m", "2h", "3d".
    public static func age(_ date: Date?, now: Date = Date()) -> String? {
        guard let date else { return nil }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 3_600 { return "\(max(1, Int(seconds / 60)))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        return "\(Int(seconds / 86_400))d"
    }
    /// Where a context fact comes from, in words (the source id itself is not shown).
    public static func sourceLabel(_ source: String?) -> String {
        switch source {
        case nil: return "from the item"
        case "calendar": return "from your calendar"
        default: return "from a note in your vault"
        }
    }
    /// In motion, one line.
    public static func motionLine(_ card: OmniCard) -> String {
        card.state == .waiting ? "Waiting — \(card.headline)" : "Omni is working on it — \(card.headline)"
    }
    public static func closedLine(_ card: OmniCard) -> String {
        switch card.state {
        case .sent: return "Sent"
        case .done: return "Done"
        case .dismissed: return "Not needed"
        default: return "Closed"
        }
    }

    public struct LaterPreset: Identifiable, Sendable, Equatable {
        public let label: String
        public let until: Date
        public var id: String { label }
    }
    /// This evening (6 pm, when it is at least 30 minutes away), tomorrow morning (9 am), next week (Monday 9 am).
    public static func laterPresets(now: Date = Date(), calendar: Calendar = .current) -> [LaterPreset] {
        var out: [LaterPreset] = []
        if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now), evening > now.addingTimeInterval(1_800) {
            out.append(LaterPreset(label: "This evening", until: evening))
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
           let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) {
            out.append(LaterPreset(label: "Tomorrow morning", until: morning))
        }
        if let monday = calendar.nextDate(after: now, matching: DateComponents(hour: 9, minute: 0, weekday: 2), matchingPolicy: .nextTime) {
            out.append(LaterPreset(label: "Next week", until: monday))
        }
        return out
    }
}

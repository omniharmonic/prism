import Foundation

/// A nudge's kind (`candidate.kind`, the server's NUDGE_KINDS) in words for its card.
public enum NudgeKind {
    public static func label(_ kind: String) -> String {
        switch kind {
        case "reply-owed": return "Reply owed"
        case "unprocessed": return "Unread message"
        case "task": return "Task due"
        case "commitment": return "Commitment"
        case "meeting": return "Meeting"
        case "job": return "Job"
        case "freshness": return "Data freshness"
        default:
            // A kind this version does not know yet: its own words, readable.
            let words = kind.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
            return words.isEmpty ? "Nudge" : words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

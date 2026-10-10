import Foundation
import OmniClient

/// One row of a thread's transcript.
public enum TimelineItem: Identifiable, Equatable, Sendable {
    /// A stored message from the person or from Omni.
    case message(id: String, role: MessageRole, text: String, at: Date?)
    /// Omni's answer as it arrives. Not final until `isFinal`.
    case streamingText(id: String, text: String, isFinal: Bool)
    /// A message the person just sent that the server has not listed yet.
    case pendingMessage(text: String, failed: Bool)
    /// A tool the agent used. `ok` nil = still running (live) or not recorded (history).
    case tool(id: String, name: String, ok: Bool?, summary: String?, running: Bool)
    case card(id: String, card: RecordCard)
    /// Rendered from the ``ApprovalCenter`` by id, so every surface shows the same state.
    case approval(id: String)
    /// Why the last turn ended without finishing.
    case turnEnded(text: String)

    public var id: String {
        switch self {
        case .message(let id, _, _, _): return "m:\(id)"
        case .streamingText(let id, _, _): return "s:\(id)"
        case .pendingMessage: return "pending"
        case .tool(let id, _, _, _, _): return "t:\(id)"
        case .card(let id, _): return "c:\(id)"
        case .approval(let id): return "a:\(id)"
        case .turnEnded: return "ended"
        }
    }
}

/// Builds what a thread shows from its stored detail and the turn that is streaming.
public enum ThreadTimeline {
    public static func cardID(_ card: RecordCard) -> String {
        "\(card.noteId)|\(card.op.rawValue)|\(card.updatedAt ?? "")"
    }

    /// Stored history: messages in the server's order, with each approval and record card
    /// placed by its time (after the last message that is not newer). Anything without a
    /// usable time goes to the end.
    public static func history(_ detail: ThreadDetail, excludingApprovals: Set<String> = [], excludingCards: Set<String> = []) -> [TimelineItem] {
        var rows: [(at: Date?, item: TimelineItem)] = []
        for (index, message) in detail.messages.enumerated() {
            let id = "\(index)-\(message.id ?? "")"
            if message.role == .tool {
                rows.append((message.at, .tool(id: "h\(id)", name: message.toolName ?? "tool", ok: nil, summary: nil, running: false)))
            } else if let text = message.text, !text.isEmpty {
                rows.append((message.at, .message(id: id, role: message.role, text: message.role == .user ? userText(text) : text, at: message.at)))
            }
        }
        var extras: [(at: Date?, item: TimelineItem)] = []
        // Cards come newest first; show them oldest first.
        for card in detail.cards.reversed() {
            let id = cardID(card)
            guard !excludingCards.contains(id) else { continue }
            extras.append((card.updatedAt.flatMap(PrismJSON.parseDate), .card(id: id, card: card)))
        }
        for approval in detail.approvals.sorted(by: { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }) {
            guard !excludingApprovals.contains(approval.id) else { continue }
            extras.append((approval.createdAt, .approval(id: approval.id)))
        }
        for extra in extras.sorted(by: { ($0.at ?? .distantFuture) < ($1.at ?? .distantFuture) }) {
            guard let at = extra.at, let index = rows.firstIndex(where: { ($0.at ?? .distantPast) > at }) else {
                rows.append(extra)
                continue
            }
            rows.insert(extra, at: index)
        }
        return rows.map(\.item)
    }

    /// What the person's side of the transcript shows for a stored message. "Revise with
    /// Omni" is sent to the agent by the server as an instruction wrapped around the
    /// person's words ("Revise the email draft (approval apr_…) as follows. Propose the new
    /// draft with omni_propose; do not send anything." + their text); only their words are
    /// theirs, so only those are shown.
    public static func userText(_ stored: String) -> String {
        guard stored.hasPrefix("Revise the "), let marker = stored.range(of: " as follows. "), stored[..<marker.lowerBound].contains("draft (approval "),
              let gap = stored.range(of: "\n\n", range: marker.upperBound..<stored.endIndex) else { return stored }
        let words = stored[gap.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? stored : "Revise the draft: \(words)"
    }

    /// The streaming turn's rows.
    public static func live(_ transcript: TurnTranscript, turnRunning: Bool) -> [TimelineItem] {
        transcript.items.map { item in
            switch item {
            case .text(let blockId, let text, let isFinal):
                return .streamingText(id: blockId, text: text, isFinal: isFinal)
            case .tool(let call):
                return .tool(id: call.id, name: call.name, ok: call.ok, summary: call.summary, running: call.ok == nil && turnRunning)
            case .card(let card):
                return .card(id: cardID(card), card: card)
            case .approval(let approval):
                return .approval(id: approval.id)
            }
        }
    }

    /// A tool's name as a person would say it: `prism_update_note` → "Update note".
    public static func toolLabel(_ name: String) -> String {
        var words = name
        for prefix in ["prism_", "omni_"] where words.hasPrefix(prefix) { words.removeFirst(prefix.count) }
        words = words.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        guard !words.isEmpty else { return "Tool" }
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

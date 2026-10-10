import OmniClient
import OmniCore
import SwiftUI

struct TimelineRow: View {
    let item: TimelineItem
    let model: ThreadModel
    let approvals: ApprovalCenter

    var body: some View {
        switch item {
        case .message(_, let role, let text, _):
            if role == .user {
                UserBubble(text: text)
            } else {
                AgentText(text: text, streaming: false)
            }
        case .streamingText(_, let text, let isFinal):
            AgentText(text: text, streaming: !isFinal)
        case .pendingMessage(let text, let failed):
            // Once the server has taken it (the answer is on its way) it is simply the message.
            let sending = !failed && model.sendState == .sending
            UserBubble(text: text, caption: failed ? "Not delivered" : sending ? "Sending…" : nil)
                .opacity(sending ? 0.6 : 1)
        case .tool(_, let name, let ok, let summary, let running):
            ToolChip(name: name, ok: ok, summary: summary, running: running)
        case .card(_, let card):
            RecordCardView(card: card)
        case .approval(let id):
            ApprovalCardView(center: approvals, id: id)
        case .turnEnded(let text):
            Label(text, systemImage: "stop.circle")
                .font(.callout)
                .foregroundStyle(Color.quietText)
                .frame(maxWidth: .infinity)
        }
    }
}

struct UserBubble: View {
    let text: String
    var caption: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 14))
            if let caption {
                Text(caption).font(.caption).foregroundStyle(Color.quietText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)\(caption.map { ". \($0)" } ?? "")")
    }
}

struct AgentText: View {
    let text: String
    let streaming: Bool

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 6) {
            Text(rendered)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if streaming {
                ProgressView().controlSize(.mini).accessibilityLabel("Omni is still writing")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Omni: \(text)")
    }

    /// Inline markdown (bold, links, code) with the line breaks kept as written.
    private var rendered: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// A tool the agent used. Only its name and a short outcome: a tool's raw output never
/// reaches the app.
struct ToolChip: View {
    let name: String
    let ok: Bool?
    let summary: String?
    let running: Bool

    var body: some View {
        HStack(spacing: 6) {
            if running {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: ok == false ? "xmark.circle" : "wrench.and.screwdriver")
                    .foregroundStyle(ok == false ? AnyShapeStyle(.red) : AnyShapeStyle(Color.quietText))
            }
            Text(ThreadTimeline.toolLabel(name)).font(.callout)
            if let summary, !summary.isEmpty {
                Text(summary).font(.caption).foregroundStyle(Color.quietText).lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.6), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tool: \(ThreadTimeline.toolLabel(name)), \(running ? "running" : ok == false ? "failed" : "finished")\(summary.map { ". \($0)" } ?? "")")
    }
}

/// A record the agent changed. Tapping it opens the note in Prism; Omni never edits it.
struct RecordCardView: View {
    let card: RecordCard
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let link {
                if let native = link.native { openURL(native) { accepted in if !accepted { openURL(link.web) } } }
                else { openURL(link.web) }
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).font(.title3).foregroundStyle(Color.quietText).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.title ?? card.path ?? "Untitled note").fontWeight(.medium).lineLimit(typeSize.isAccessibilitySize ? 6 : 2)
                        .multilineTextAlignment(.leading)
                    Text(detail).font(.caption).foregroundStyle(Color.quietText).lineLimit(typeSize.isAccessibilitySize ? 6 : 2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                if link != nil {
                    Label("Open in Prism", systemImage: "arrow.up.right").labelStyle(.iconOnly).foregroundStyle(Color.quietText)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(link == nil)
        .accessibilityLabel("\(opLabel) \(card.type ?? "note"): \(card.title ?? "untitled")")
        .accessibilityHint(link == nil ? "" : "Opens the note in Prism")
    }

    private var opLabel: String {
        switch card.op {
        case .created: return "Created"
        case .updated: return "Updated"
        case .deleted: return "Deleted"
        case .commented: return "Commented on"
        case .suggested: return "Suggested an edit to"
        default: return "Changed"
        }
    }

    private var detail: String {
        var parts = ["\(opLabel) \(card.type ?? "note")"]
        if let summary = card.summary, !summary.isEmpty { parts.append(summary) }
        if card.private == true { parts.append("private") }
        return parts.joined(separator: " · ")
    }

    private var symbol: String {
        switch card.type {
        case "task": return "checkmark.square"
        case "person": return "person.crop.square"
        case "meeting": return "calendar"
        case "project": return "folder"
        default: return "doc.text"
        }
    }

    private var link: PrismSourceLink? {
        guard card.op != .deleted else { return nil }
        return PrismSourceLink(web: card.links?.prism, noteID: card.noteId)
    }
}

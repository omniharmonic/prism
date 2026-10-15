import OmniClient
import OmniCore
import SwiftUI

/// The one spacing scale every card uses (spec §6.2): 12 pt inside, 10 between rows, 44 pt targets.
enum CardMetrics {
    static let padding: CGFloat = 12
    static let spacing: CGFloat = 10
    static let optionSpacing: CGFloat = 8
    static let touch: CGFloat = 44
    static let corner: CGFloat = 14
    static let optionCorner: CGFloat = 10
}

enum CardLayout {
    /// iPhone (compact width) and every accessibility text size: options stacked, full width.
    /// Mac and iPad: wrapped chips.
    static func stacksOptions(compactWidth: Bool, accessibilitySize: Bool) -> Bool { compactWidth || accessibilitySize }
}

/// Lays children left to right and wraps onto as many rows as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = CardMetrics.optionSpacing

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width { y += row + spacing; x = 0; row = 0 }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX { y += row + spacing; x = bounds.minX; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

/// An option: 12 pt padding, a 44 pt target that is the whole chip, full width when stacked.
/// A custom style (not `.plain`) so the label itself fills the width and the whole chip is the hit area;
/// an explicit style also keeps two options in one iOS list row from being tapped together.
struct CardOptionStyle: ButtonStyle {
    let recommended: Bool
    let fullWidth: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, CardMetrics.padding)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: CardMetrics.touch, alignment: .leading)
            .foregroundStyle(recommended ? Color.omniAccent : Color.primary)
            .background(recommended ? AnyShapeStyle(Color.omniAccent.opacity(0.12)) : AnyShapeStyle(.quaternary.opacity(0.6)), in: RoundedRectangle(cornerRadius: CardMetrics.optionCorner))
            .overlay(RoundedRectangle(cornerRadius: CardMetrics.optionCorner).strokeBorder(recommended ? AnyShapeStyle(Color.omniAccent) : AnyShapeStyle(.separator)))
            .contentShape(RoundedRectangle(cornerRadius: CardMetrics.optionCorner))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// One item card, wherever it appears: Needs you, and inline in its thread (the same object, by id).
/// Every button here is the person's tap. An option with a draft makes that draft ready to REVIEW —
/// Send is a separate tap on the approval; nothing on this card sends anything.
struct CardView: View {
    let cards: CardsModel
    let approvals: ApprovalCenter
    let id: String
    /// Inside its own thread "Open thread" is not offered.
    var inThread = false
    @Environment(\.navigator) private var navigator
    @Environment(\.dynamicTypeSize) private var typeSize
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @State private var instruction = ""
    @State private var showsSources = false
    @State private var draftUnavailable = false

    var body: some View {
        if let card = cards.card(for: id) { content(card) }
    }

    private var stacked: Bool {
        #if os(iOS)
        return CardLayout.stacksOptions(compactWidth: sizeClass == .compact, accessibilitySize: typeSize.isAccessibilitySize)
        #else
        return CardLayout.stacksOptions(compactWidth: false, accessibilitySize: typeSize.isAccessibilitySize)
        #endif
    }

    @ViewBuilder private func content(_ card: OmniCard) -> some View {
        let focused = cards.focusedCardID == card.id
        VStack(alignment: .leading, spacing: CardMetrics.spacing) {
            header(card)
            if card.state == .sent || card.state == .done || card.state == .dismissed {
                closed(card)
            } else {
                Text(card.headline).font(.headline).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                contextLine(card)
                switch card.state {
                case .draftReady: draftReady(card)
                case .working, .waiting: motion(card)
                default: decide(card)
                }
                if let notice = cards.notice(for: card.id) {
                    Label(notice, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Color.warningText).fixedSize(horizontal: false, vertical: true)
                }
                footer(card)
            }
        }
        // Always its own full height: a container that offers less must scroll or grow, never
        // squeeze the rows into each other (Review Focus 4).
        .fixedSize(horizontal: false, vertical: true)
        .padding(CardMetrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: CardMetrics.corner))
        .overlay(RoundedRectangle(cornerRadius: CardMetrics.corner).strokeBorder(focused ? AnyShapeStyle(Color.omniAccent) : AnyShapeStyle(.separator), lineWidth: focused ? 2 : 1))
        .disabled(cards.isBusy(card.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(CardText.kindLabel(card.kind)): \(card.headline)")
        .accessibilityIdentifier("card.\(card.id)")
    }

    private func header(_ card: OmniCard) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Label([CardText.kindLabel(card.kind), CardText.age(card.createdAt)].compactMap { $0 }.joined(separator: " · "), systemImage: CardText.kindSymbol(card.kind))
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.quietText)
            Spacer(minLength: 8)
            if cards.isBusy(card.id) { ProgressView().controlSize(.small).accessibilityLabel("Working") }
            if let urgency = CardText.urgencyLabel(card.urgency) {
                Text(urgency)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .foregroundStyle(card.urgency == .today ? Color.warningText : Color.quietText)
                    .background(card.urgency == .today ? AnyShapeStyle(Color.warningText.opacity(0.12)) : AnyShapeStyle(.quaternary), in: Capsule())
                    .accessibilityLabel("Urgency: \(urgency)")
            }
        }
    }

    /// One line of facts; a tap shows where each comes from.
    @ViewBuilder private func contextLine(_ card: OmniCard) -> some View {
        if !card.context.isEmpty {
            Button { showsSources.toggle() } label: {
                Text(card.contextLine)
                    .font(.callout).foregroundStyle(Color.quietText)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: CardMetrics.touch, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityHint(showsSources ? "Hides where each fact comes from" : "Shows where each fact comes from")
            .accessibilityIdentifier("card.\(card.id).context")
            if showsSources {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(card.context, id: \.self) { fact in
                        Text("\(fact.text) — \(CardText.sourceLabel(fact.source))").font(.caption).foregroundStyle(Color.quietText).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    @ViewBuilder private func decide(_ card: OmniCard) -> some View {
        if !card.transitional {
            if let ask = card.ask { Text(ask).font(.callout).fixedSize(horizontal: false, vertical: true) }
            if stacked {
                VStack(alignment: .leading, spacing: CardMetrics.optionSpacing) { ForEach(card.options) { optionButton(card, $0, fullWidth: true) } }
            } else {
                FlowLayout { ForEach(card.options) { optionButton(card, $0, fullWidth: false) } }
            }
            if let draft = card.recommendedOption?.draft { DraftPreview(draft: draft).accessibilityIdentifier("card.\(card.id).draftPreview") }
            somethingElse(card)
        }
    }

    private func optionButton(_ card: OmniCard, _ option: OmniCard.Option, fullWidth: Bool) -> some View {
        let recommended = option.id == card.recommended
        return Button { Task { await cards.choose(card.id, optionID: option.id) } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if recommended { Image(systemName: "star.fill").font(.caption).accessibilityHidden(true) }
                Text(option.label).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(CardOptionStyle(recommended: recommended, fullWidth: fullWidth))
        .accessibilityLabel(recommended ? "Recommended: \(option.label)" : option.label)
        .accessibilityHint(option.draft != nil ? "Makes this draft ready for you to review. Nothing is sent." : "Omni starts on this. Nothing is sent without your approval.")
        .accessibilityIdentifier("card.\(card.id).option.\(option.id)")
    }

    private func somethingElse(_ card: OmniCard) -> some View {
        HStack(alignment: .bottom, spacing: CardMetrics.optionSpacing) {
            TextField("Something else…", text: $instruction, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .frame(minHeight: CardMetrics.touch)
                .accessibilityLabel("Something else")
                .accessibilityHint("Tell Omni how to handle this instead. Nothing is sent without your approval.")
                .accessibilityIdentifier("card.\(card.id).somethingElse")
            if !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button {
                    let text = instruction
                    Task { if await cards.instruct(card.id, text: text) != nil { instruction = "" } }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2).frame(minWidth: CardMetrics.touch, minHeight: CardMetrics.touch)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.omniAccent)
                .accessibilityLabel("Give Omni this instruction")
                .accessibilityIdentifier("card.\(card.id).somethingElse.submit")
            }
        }
    }

    /// A draft is ready: exactly the approval card (fields + the whole body, Send / Edit / Revise / Cancel).
    /// A draft this device has not seen is fetched; it never waits on one that nobody asked for.
    @ViewBuilder private func draftReady(_ card: OmniCard) -> some View {
        if let approvalID = card.latestApprovalID {
            if approvals.card(for: approvalID) != nil {
                ApprovalCardView(center: approvals, id: approvalID)
            } else if draftUnavailable {
                VStack(alignment: .leading, spacing: CardMetrics.optionSpacing) {
                    Label("Couldn’t load the draft.", systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Color.warningText).fixedSize(horizontal: false, vertical: true)
                    Button("Try again") { draftUnavailable = false }
                        .frame(minHeight: CardMetrics.touch)
                        .accessibilityIdentifier("card.\(card.id).draftRetry")
                }
            } else {
                Label("Loading the draft…", systemImage: "doc.text").font(.callout).foregroundStyle(Color.quietText)
                    .task(id: approvalID) { draftUnavailable = !(await approvals.load([approvalID])) }
            }
        }
    }

    private func motion(_ card: OmniCard) -> some View {
        Label(card.state == .waiting ? "Waiting on someone else" : "Omni is working on it", systemImage: card.state == .waiting ? "hourglass" : "gearshape.2")
            .font(.callout).foregroundStyle(Color.quietText)
    }

    /// Sent, done or not needed: one line.
    private func closed(_ card: OmniCard) -> some View {
        Label("\(CardText.closedLine(card)) · \(card.headline)", systemImage: card.state == .sent ? "checkmark.circle.fill" : "checkmark.circle")
            .font(.callout).foregroundStyle(Color.quietText)
            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
    }

    /// Quiet text buttons: Open thread · Later · Not needed. Restack when they do not fit.
    private func footer(_ card: OmniCard) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { footerButtons(card) }
            VStack(alignment: .leading, spacing: 0) { footerButtons(card) }
        }
        .font(.callout)
        .buttonStyle(.borderless)
    }

    @ViewBuilder private func footerButtons(_ card: OmniCard) -> some View {
        if !inThread {
            Button {
                Task {
                    let thread: String? = card.transitional ? await cards.openTransitional(card.id) : card.threadId
                    if let thread { navigator.open(.thread(thread)) }
                }
            } label: { Text(card.transitional ? "Open" : "Open thread").frame(minHeight: CardMetrics.touch).contentShape(Rectangle()) }
            .accessibilityIdentifier("card.\(card.id).open")
        }
        if card.state == .proposed || card.state == .snoozed {
            Menu {
                ForEach(CardText.laterPresets()) { preset in
                    Button(preset.label) { Task { await cards.later(card.id, until: preset.until) } }
                }
            } label: { Text("Later").frame(minHeight: CardMetrics.touch).contentShape(Rectangle()) }
            .fixedSize()
            .accessibilityIdentifier("card.\(card.id).later")
            Button { Task { await cards.notNeeded(card.id) } } label: { Text("Not needed").frame(minHeight: CardMetrics.touch).contentShape(Rectangle()) }
                .accessibilityHint("Takes this off Needs you. Omni learns from it.")
                .accessibilityIdentifier("card.\(card.id).notNeeded")
        }
    }
}

/// The recommended option's draft, before anything is approved. Verbatim; the body folds after four lines.
struct DraftPreview: View {
    let draft: OmniCard.Draft
    @State private var expanded = false

    var body: some View {
        let content = ApprovalContent(kind: draft.kind, payload: draft.payload)
        VStack(alignment: .leading, spacing: 6) {
            Text("Draft — nothing is sent until you approve it").font(.caption.weight(.semibold)).foregroundStyle(Color.quietText)
            ForEach(content.fields) { field in
                Text("\(field.label): \(field.value)").font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            if let body = content.body {
                Text(body).font(.callout).lineLimit(expanded ? nil : 4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Button(expanded ? "Show less" : "Show all") { expanded.toggle() }
                    .buttonStyle(.borderless).font(.callout).frame(minHeight: CardMetrics.touch)
            }
        }
        .padding(CardMetrics.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: CardMetrics.optionCorner))
        .accessibilityElement(children: .contain)
    }
}

/// In motion: one line per card; a tap opens its thread.
struct CardMotionRow: View {
    let card: OmniCard
    @Environment(\.navigator) private var navigator

    var body: some View {
        Button { if let thread = card.threadId { navigator.open(.thread(thread)) } } label: {
            HStack(spacing: 8) {
                Image(systemName: card.state == .waiting ? "hourglass" : "gearshape.2").foregroundStyle(Color.quietText).accessibilityHidden(true)
                Text(CardText.motionLine(card)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Color.quietText).accessibilityHidden(true)
            }
            .frame(minHeight: CardMetrics.touch)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("card.motion.\(card.id)")
    }
}

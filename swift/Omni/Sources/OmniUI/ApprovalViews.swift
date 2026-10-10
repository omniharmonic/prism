import OmniClient
import OmniCore
import SwiftUI

/// One approval, wherever it appears. Shows exactly what would be sent — every field, the
/// whole body — and offers Send only when that content matches the server's digest.
/// Every button here is a person's tap; nothing in the app presses them.
struct ApprovalCardView: View {
    let center: ApprovalCenter
    let id: String
    @State private var editing: ApprovalDraft?
    @State private var revising = false
    @State private var feedback = ""
    @State private var confirmingCancel = false

    var body: some View {
        if let card = center.card(for: id) {
            content(card)
        }
    }

    @ViewBuilder private func content(_ card: ApprovalCard) -> some View {
        let standing = card.standing()
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(header(standing, card), systemImage: symbol(standing))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint(standing))
                Spacer()
                if card.isBusy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
            }
            if standing == .revised {
                // A replaced draft is history: one line is enough.
                EmptyView()
            } else {
                draft(card.content)
            }
            if let line = card.statusLine() {
                Text(line).font(.callout).foregroundStyle(standing == .mismatch || standing == .unknown ? AnyShapeStyle(Color.warningText) : AnyShapeStyle(Color.quietText))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if standing == .pending, let off = card.sendingSwitchedOff {
                Label(off, systemImage: "powerplug").font(.caption).foregroundStyle(Color.quietText)
            }
            if let notice = card.notice {
                Label(notice.text, systemImage: noticeSymbol(notice.tone))
                    .font(.callout)
                    .foregroundStyle(noticeStyle(notice.tone))
                    .fixedSize(horizontal: false, vertical: true)
            }
            buttons(card, standing)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(standing == .pending ? AnyShapeStyle(.tint.opacity(0.5)) : AnyShapeStyle(.separator)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Approval: \(card.content.headline)")
        .sheet(item: $editing) { draft in
            ApprovalEditSheet(draft: draft, kindLabel: card.content.kindLabel) { edited in
                await center.saveEdit(card.id, draft: edited)
            }
        }
        .sheet(isPresented: $revising) {
            ReviseSheet(feedback: $feedback) {
                let text = feedback
                feedback = ""
                Task { await center.revise(card.id, feedback: text) }
            }
        }
    }

    @ViewBuilder private func draft(_ content: ApprovalContent) -> some View {
        if typeSize.isAccessibilitySize {
            // Each label above its value: beside it, a long address gets a column five characters wide.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(content.fields) { field in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(field.label).font(.callout).foregroundStyle(Color.quietText)
                        Text(field.value).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(field.label): \(field.value)")
                }
            }
        } else {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(content.fields) { field in
                GridRow {
                    Text(field.label).font(.callout).foregroundStyle(Color.quietText).gridColumnAlignment(.trailing)
                    Text(field.value).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(field.label): \(field.value)")
            }
        }
        }
        if let body = content.body {
            Divider()
            // The whole text, never shortened: what is approved is what is seen.
            Text(body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Text: \(body)")
        }
    }

    /// Side by side where the whole row fits; one under another where it does not (large
    /// text, a narrow column, a long label) — never squeezed onto two lines or cut.
    @ViewBuilder private func buttons(_ card: ApprovalCard, _ standing: ApprovalCard.Standing) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { actions(card, standing) }
            VStack(alignment: .leading, spacing: 8) { actions(card, standing) }
        }
        #if os(iOS)
        .buttonStyle(.bordered)
        #endif
        .disabled(card.isBusy)
    }

    @ViewBuilder private func actions(_ card: ApprovalCard, _ standing: ApprovalCard.Standing) -> some View {
        Group {
            if let retry = card.retry, standing == .pending {
                Button("Try Again") { Task { await center.retry(card.id) } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Repeats the \(retry.rawValue) decision; the server will not act on it twice")
            } else if card.canOfferSend() {
                Button(card.isCommand ? "Approve Once" : "Send") { Task { await center.send(card.id) } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("approval.send")
                    .accessibilityHint(card.isCommand ? "Lets Omni run exactly what is shown, once, after you confirm on this device" : "Sends exactly what is shown, after you confirm on this device")
            }
            if card.canOfferEdit() {
                Button("Edit") { editing = ApprovalDraft(card.approval) }
                    .accessibilityIdentifier("approval.edit")
                    .accessibilityHint("Change the wording yourself")
            }
            if card.canOfferCancel() && card.isCommand {
                Button("Deny", role: .destructive) { Task { await center.cancel(card.id) } }
                    .accessibilityHint("Omni does not run it")
            } else if card.canOfferCancel() {
                Button("Revise…") { revising = true }
                    .accessibilityIdentifier("approval.revise")
                    .accessibilityHint("Ask Omni for a new draft")
                Button("Cancel Draft") { confirmingCancel = true }
                    .accessibilityIdentifier("approval.cancel")
                    .accessibilityHint("Discards this draft; nothing is sent")
                    // On the button: the question appears beside what was pressed.
                    .confirmationDialog("Cancel this draft?", isPresented: $confirmingCancel, titleVisibility: .visible) {
                        Button("Cancel Draft", role: .destructive) { Task { await center.cancel(card.id) } }
                        Button("Keep", role: .cancel) {}
                    } message: {
                        Text("Nothing is sent. Omni can write a new one if you ask.")
                    }
            }
            if standing == .mismatch {
                Button("Reload") { Task { await center.reload(card.id) } }
                    .accessibilityHint("Reads the draft from the server again")
            }
        }
        .fixedSize()
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    private func header(_ standing: ApprovalCard.Standing, _ card: ApprovalCard) -> String {
        let kind = card.content.kindLabel
        if card.isCommand {
            switch standing {
            case .pending: return "OMNI IS WAITING · APPROVE?"
            case .sending: return "APPROVED · RUNNING"
            case .sent: return "APPROVED · RAN"
            case .failed: return "APPROVED · RAN AND FAILED"
            case .unknown: return "APPROVED · NO WORD BACK"
            case .cancelled, .revised: return "NOT RUN"
            case .expired: return "NOT RUN · NO ANSWER IN TIME"
            default: break
            }
        }
        switch standing {
        case .pending: return "APPROVE · \(kind)".uppercased()
        case .mismatch: return "CAN'T VERIFY · \(kind)".uppercased()
        case .sent: return "SENT · \(kind)".uppercased()
        case .failed: return "NOT SENT · \(kind)".uppercased()
        case .unknown: return "MAY HAVE BEEN SENT · \(kind)".uppercased()
        case .cancelled: return "CANCELLED · \(kind)".uppercased()
        case .expired: return "EXPIRED · \(kind)".uppercased()
        case .revised: return "REVISED · \(kind)".uppercased()
        case .sending: return "SENDING · \(kind)".uppercased()
        case .other(let status): return "\(status) · \(kind)".uppercased()
        }
    }

    private func symbol(_ standing: ApprovalCard.Standing) -> String {
        switch standing {
        case .pending: return "hand.raised"
        case .mismatch, .unknown: return "exclamationmark.triangle"
        case .sent: return "paperplane"
        case .failed: return "xmark.circle"
        default: return "tray"
        }
    }

    private func tint(_ standing: ApprovalCard.Standing) -> AnyShapeStyle {
        switch standing {
        case .pending: return AnyShapeStyle(.tint)
        case .mismatch, .unknown: return AnyShapeStyle(Color.warningText)
        default: return AnyShapeStyle(Color.quietText)
        }
    }

    private func noticeSymbol(_ tone: ApprovalCard.Tone) -> String {
        switch tone {
        case .info: return "info.circle"
        case .success: return "checkmark.circle"
        case .warning: return "exclamationmark.triangle"
        case .failure: return "xmark.octagon"
        }
    }

    private func noticeStyle(_ tone: ApprovalCard.Tone) -> AnyShapeStyle {
        switch tone {
        case .warning: return AnyShapeStyle(Color.warningText)
        case .failure: return AnyShapeStyle(Color.failureText)
        default: return AnyShapeStyle(Color.quietText)
        }
    }
}

struct ApprovalEditSheet: View {
    @State var draft: ApprovalDraft
    let kindLabel: String
    let save: (ApprovalDraft) async -> Bool
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    /// The body's box grows with the text size.
    @ScaledMetric private var editorHeight: CGFloat = 160

    var body: some View {
        NavigationStack {
            Form {
                ForEach($draft.fields) { $field in
                    Section(field.label) {
                        if field.multiline {
                            TextEditor(text: $field.text).frame(minHeight: editorHeight).accessibilityLabel(field.label)
                        } else {
                            // The section already names it: no second label beside the field.
                            TextField(field.label, text: $field.text).labelsHidden().accessibilityLabel(field.label)
                        }
                    }
                }
                Section {
                    Text("Saving makes a new draft to review. Recipients and times can't be changed here — ask Omni to revise instead.")
                        .font(.footnote)
                        .foregroundStyle(Color.quietText)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Edit \(kindLabel)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            let saved = await save(draft)
                            saving = false
                            // A failure is explained on the card underneath.
                            _ = saved
                            dismiss()
                        }
                    }
                    .disabled(saving || !draft.hasChanges)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 380)
    }
}

struct ReviseSheet: View {
    @Binding var feedback: String
    let submit: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("What should change?") {
                    // The example is a prompt inside the field, not a label beside it.
                    TextField("What should change", text: $feedback, prompt: Text("Make it shorter, mention Friday…"), axis: .vertical)
                        .labelsHidden()
                        .lineLimit(3...8)
                        .accessibilityLabel("What should change")
                }
                Section {
                    Text("This draft is set aside and Omni writes a new one for you to review. Nothing is sent.")
                        .font(.footnote)
                        .foregroundStyle(Color.quietText)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Revise")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask Omni") {
                        submit()
                        dismiss()
                    }
                    .disabled(feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .frame(minWidth: 380, minHeight: 240)
    }
}

/// Needs you: every draft waiting for a decision. (Nudges join this queue in M3.)
struct NeedsYouView: View {
    let session: SessionModel
    @Environment(\.navigator) private var navigator
    @State private var showLater = false

    private func refresh() async { await session.approvals.refresh(); await session.nudges?.refresh() }
    var body: some View {
        let pending = session.approvals.pending
        let nudges = session.nudges?.items ?? []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let center = session.nudges {
                    DisclosureGroup("Proactivity") {
                        Picker("Attention level", selection: Binding(get: { center.settings.dial }, set: { dial in
                            Task { await center.save(NudgeSettings(dial: dial, killed: center.settings.killed)) }
                        })) {
                            ForEach(ProactivityDial.allCases, id: \.self) { dial in Text(dial.rawValue.capitalized).tag(dial) }
                        }
                        Toggle("Pause nudges", isOn: Binding(get: { center.settings.killed }, set: { killed in
                            Task { await center.save(NudgeSettings(dial: center.settings.dial, killed: killed)) }
                        }))
                        Text("Off and Pause keep your queue available. Apple’s notification settings and Focus control delivery; Omni does not read your current Focus. Drafts always need your review.").font(.caption).foregroundStyle(.secondary)
                    }.disabled(center.busy.contains("settings") || center.phase != .loaded)
                    if let failure = center.phase.failure ?? center.failure {
                        Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                        Button("Retry nudges") { Task { await center.refresh() } }.frame(minHeight: 44)
                    }
                }
                if let failure = session.approvals.phase.failure {
                    Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                    Button("Retry drafts") { Task { await session.approvals.refresh() } }.frame(minHeight: 44)
                }
                if pending.isEmpty && nudges.isEmpty && session.approvals.phase.failure == nil && session.nudges?.phase.failure == nil {
                    ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("Drafts and items needing your attention appear here. Nothing goes out without your tap."))
                }
                ForEach(nudges) { nudge in
                    if let center = session.nudges { NudgeCardView(center: center, item: nudge) }
                }
                ForEach(pending) { card in
                    VStack(alignment: .leading, spacing: 6) {
                        ApprovalCardView(center: session.approvals, id: card.id)
                        if let threadID = card.approval.threadId {
                            Button("Open thread") { navigator.open(.thread(threadID)) }
                                .buttonStyle(.borderless).font(.callout).frame(minHeight: 44)
                        }
                    }
                }
                if let center = session.nudges, !center.later.isEmpty {
                    DisclosureGroup("Later", isExpanded: $showLater) {
                        ForEach(center.later) { NudgeCardView(center: center, item: $0) }
                    }
                }
            }
            .padding().frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity)
        }
        .navigationTitle("Needs you")
        .refreshable { await refresh() }
        .toolbar { ToolbarItem { Button { Task { await refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task { await refresh() }
    }
}

private struct NudgeCardView: View {
    let center: NudgeCenter
    let item: OmniNudge
    @Environment(\.navigator) private var navigator
    @Environment(\.openURL) private var openURL
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(item.candidate.title).font(.headline)
            Text(item.candidate.summary).font(.body)
            Text(item.candidate.reasons.joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack { primaryActions }
                VStack(alignment: .leading) { primaryActions }
            }
            HStack {
                Button("Snooze") { Task { await center.act(item.id, .snooze, until: Date().addingTimeInterval(86400)) } }
                Button("Not important") { Task { await center.act(item.id, .noise) } }
                Menu {
                    Button("Relevant") { Task { await center.act(item.id, .relevant) } }
                    Button("Hide") { Task { await center.act(item.id, .dismiss) } }
                } label: { Image(systemName: "ellipsis").accessibilityLabel("More nudge actions") }
                if let text = item.sourceLink, let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    Button("Open source") { openURL(url) }
                }
            }.buttonStyle(.borderless).font(.callout).frame(minHeight: 44)
        }
        .padding().background(.background, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.quaternary, lineWidth: 1))
        .disabled(center.busy.contains(item.id))
    }
    @ViewBuilder private var primaryActions: some View {
        Button("Draft reply") { start(.draftReply) }.buttonStyle(.bordered).frame(minHeight: 44)
        Button("Start working") { start(.startWorking) }.buttonStyle(.bordered).frame(minHeight: 44)
    }
    private func start(_ action: NudgeStart) {
        Task { if let thread = await center.start(item.id, action) { navigator.open(.thread(thread)) } }
    }
}

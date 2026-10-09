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
                Text(line).font(.callout).foregroundStyle(standing == .mismatch || standing == .unknown ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if standing == .pending, let off = card.sendingSwitchedOff {
                Label(off, systemImage: "powerplug").font(.caption).foregroundStyle(.secondary)
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
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
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
        .confirmationDialog("Cancel this draft?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Cancel Draft", role: .destructive) { Task { await center.cancel(card.id) } }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("Nothing is sent. Omni can write a new one if you ask.")
        }
    }

    @ViewBuilder private func draft(_ content: ApprovalContent) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(content.fields) { field in
                GridRow {
                    Text(field.label).font(.callout).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                    Text(field.value).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(field.label): \(field.value)")
            }
        }
        if let body = content.body {
            Divider()
            // The whole text, never shortened: what is approved is what is seen.
            Text(body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Text: \(body)")
        }
    }

    @ViewBuilder private func buttons(_ card: ApprovalCard, _ standing: ApprovalCard.Standing) -> some View {
        HStack(spacing: 8) {
            if let retry = card.retry, standing == .pending {
                Button("Try Again") { Task { await center.retry(card.id) } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Repeats the \(retry.rawValue) decision; the server will not act on it twice")
            } else if card.canOfferSend() {
                Button("Send") { Task { await center.send(card.id) } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Sends exactly what is shown, after you confirm on this device")
            }
            if card.canOfferEdit() {
                Button("Edit") { editing = ApprovalDraft(card.approval) }
                    .accessibilityHint("Change the wording yourself")
            }
            if card.canOfferCancel() {
                Button("Revise…") { revising = true }
                    .accessibilityHint("Ask Omni for a new draft")
                Button("Cancel Draft") { confirmingCancel = true }
                    .accessibilityHint("Discards this draft; nothing is sent")
            }
            if standing == .mismatch {
                Button("Reload") { Task { await center.reload(card.id) } }
                    .accessibilityHint("Reads the draft from the server again")
            }
        }
        .disabled(card.isBusy)
    }

    private func header(_ standing: ApprovalCard.Standing, _ card: ApprovalCard) -> String {
        let kind = card.content.kindLabel
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
        case .mismatch, .unknown: return AnyShapeStyle(.orange)
        default: return AnyShapeStyle(.secondary)
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
        case .warning: return AnyShapeStyle(.orange)
        case .failure: return AnyShapeStyle(.red)
        default: return AnyShapeStyle(.secondary)
        }
    }
}

struct ApprovalEditSheet: View {
    @State var draft: ApprovalDraft
    let kindLabel: String
    let save: (ApprovalDraft) async -> Bool
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                ForEach($draft.fields) { $field in
                    Section(field.label) {
                        if field.multiline {
                            TextEditor(text: $field.text).frame(minHeight: 160).accessibilityLabel(field.label)
                        } else {
                            // The section already names it: no second label beside the field.
                            TextField(field.label, text: $field.text).labelsHidden().accessibilityLabel(field.label)
                        }
                    }
                }
                Section {
                    Text("Saving makes a new draft to review. Recipients and times can't be changed here — ask Omni to revise instead.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
                        .foregroundStyle(.secondary)
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

    var body: some View {
        let pending = session.approvals.pending
        Group {
            if let failure = session.approvals.phase.failure, pending.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(failure)
                } actions: {
                    Button("Try Again") { Task { await session.approvals.refresh() } }
                }
            } else if pending.isEmpty {
                ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("Drafts that need your decision appear here. Nothing goes out without your tap."))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(pending) { card in
                            VStack(alignment: .leading, spacing: 6) {
                                ApprovalCardView(center: session.approvals, id: card.id)
                                if let threadID = card.approval.threadId {
                                    Button("Open thread") { navigator.open(.thread(threadID)) }
                                        .buttonStyle(.borderless)
                                        .font(.callout)
                                        .accessibilityHint("Shows the conversation this draft came from")
                                }
                            }
                        }
                    }
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("Needs you")
        .refreshable { await session.approvals.refresh() }
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await session.approvals.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await session.approvals.refresh() }
    }
}

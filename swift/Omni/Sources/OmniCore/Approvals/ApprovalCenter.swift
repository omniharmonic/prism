import Foundation
import Observation
import OmniClient
import PrismTransport

/// Asks the person to confirm a send on this device (Touch ID / Face ID / the device
/// passcode). The app supplies the real one; the default lets tests through.
public protocol SendConfirmation: Sendable {
    /// `reason` finishes the system's sentence "Omni is trying to …".
    func confirm(reason: String) async -> Bool
}

public struct NoSendConfirmation: SendConfirmation {
    public init() {}
    public func confirm(reason: String) async -> Bool { true }
}

/// One approval as every surface shows it (the card in a thread, the Needs you list).
public struct ApprovalCard: Equatable, Sendable, Identifiable {
    public enum Activity: Equatable, Sendable {
        case idle
        case deciding(ApprovalDecisionKind)
        case savingEdit
        case reloading
    }

    public enum Tone: Equatable, Sendable {
        case info, success, warning, failure
    }

    /// Something that just happened, in plain words.
    public struct Notice: Equatable, Sendable {
        public let tone: Tone
        public let text: String
    }

    /// Where the approval stands, for display.
    public enum Standing: Equatable, Sendable {
        /// Waiting for a decision, and what is shown is what would be sent.
        case pending
        /// The payload held here does not hash to the server's digest: Send is not offered.
        case mismatch
        case expired
        /// Claimed by a decision that is still executing.
        case sending
        case sent
        /// Provably not sent.
        case failed
        /// The sender may have acted. Check before sending again.
        case unknown
        case cancelled
        case revised
        case other(String)
    }

    public var approval: Approval
    public var activity: Activity = .idle
    public var notice: Notice?
    /// A decision was made whose outcome is not known: Try again resends it with the same
    /// `Idempotency-Key`.
    public var retry: ApprovalDecisionKind?

    public var id: String { approval.id }
    public var content: ApprovalContent { ApprovalContent(approval) }

    public func standing(now: Date = Date()) -> Standing {
        switch approval.status {
        case .pending:
            if !approval.digestMatchesPayload { return .mismatch }
            if let expires = approval.expiresAt, expires <= now { return .expired }
            return .pending
        case .approved: return .sending
        case .sent: return .sent
        case .failed: return .failed
        case .unknown: return .unknown
        case .expired: return .expired
        case .cancelled: return .cancelled
        case .revised: return .revised
        default: return .other(approval.status.rawValue)
        }
    }

    public var isBusy: Bool { activity != .idle }

    /// A paused tool call of a running turn (kind `command`), not a draft: approving it lets
    /// that exact call run once; there is nothing to edit or revise.
    public var isCommand: Bool { approval.kind == .command }

    /// Send is offered only for a pending draft whose payload matches its digest.
    public func canOfferSend(now: Date = Date()) -> Bool { standing(now: now) == .pending && !isBusy }
    public func canOfferCancel(now: Date = Date()) -> Bool { standing(now: now) == .pending && !isBusy }
    public func canOfferEdit(now: Date = Date()) -> Bool { standing(now: now) == .pending && !isBusy && ApprovalDraft(approval) != nil }

    /// Known before any press: this server would refuse to send this kind right now.
    public var sendingSwitchedOff: String? {
        guard let executor = approval.executor, !executor.canSend else { return nil }
        if isCommand { return "Approving commands is switched off on this server." }
        return executor.available ? "Sending is switched off on this server." : "This server can't send this kind of thing yet."
    }

    /// The standing in words. nil while it is simply waiting.
    public func statusLine(now: Date = Date()) -> String? {
        if isCommand {
            switch standing(now: now) {
            case .pending: return "Omni has paused here. It runs exactly this if you approve, and nothing if you don't."
            case .mismatch: return "This doesn't match the fingerprint the server gave for it, so Omni won't offer to approve it. Reload it."
            case .expired: return "No answer in time — it was not run."
            case .sending: return "Approved — running…"
            case .sent: return "Approved — it ran."
            case .failed: return "Approved — it ran and reported a failure."
            case .unknown: return "Approved, but Omni never said how it ended. Ask it."
            case .cancelled: return approval.decidedVia == "turn-ended" || approval.decidedVia == "withdrawn" ? "The turn ended first — it was not run." : "Denied — it was not run."
            case .revised: return "Denied — it was not run."
            case .other(let status): return "Status: \(status)."
            }
        }
        switch standing(now: now) {
        case .pending: return nil
        case .mismatch: return "This draft doesn't match the fingerprint the server gave for it, so Omni won't offer to send it. Reload it."
        case .expired: return "Expired — nothing was sent."
        case .sending: return "Sending…"
        case .sent: return "Sent."
        case .failed:
            let code = approval.result?["error"]?.stringValue
            return "Not sent — the attempt failed before anything went out" + (code.map { " (\($0))." } ?? ".")
        case .unknown: return "This may have been sent — the sender never confirmed. Check before sending it again."
        case .cancelled: return "Cancelled — nothing was sent."
        case .revised: return "Replaced by a newer draft."
        case .other(let status): return "Status: \(status)."
        }
    }
}

/// Every approval the app has seen, and the only place a decision is made from.
///
/// - Send is refused locally when the payload does not hash to its digest.
/// - One `Idempotency-Key` per press. When the outcome of a press is not known, the key is
///   kept and resent by Try again (or by pressing the same button again), so nothing can
///   be sent twice. Any definite answer forgets it.
/// - An executor that is off is reported as exactly that: nothing was sent, the draft is
///   still pending.
/// - ``send(_:)``, ``cancel(_:)``, ``revise(_:feedback:)`` and ``saveEdit(_:draft:)`` are
///   for a person's tap only.
@MainActor
@Observable
public final class ApprovalCenter {
    public private(set) var phase: LoadPhase = .idle
    private var cards: [String: ApprovalCard] = [:]
    /// The pending queue, in the server's order (newest first).
    private var pendingIDs: [String] = []
    /// An edited draft's old id → the draft that replaced it.
    private var replacedBy: [String: String] = [:]

    private struct KeptKey {
        let decision: ApprovalDecisionKind
        let digest: String
        let feedback: String?
        let key: IdempotencyKey
    }
    private var keptKeys: [String: KeptKey] = [:]

    private let service: any OmniService
    private let sink: ErrorSink
    private let confirmation: any SendConfirmation
    /// Called with a thread id after a decision or an edit changed that thread.
    var threadDidChange: (@MainActor (String) async -> Void)?

    public init(service: any OmniService, sink: ErrorSink, confirmation: any SendConfirmation = NoSendConfirmation()) {
        self.service = service
        self.sink = sink
        self.confirmation = confirmation
    }

    /// The Needs you queue.
    public var pending: [ApprovalCard] {
        pendingIDs.compactMap { cards[$0] }.filter { $0.approval.status == .pending }
    }

    public var pendingCount: Int { pending.count }

    /// The card for an id — or, when that draft was edited here, the one that replaced it.
    public func card(for id: String) -> ApprovalCard? {
        var current = id
        var hops = 0
        while let next = replacedBy[current], hops < 8 {
            current = next
            hops += 1
        }
        return cards[current]
    }

    /// The key that would be sent for this decision right now, if one is being kept.
    func keptKey(for id: String) -> IdempotencyKey? { keptKeys[id]?.key }

    /// Take in approvals read elsewhere (a thread's detail, its stream, Today).
    static let writingNewDraft = "Omni is writing a new draft."

    public func ingest(_ approvals: [Approval]) {
        for approval in approvals {
            if var card = cards[approval.id] {
                if card.approval.digest != approval.digest { keptKeys[approval.id] = nil }
                if card.approval != approval {
                    card.approval = approval
                    if approval.status != .pending {
                        card.retry = nil
                        keptKeys[approval.id] = nil
                    }
                    cards[approval.id] = card
                }
            } else {
                cards[approval.id] = ApprovalCard(approval: approval)
                // The new draft a revise asked for has arrived: the set-aside one need not
                // go on saying that it is being written.
                if approval.status == .pending, let thread = approval.threadId {
                    for (id, card) in cards where card.approval.threadId == thread && card.approval.status == .revised && card.notice?.text == Self.writingNewDraft {
                        cards[id]?.notice = nil
                    }
                }
            }
            if approval.status != .pending {
                pendingIDs.removeAll { $0 == approval.id }
                // The server now lists the old draft as replaced: stop standing in for it.
                replacedBy[approval.id] = nil
            } else if !pendingIDs.contains(approval.id) {
                pendingIDs.insert(approval.id, at: 0)
            }
        }
    }

    /// Read the pending queue. Drafts that left it are read once more so their card shows
    /// what became of them.
    public func refresh() async {
        if cards.isEmpty { phase = .loading }
        do {
            let list = try await service.approvals(status: .pending)
            let listed = Set(list.map(\.id))
            let gone = pendingIDs.filter { !listed.contains($0) && cards[$0]?.approval.status == .pending }
            ingest(list)
            pendingIDs = list.map(\.id)
            phase = .loaded
            for id in gone {
                if let fresh = try? await service.approval(id) { ingest([fresh]) }
            }
        } catch {
            guard let message = sink.describe(error, reading: true) else { return }
            phase = .failed(message)
        }
    }

    /// Read one approval again (the Reload button on a mismatch or a conflict).
    public func reload(_ id: String) async {
        guard var card = cards[id], !card.isBusy else { return }
        card.activity = .reloading
        cards[id] = card
        defer { cards[id]?.activity = .idle }
        do {
            let fresh = try await service.approval(id)
            cards[id]?.notice = nil
            ingest([fresh])
        } catch {
            if let message = sink.describe(error) { cards[id]?.notice = .init(tone: .failure, text: message) }
        }
    }

    // MARK: Decisions (a person's tap only)

    public func send(_ id: String) async {
        await decide(id, .send, feedback: nil)
    }

    public func cancel(_ id: String) async {
        await decide(id, .cancel, feedback: nil)
    }

    /// Ask the agent for a new draft, with what should change.
    public func revise(_ id: String, feedback: String) async {
        let text = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        await decide(id, .revise, feedback: text.isEmpty ? nil : text)
    }

    /// Try again after an unclear outcome: the same decision with the same key.
    public func retry(_ id: String) async {
        guard let card = cards[id], let decision = card.retry, let kept = keptKeys[id] else { return }
        await decide(id, decision, feedback: kept.feedback)
    }

    private func decide(_ id: String, _ decision: ApprovalDecisionKind, feedback: String?) async {
        guard let card = cards[id], !card.isBusy else { return }
        let shown = card.approval
        guard shown.digestMatchesPayload else {
            cards[id]?.notice = .init(tone: .failure, text: PlainLanguage.message(for: OmniError.localDigestMismatch(approvalId: id)))
            return
        }
        guard card.standing() == .pending else { return }
        cards[id]?.activity = .deciding(decision)
        cards[id]?.notice = nil
        defer { cards[id]?.activity = .idle }

        if decision == .send {
            let reason = "send this \(card.content.kindLabel.lowercased())"
            guard await confirmation.confirm(reason: reason) else {
                cards[id]?.notice = .init(tone: .info, text: "Not sent — it wasn't confirmed on this device.")
                return
            }
        }

        // One key per press; the key of a press whose outcome is unknown is used again.
        let key: IdempotencyKey
        if let kept = keptKeys[id], kept.decision == decision, kept.digest == shown.digest, kept.feedback == feedback {
            key = kept.key
        } else {
            key = .random()
            keptKeys[id] = KeptKey(decision: decision, digest: shown.digest, feedback: feedback, key: key)
        }

        do {
            let outcome = try await service.decide(shown: shown, decision, feedback: feedback, idempotencyKey: key)
            keptKeys[id] = nil
            cards[id]?.retry = nil
            ingest([outcome.approval])
            if outcome.approval.status == .revised, outcome.turnId != nil {
                cards[id]?.notice = .init(tone: .info, text: Self.writingNewDraft)
            }
            if let threadID = outcome.approval.threadId { await threadDidChange?(threadID) }
        } catch let error as OmniError {
            keptKeys[id] = nil
            cards[id]?.retry = nil
            switch error {
            case .executorNotReady(let code, _):
                // Not a decision: nothing ran and the draft is still pending.
                cards[id]?.notice = .init(tone: .warning, text: PlainLanguage.executorNotReady(code) + " The draft is still waiting.")
            case .localDigestMismatch:
                cards[id]?.notice = .init(tone: .failure, text: PlainLanguage.message(for: error))
            }
        } catch {
            guard let message = sink.describe(error) else { return }
            if let e = error as? PrismError, definite(e) {
                keptKeys[id] = nil
                cards[id]?.retry = nil
                // The server knows something this card does not: show its version.
                if let fresh = try? await service.approval(id) { ingest([fresh]) }
                cards[id]?.notice = .init(tone: .warning, text: message)
            } else if let e = error as? PrismError, case .unreachable = e {
                cards[id]?.retry = decision
                cards[id]?.notice = .init(tone: .failure, text: "Can't reach the server. Nothing was sent.")
            } else {
                // 5xx, a timeout, a lost answer: the decision may have been carried out.
                cards[id]?.retry = decision
                cards[id]?.notice = .init(tone: .warning, text: "It isn't clear whether this went through. Try again — the server will not act on it twice.")
            }
        }
    }

    /// A refusal that settles the question (4xx): the key has no further use.
    private func definite(_ error: PrismError) -> Bool {
        switch error {
        case .conflict, .rejected, .forbidden, .invalidRequest: return true
        default: return false
        }
    }

    // MARK: Edit (a person's tap only)

    /// Replace a pending draft's text. The server answers a NEW draft with a new digest;
    /// the old one becomes `revised`. Returns true when the new draft is in place.
    public func saveEdit(_ id: String, draft: ApprovalDraft) async -> Bool {
        guard let card = cards[id], card.canOfferEdit() else { return false }
        guard draft.hasChanges else { return true }
        cards[id]?.activity = .savingEdit
        cards[id]?.notice = nil
        defer { cards[id]?.activity = .idle }
        do {
            let edit = try await service.editApproval(shown: card.approval, payload: draft.payload)
            keptKeys[id] = nil
            cards[id]?.retry = nil
            cards[edit.approval.id] = ApprovalCard(approval: edit.approval, notice: .init(tone: .info, text: "Edited. Review it before sending."))
            replacedBy[id] = edit.approval.id
            if let index = pendingIDs.firstIndex(of: id) {
                pendingIDs[index] = edit.approval.id
            } else {
                pendingIDs.insert(edit.approval.id, at: 0)
            }
            if let threadID = edit.approval.threadId { await threadDidChange?(threadID) }
            return true
        } catch {
            guard let message = sink.describe(error) else { return false }
            if PlainLanguage.outcomeIsUnknown(error) {
                // An edit has no idempotency key: read the queue instead of trying again.
                await refresh()
                cards[id]?.notice = .init(tone: .warning, text: "It isn't clear whether the edit was saved. The drafts were read again — check before editing once more.")
            } else {
                if let fresh = try? await service.approval(id) { ingest([fresh]) }
                cards[id]?.notice = .init(tone: .failure, text: message)
            }
            return false
        }
    }
}

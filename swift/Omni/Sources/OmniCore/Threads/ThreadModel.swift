import Foundation
import Observation
import OmniClient
import PrismTransport

/// One open thread: its stored history, the turn that is streaming, the composer.
///
/// Stream rules (PrismKit README § Streams):
/// - Events are applied once, by sequence number; live text deltas are replaced by the
///   block's final text (`TurnTranscript`).
/// - A stream that ends without the turn's `result` proves nothing: the thread is read
///   again and, while it still names an active turn, the stream is attached again from
///   the last event seen.
/// - One `Idempotency-Key` per press of Send. A retry after an unclear outcome resends the
///   SAME key, so the server answers the turn it already started.
@MainActor
@Observable
public final class ThreadModel {
    public enum Connection: Equatable, Sendable {
        case idle
        case live
        /// The connection dropped; PrismKit is reconnecting.
        case reconnecting
    }

    public enum SendState: Equatable, Sendable {
        case idle
        case sending
        /// The message is kept (``pendingText``). `retry` resends it with the same key.
        case failed(message: String)
    }

    public let threadID: String
    public private(set) var thread: OmniThread?
    public private(set) var phase: LoadPhase = .idle
    public private(set) var activeTurnID: String?
    public private(set) var connection: Connection = .idle
    public private(set) var sendState: SendState = .idle
    /// The message being delivered, or kept after a failed delivery.
    public private(set) var pendingText: String?
    /// Why the last turn did not finish (plain words); nil after a turn that worked.
    public private(set) var turnEnded: String?
    /// A problem with the live connection that reconnecting did not fix.
    public private(set) var streamProblem: String?
    public private(set) var isStopping = false
    /// The agent no longer has this conversation (the server answered 404, or the list
    /// already said so). Nothing is retried: the view offers to remove it or to check again.
    public private(set) var isUnavailable = false
    /// The view is on screen (set by ``open()`` / ``close()``).
    public private(set) var isOpen = false
    /// The thread's `lastSeq` when its stored events were last read for a failed turn's reason.
    private var outcomeReadAtSeq: Int?
    /// The composer's text.
    public var draft = ""

    private let service: any OmniService
    private let approvals: ApprovalCenter
    private let sink: ErrorSink
    private let sleep: @Sendable (Duration) async throws -> Void
    private var detail: ThreadDetail?
    private var transcript = TurnTranscript()
    /// The last persisted event applied or skipped: where a re-attach resumes.
    private var cursor = 0
    private var pendingKey: IdempotencyKey?
    private var followTask: Task<Void, Never>?
    private var followGeneration = 0
    /// Told when the server says the thread is gone, so the list can show it too.
    private let onUnavailable: @MainActor (String) -> Void
    private var isLoading = false
    private var createdVoiceTurn: String?
    private var replayedVoiceTurn: String?
    public private(set) var completedVoiceTimeline: [TimelineItem] = []

    /// Replay only the exact first turn created by this voice composer.
    public func rememberCreatedVoiceTurn(_ turn: String) { createdVoiceTurn = turn }
    public func takeCompletedVoiceTimeline() -> [TimelineItem] {
        let result = completedVoiceTimeline
        completedVoiceTimeline = []
        return result
    }

    init(threadID: String, service: any OmniService, approvals: ApprovalCenter, sink: ErrorSink, sleep: @escaping @Sendable (Duration) async throws -> Void, onUnavailable: @escaping @MainActor (String) -> Void = { _ in }) {
        self.threadID = threadID
        self.service = service
        self.approvals = approvals
        self.sink = sink
        self.sleep = sleep
        self.onUnavailable = onUnavailable
    }

    public var isRunning: Bool { activeTurnID != nil }
    public var canSend: Bool { !isUnavailable && !isRunning && sendState != .sending && pendingText == nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var title: String { thread.map(ThreadGrouping.displayTitle) ?? "Thread" }

    /// Everything the transcript shows, top to bottom.
    public var timeline: [TimelineItem] {
        let liveItems = ThreadTimeline.live(transcript, turnRunning: isRunning)
        var liveApprovals = Set<String>()
        var liveCards = Set<String>()
        for item in liveItems {
            if case .approval(let id) = item { liveApprovals.insert(id) }
            if case .card(let id, _) = item { liveCards.insert(id) }
        }
        var items = detail.map { ThreadTimeline.history($0, excludingApprovals: liveApprovals, excludingCards: liveCards) } ?? []
        if let pendingText {
            if case .failed = sendState {
                items.append(.pendingMessage(text: pendingText, failed: true))
            } else {
                items.append(.pendingMessage(text: pendingText, failed: false))
            }
        }
        items.append(contentsOf: liveItems)
        if let turnEnded, !isRunning { items.append(.turnEnded(text: turnEnded)) }
        return items
    }

    // MARK: Lifecycle

    /// The thread came on screen: read it and follow a running turn.
    ///
    /// - Parameter knownGone: the thread list already says the agent no longer has it —
    ///   nothing is asked of the server; the unavailable state is shown at once.
    public func open(knownGone: Bool = false) async {
        isOpen = true
        if knownGone, detail == nil { markUnavailable() }
        // Unavailable is not retried by coming back to the thread; "Check Again" asks.
        guard !isUnavailable else { return }
        await reload(showLoading: detail == nil)
    }

    /// The person asked to look again (the unavailable state's "Check Again", or Try Again).
    public func checkAgain() async {
        isUnavailable = false
        await reload(showLoading: true)
    }

    private func markUnavailable() {
        stopFollowing()
        isUnavailable = true
        activeTurnID = nil
        streamProblem = nil
        phase = .failed(PlainLanguage.threadUnavailable)
        onUnavailable(threadID)
    }

    /// The thread left the screen: drop the live connection. A running turn keeps running
    /// on the server; ``open()`` attaches to it again.
    public func close() {
        isOpen = false
        stopFollowing()
    }

    /// A notice named this thread (an agent-initiated message, a decision, a new card).
    public func changedOnServer() async {
        // While a turn streams, its own events carry the news. A thread that is gone, or
        // whose first read has not answered yet, is not asked again by a notice.
        guard isOpen, followTask == nil, !isUnavailable, !isLoading else { return }
        await reload(showLoading: false)
    }

    public func reload() async {
        guard !isUnavailable else { return }
        await reload(showLoading: false)
    }

    private func reload(showLoading: Bool) async {
        // One read at a time: opening a thread while a notice arrives must not ask twice.
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        if showLoading { phase = .loading }
        do {
            let fresh = try await service.thread(threadID)
            apply(fresh)
            isUnavailable = false
            phase = .loaded
            if let turn = createdVoiceTurn, followTask == nil {
                createdVoiceTurn = nil
                replayedVoiceTurn = turn
                startFollowing(turn: turn, replayTurn: true)
            } else if let turn = fresh.activeTurnId {
                if followTask == nil { startFollowing(turn: turn, replayTurn: true) }
            } else if followTask == nil {
                activeTurnID = nil
                await readWhyTheLastTurnFailed(fresh)
            }
        } catch {
            if PlainLanguage.isNotFound(error) {
                markUnavailable()
                return
            }
            guard let message = sink.describe(error, reading: true) else {
                // Signed out or cancelled: never leave the spinner up.
                if detail == nil, phase == .loading { phase = .idle }
                return
            }
            if detail == nil { phase = .failed(message) } else { streamProblem = message }
        }
    }

    private func apply(_ fresh: ThreadDetail) {
        detail = fresh
        thread = fresh.thread
        approvals.ingest(fresh.approvals)
        if followTask == nil { cursor = max(cursor, fresh.thread.lastSeq) }
        // The server now lists the message that was pending.
        if let pendingText, sendState == .idle, fresh.messages.last(where: { $0.role == .user })?.text == pendingText {
            self.pendingText = nil
            pendingKey = nil
        }
    }

    // MARK: Sending

    /// Send the composer's text. One new `Idempotency-Key` per press.
    public func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty else { return }
        draft = ""
        pendingText = text
        pendingKey = .random()
        await deliver()
    }

    /// Try the kept message again — with the key of the press that made it.
    public func retrySend() async {
        guard case .failed = sendState, pendingText != nil, pendingKey != nil else { return }
        await deliver()
    }

    /// Give the kept message back to the composer instead of sending it.
    public func discardPending() {
        guard case .failed = sendState, let text = pendingText else { return }
        draft = draft.isEmpty ? text : text + "\n" + draft
        pendingText = nil
        pendingKey = nil
        sendState = .idle
    }

    private func deliver() async {
        guard let text = pendingText, let key = pendingKey else { return }
        sendState = .sending
        turnEnded = nil
        streamProblem = nil
        do {
            let start = try await service.startTurn(threadID: threadID, text: text, idempotencyKey: key)
            sendState = .idle
            switch start {
            case .started(let turnId):
                startFollowing(turn: turnId, replayTurn: false)
            case .replayed(let turnId, let status):
                // The server had already started this turn (an earlier attempt got through).
                if status == "running" {
                    startFollowing(turn: turnId, replayTurn: true)
                } else {
                    pendingText = nil
                    pendingKey = nil
                    await reload(showLoading: false)
                }
            case .alreadyRunning(let turnId):
                // Another turn is running: nothing was sent. Hand the text back and attach.
                draft = text
                pendingText = nil
                pendingKey = nil
                if followTask == nil { startFollowing(turn: turnId, replayTurn: true) }
            }
        } catch {
            guard let message = sink.describe(error) else {
                sendState = .idle
                return
            }
            if let e = error as? PrismError, case .rejected = e {
                // A definite refusal: nothing to retry.
                draft = text
                pendingText = nil
                pendingKey = nil
                sendState = .idle
                streamProblem = message
            } else if PlainLanguage.outcomeIsUnknown(error) {
                sendState = .failed(message: "It isn't clear whether your message arrived. Try again — it can't be sent twice.")
            } else {
                sendState = .failed(message: message)
            }
        }
    }

    // MARK: Stop

    /// Stop the running turn (⌘.). The stream then delivers the turn's `cancelled` result.
    public func stop() async {
        guard let turn = activeTurnID, !isStopping else { return }
        isStopping = true
        defer { isStopping = false }
        do {
            let answer = try await service.cancelTurn(turn)
            if answer.status != "cancelling" {
                // The turn had already ended.
                await reload(showLoading: false)
            }
        } catch {
            if let message = sink.describe(error) { streamProblem = "Couldn't stop it. \(message)" }
        }
    }

    // MARK: Following a turn

    private func stopFollowing() {
        followGeneration += 1
        followTask?.cancel()
        followTask = nil
        connection = .idle
    }

    /// - Parameter replayTurn: the turn started before this stream (the thread was opened
    ///   mid-turn, or a retried send was already running): read the stored events from the
    ///   start and show only this turn's.
    private func startFollowing(turn: String, replayTurn: Bool) {
        stopFollowing()
        activeTurnID = turn
        transcript = TurnTranscript()
        if replayTurn { cursor = 0 }
        let generation = followGeneration
        followTask = Task { [weak self] in
            await self?.follow(generation: generation)
        }
    }

    private func follow(generation: Int) async {
        var idleAttaches = 0
        attach: while !Task.isCancelled, generation == followGeneration {
            var sawResult = false
            var progressed = false
            do {
                for try await update in service.threadStream(threadID: threadID, after: cursor) {
                    guard generation == followGeneration else { return }
                    switch update {
                    case .connected:
                        connection = .live
                        streamProblem = nil
                    case .reconnecting:
                        connection = .reconnecting
                    case .event(let envelope):
                        if let seq = envelope.seq {
                            guard seq > cursor else { continue }
                            cursor = seq
                            progressed = true
                        }
                        if case .approval(let approval) = envelope.event { approvals.ingest([approval]) }
                        // Stored events of earlier turns are history, not this turn.
                        if replayedVoiceTurn != nil {
                            guard envelope.turnId == activeTurnID else { continue }
                        } else {
                            guard envelope.turnId == nil || envelope.turnId == activeTurnID else { continue }
                        }
                        transcript.apply(envelope)
                        if case .result = envelope.event { sawResult = true }
                    }
                }
            } catch {
                guard generation == followGeneration else { return }
                if error is CancellationError { return }
                if PlainLanguage.isNotFound(error) {
                    // The stream itself is a 404: read the thread once to learn whether it is gone.
                    followTask = nil
                    connection = .idle
                    activeTurnID = nil
                    await reload(showLoading: false)
                    return
                }
                if let message = sink.describe(error) { streamProblem = message }
                break attach
            }
            guard !Task.isCancelled, generation == followGeneration else { return }

            // The stream ended. Whether the turn did is the server's to say.
            let fresh: ThreadDetail
            do {
                fresh = try await service.thread(threadID)
            } catch {
                guard generation == followGeneration else { return }
                if PlainLanguage.isNotFound(error) {
                    followTask = nil
                    markUnavailable()
                    return
                }
                if let message = sink.describe(error) { streamProblem = message }
                break attach
            }
            guard generation == followGeneration else { return }

            if sawResult {
                finishTurn(with: fresh)
                guard let next = fresh.activeTurnId else { break attach }
                // Another turn started meanwhile (a revise, a queued message): follow it.
                activeTurnID = next
                idleAttaches = 0
                continue attach
            }
            guard let stillActive = fresh.activeTurnId else {
                // No result seen, and nothing runs any more: the stored thread is the truth.
                finishTurn(with: fresh)
                break attach
            }
            if stillActive != activeTurnID {
                activeTurnID = stillActive
                transcript = TurnTranscript()
            }
            apply(fresh)
            // Re-attach from the last event seen. Back off when an attach brought nothing.
            idleAttaches = progressed ? 0 : idleAttaches + 1
            if idleAttaches > 0 {
                connection = .reconnecting
                let delay = Duration.milliseconds(min(10_000, 500 * (1 << min(idleAttaches - 1, 5))))
                do { try await sleep(delay) } catch { return }
            }
        }
        guard generation == followGeneration else { return }
        followTask = nil
        connection = .idle
    }

    /// A thread opened after its last turn failed shows only the person's message: the reason
    /// was said on the stream, while it ran. The stored events still hold it, so read the last
    /// few once and say it again ("The connection to the agent was lost before it finished.").
    /// Only for a thread the server marks as needing the person with no draft waiting — the
    /// mark a failed turn leaves — and once per state of the thread.
    private func readWhyTheLastTurnFailed(_ fresh: ThreadDetail) async {
        let lastSeq = fresh.thread.lastSeq
        guard turnEnded == nil, fresh.thread.state == .needsYou, lastSeq > 0, outcomeReadAtSeq != lastSeq,
              !fresh.approvals.contains(where: \.isPending) else { return }
        outcomeReadAtSeq = lastSeq
        var last: (ok: Bool, code: String?)?
        do {
            for try await update in service.threadStream(threadID: threadID, after: max(0, lastSeq - 12)) {
                if case .reconnecting = update { break }
                if case .event(let envelope) = update, case .result(let ok, _, let code) = envelope.event { last = (ok, code) }
            }
        } catch {
            return // Not worth a message of its own: the thread itself loaded.
        }
        // Something started meanwhile: its own stream says what happens.
        guard followTask == nil, activeTurnID == nil, turnEnded == nil, let last, !last.ok, last.code != "cancelled" else { return }
        turnEnded = PlainLanguage.turnFailure(last.code)
    }

    private func finishTurn(with fresh: ThreadDetail) {
        if let result = transcript.result, !result.ok {
            turnEnded = PlainLanguage.turnFailure(result.errorCode)
        } else {
            turnEnded = nil
        }
        if activeTurnID == replayedVoiceTurn, replayedVoiceTurn != nil {
            completedVoiceTimeline = timeline.filter { if case .streamingText = $0 { return true }; return false }
            replayedVoiceTurn = nil
        }
        // History now holds what the stream showed; keeping both would show it twice.
        transcript = TurnTranscript()
        activeTurnID = nil
        pendingText = nil
        pendingKey = nil
        sendState = .idle
        apply(fresh)
        cursor = max(cursor, fresh.thread.lastSeq)
    }
}

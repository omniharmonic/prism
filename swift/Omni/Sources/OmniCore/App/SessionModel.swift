import Foundation
import Observation
import OmniClient
import PrismTransport

/// How a screen's data is doing.
public enum LoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)

    public var failure: String? {
        if case .failed(let m) = self { return m }
        return nil
    }
}

/// Turns an error into words, and routes the signed-out signal to the app.
@MainActor
public struct ErrorSink {
    let onSignedOut: @MainActor () -> Void

    public init(onSignedOut: @escaping @MainActor () -> Void) {
        self.onSignedOut = onSignedOut
    }

    /// The message to show, or nil when there is nothing to show (signed out — the app is
    /// already going back to sign-in — or the work was cancelled).
    ///
    /// - Parameter reading: the call only read something. An unclear answer to a read is
    ///   not "it may or may not have gone through": nothing was changed, so it says to try again.
    public func describe(_ error: any Error, reading: Bool = false) -> String? {
        if PlainLanguage.isSignedOut(error) {
            onSignedOut()
            return nil
        }
        if error is CancellationError { return nil }
        return reading ? PlainLanguage.readMessage(for: error) : PlainLanguage.message(for: error)
    }
}

/// Where the main window is. The Mac sidebar and the iPhone tabs both drive this.
public enum Destination: Hashable, Sendable {
    case today
    /// Approvals waiting for a decision (nudges join this queue in M3).
    case needsYou
    case thread(String)
    /// The empty composer for a new thread (⌘N).
    case newThread
    /// Recurring jobs.
    case recurring
}

/// Everything a signed-in session shows. One per sign-in; thrown away on sign-out.
@MainActor
@Observable
public final class SessionModel {
    public let threads: ThreadListModel
    public let approvals: ApprovalCenter
    public let nudges: NudgeCenter?
    public let today: TodayModel
    public let jobs: JobsModel
    public let skills: SkillsModel?

    /// The selected destination (the Mac sidebar's selection).
    public var destination: Destination? = .today
    /// Bumped by ⌘F; the list's search field focuses when it changes.
    public private(set) var searchRequests = 0
    /// Bumped by ⌘N on platforms that present the new-thread composer as a sheet.
    public private(set) var newThreadRequests = 0
    public private(set) var newThreadUsesVoice = false
    public private(set) var voiceThreadID: String?
    private var voiceGeneration = 0
    public var conversationAudio: (any ConversationAudio)?
    public var conversationVoice: VoiceConversation?

    public func requestNewVoice() {
        voiceGeneration += 1
        conversationVoice?.cancel()
        voiceThreadID = nil
        newThreadUsesVoice = true
        destination = .newThread
        newThreadRequests += 1
    }
    public func closeNewVoice() { voiceGeneration += 1; conversationVoice?.cancel(); newThreadUsesVoice = false }
    public func claimVoice(audio: any ConversationAudio, voice: VoiceConversation, threadID: String?) {
        voiceGeneration += 1
        if conversationVoice !== voice { conversationVoice?.cancel() }
        conversationAudio = audio; conversationVoice = voice; voiceThreadID = threadID
    }
    public var voiceLease: Int { voiceGeneration }
    public func ownsVoice(_ voice: VoiceConversation, threadID: String?) -> Bool {
        conversationVoice === voice && (threadID.map { voiceThreadID == $0 } ?? (newThreadUsesVoice && voiceThreadID == nil))
    }
    @discardableResult public func cancelVoice(_ voice: VoiceConversation, threadID: String?) -> Bool {
        guard ownsVoice(voice, threadID: threadID) else { return false }
        voiceGeneration += 1; voice.cancel(); return true
    }
    public func showVoice(in threadID: String) {
        if voiceThreadID != threadID { voiceGeneration += 1; conversationVoice?.cancel() }
        voiceThreadID = threadID
    }

    public private(set) var externalNavigationRequests = 0
    public func openExternal(_ destination: Destination) {
        self.destination = destination
        externalNavigationRequests += 1
    }

    private let service: any OmniService
    private let sink: ErrorSink
    private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var threadModels: [String: ThreadModel] = [:]
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    public init(
        service: any OmniService,
        confirmation: any SendConfirmation = NoSendConfirmation(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        onSignedOut: @escaping @MainActor () -> Void
    ) {
        self.service = service
        self.sleep = sleep
        let sink = ErrorSink(onSignedOut: onSignedOut)
        self.sink = sink
        self.threads = ThreadListModel(service: service, sink: sink)
        self.approvals = ApprovalCenter(service: service, sink: sink, confirmation: confirmation)
        self.nudges = (service as? any NudgeService).map { NudgeCenter(service: $0, sink: sink) }
        self.today = TodayModel(service: service, sink: sink, approvals: approvals)
        self.jobs = JobsModel(service: service, sink: sink)
        self.skills = (service as? any SkillService).map { SkillsModel(service: $0, sink: sink) }
        approvals.threadDidChange = { [weak self] threadID in
            guard let self else { return }
            await self.threads.refresh()
            if let model = self.threadModels[threadID], model.isOpen { await model.changedOnServer() }
        }
    }

    /// Start following the owner-wide change channel.
    public func start() {
        guard noticeTask == nil else { return }
        noticeTask = Task { [weak self] in await self?.followNotices() }
    }

    public func stop() {
        voiceGeneration += 1
        conversationVoice?.cancel(); conversationVoice = nil; conversationAudio = nil
        voiceThreadID = nil; newThreadUsesVoice = false
        noticeTask?.cancel()
        noticeTask = nil
        for model in threadModels.values { model.close() }
        threadModels.removeAll()
    }

    /// The model for one thread (kept while it is open, so a draft survives navigation).
    public func threadModel(for id: String) -> ThreadModel {
        if let existing = threadModels[id] { return existing }
        if threadModels.count >= 12 {
            for (key, model) in threadModels where !model.isOpen && model.draft.isEmpty { threadModels[key] = nil }
        }
        let model = ThreadModel(threadID: id, service: service, approvals: approvals, sink: sink, sleep: sleep) { [weak self] id in
            self?.threads.markGone(id)
        }
        threadModels[id] = model
        return model
    }

    /// A thread came on screen. One the list already knows is gone is not asked for again.
    public func openThread(_ model: ThreadModel) async {
        await model.open(knownGone: threads.thread(model.threadID)?.gone ?? false)
    }

    /// Take a thread out of the list and leave it (the way out of one that is no longer
    /// available). Returns true when it is gone from the list.
    @discardableResult
    public func removeThread(_ id: String) async -> Bool {
        guard await threads.remove(id) else { return false }
        threadModels[id]?.close()
        threadModels[id] = nil
        if destination == .thread(id) { destination = .today }
        return true
    }

    /// ⌘R and the Refresh buttons: read again everything the window shows right now.
    public func refreshVisible() async {
        await threads.refresh()
        await approvals.refresh()
        switch destination {
        case .today, nil: await today.refresh()
        case .recurring: await jobs.refresh()
        case .thread(let id): await threadModels[id]?.reload()
        case .needsYou, .newThread: break
        }
    }

    /// Create a thread from the new-thread composer and open it.
    @discardableResult
    public func startThread(prompt: String) async -> Bool {
        guard let created = await threads.create(prompt: prompt) else { return false }
        newThreadUsesVoice = false
        destination = .thread(created.thread.id)
        return true
    }

    /// A late creation still appears in the list, but cannot navigate or adopt a newer voice session.
    @discardableResult public func startVoiceThread(prompt: String, voice: VoiceConversation) async -> Bool {
        guard ownsVoice(voice, threadID: nil) else { return false }
        let request = voiceGeneration
        guard let created = await threads.create(prompt: prompt, source: "voice") else { return false }
        guard request == voiceGeneration, ownsVoice(voice, threadID: nil) else { return false }
        if let turn = created.turnId { threadModel(for: created.thread.id).rememberCreatedVoiceTurn(turn) }
        voiceThreadID = created.thread.id; newThreadUsesVoice = false
        destination = .thread(created.thread.id)
        return true
    }

    public func requestNewThread() {
        conversationVoice?.cancel()
        voiceGeneration += 1
        newThreadUsesVoice = false
        destination = .newThread
        newThreadRequests += 1
    }

    public func requestSearch() {
        searchRequests += 1
    }

    /// ⌘. — stop the turn running in the thread on screen.
    public func stopCurrentTurn() async {
        guard case .thread(let id) = destination, let model = threadModels[id] else { return }
        await model.stop()
    }

    public var canStopCurrentTurn: Bool {
        guard case .thread(let id) = destination, let model = threadModels[id] else { return false }
        return model.isRunning
    }

    // MARK: Change channel

    private func followNotices() async {
        do {
            for try await update in service.notices() {
                switch update {
                case .connected:
                    // Notices are not replayed: after every (re)connect re-read what is shown.
                    await refreshEverything()
                case .notice(let notice):
                    await handle(notice)
                case .reconnecting:
                    break
                }
            }
        } catch {
            _ = sink.describe(error)
        }
    }

    func refreshEverything() async {
        await threads.refresh()
        await approvals.refresh()
        await nudges?.refresh()
        for model in threadModels.values where model.isOpen { await model.changedOnServer() }
        // Today lists approvals and what is in flight: keep it honest once it has been shown.
        if today.hasContent, destination == .today || destination == nil { await today.refresh() }
    }

    func handle(_ notice: OmniNotice) async {
        switch notice.type {
        case "thread":
            await threads.refresh()
            if let model = threadModels[notice.id], model.isOpen { await model.changedOnServer() }
            if today.hasContent, destination == .today || destination == nil { await today.refresh() }
        case "approval":
            await approvals.refresh()
            if let threadID = notice.threadId, let model = threadModels[threadID], model.isOpen { await model.changedOnServer() }
        case "card":
            if notice.op == "nudge" { await nudges?.refresh() }
            if let threadID = notice.threadId, let model = threadModels[threadID], model.isOpen { await model.changedOnServer() }
        default:
            break
        }
    }
}

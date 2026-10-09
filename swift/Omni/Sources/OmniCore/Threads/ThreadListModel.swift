import Foundation
import Observation
import OmniClient
import PrismTransport

/// One group of the thread list.
public struct ThreadSection: Identifiable, Equatable, Sendable {
    public let state: ThreadState
    public let title: String
    public let threads: [OmniThread]
    public var id: String { state.rawValue }
}

/// The thread list reads like a work queue: grouped by state, in the product spec's order
/// and words (product-spec.md § 8c).
public enum ThreadGrouping {
    public static let order: [ThreadState] = [.needsYou, .working, .waiting, .scheduled, .done]

    public static func title(for state: ThreadState) -> String {
        switch state {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .scheduled: return "Scheduled"
        case .done: return "Done"
        default:
            // A state a newer server added: show its own word rather than hiding the thread.
            let words = state.rawValue.replacingOccurrences(of: "-", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    /// Sections in the spec's order, then any unknown state; empty groups are left out.
    /// Inside a group the server's order is kept (pinned first, then newest).
    public static func sections(_ threads: [OmniThread]) -> [ThreadSection] {
        var byState: [ThreadState: [OmniThread]] = [:]
        var unknown: [ThreadState] = []
        for thread in threads where !thread.archived {
            if byState[thread.state] == nil, !order.contains(thread.state) { unknown.append(thread.state) }
            byState[thread.state, default: []].append(thread)
        }
        return (order + unknown).compactMap { state in
            guard let group = byState[state], !group.isEmpty else { return nil }
            return ThreadSection(state: state, title: title(for: state), threads: group)
        }
    }

    public static func displayTitle(_ thread: OmniThread) -> String {
        if let title = thread.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines), !preview.isEmpty {
            return String(preview.prefix(60))
        }
        return "Untitled thread"
    }

    /// The small line under a title: what it is waiting on, else the latest text.
    public static func subtitle(_ thread: OmniThread) -> String? {
        if thread.state == .waiting, let on = thread.waitingOn, !on.isEmpty { return "on \(on)" }
        guard let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines), !preview.isEmpty else { return nil }
        return preview == displayTitle(thread) ? nil : preview
    }
}

@MainActor
@Observable
public final class ThreadListModel {
    public private(set) var threads: [OmniThread] = []
    public private(set) var phase: LoadPhase = .idle
    /// The server is up but cannot reach the agent: the list shows what the server knows.
    public private(set) var agentUnavailable = false
    /// What the search field holds. Call ``refresh()`` after changing it.
    public var searchText = ""
    public private(set) var isCreating = false
    public private(set) var createError: String?

    private let service: any OmniService
    private let sink: ErrorSink
    private var isRefreshing = false
    private var refreshAgain = false

    public init(service: any OmniService, sink: ErrorSink) {
        self.service = service
        self.sink = sink
    }

    public var sections: [ThreadSection] { ThreadGrouping.sections(threads) }
    public var unreadCount: Int { threads.reduce(0) { $0 + ($1.unread > 0 ? 1 : 0) } }
    public var isSearching: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var isEmpty: Bool { phase == .loaded && threads.isEmpty }

    public func thread(_ id: String) -> OmniThread? { threads.first { $0.id == id } }

    /// Read the list (pull-to-refresh, a notice, a changed search). Calls made while one
    /// is running are folded into a single follow-up read.
    public func refresh() async {
        if isRefreshing {
            refreshAgain = true
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshAgain = false
            await load()
        } while refreshAgain
    }

    private func load() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if threads.isEmpty { phase = .loading }
        do {
            let list = try await service.threads(states: [], search: query.isEmpty ? nil : query, includeArchived: false)
            // The field changed while this was in flight: the answer is for an old question.
            guard query == searchText.trimmingCharacters(in: .whitespacesAndNewlines) else {
                refreshAgain = true
                return
            }
            threads = list.threads
            agentUnavailable = !list.hermesAvailable
            phase = .loaded
        } catch {
            guard let message = sink.describe(error) else { return }
            phase = .failed(message)
        }
    }

    /// Start a new thread from a typed request. Returns nil when it could not be confirmed.
    public func create(prompt: String) async -> CreatedThread? {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isCreating else { return nil }
        isCreating = true
        createError = nil
        defer { isCreating = false }
        do {
            let created = try await service.createThread(NewThread(prompt: text, source: "text"))
            threads.removeAll { $0.id == created.thread.id }
            threads.insert(created.thread, at: 0)
            if phase != .loaded { phase = .loaded }
            return created
        } catch {
            guard let message = sink.describe(error) else { return nil }
            if PlainLanguage.outcomeIsUnknown(error) {
                // Creating a thread is not idempotent: look before trying again.
                await refresh()
                createError = "It isn't clear whether the thread was created. Check the list before sending it again."
            } else {
                createError = message
            }
            return nil
        }
    }

    public func clearCreateError() {
        createError = nil
    }
}
